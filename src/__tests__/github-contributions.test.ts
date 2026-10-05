import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { checkContributions, needsAttention, summariseContributions } from '../core/github.js';
import { today } from '../util.js';

/**
 * Guards the one number the system could never see: what GitHub RECORDED, as
 * opposed to what the ledger committed. On 08-06/08-07 ~98 commits were pushed
 * while GitHub counted 52 then 46, and nothing reported the gap.
 *
 * `gh` is faked throughout. These tests must never reach the network — a real
 * call would make them depend on the day's actual contribution count.
 */
vi.mock('execa');

/** Shape of a real `gh api graphql` reply, trimmed to the fields we read. */
function ghReply(opts: { count: number; date?: string; login?: string; restricted?: number }) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      data: {
        viewer: {
          login: opts.login ?? 'shan3520',
          contributionsCollection: {
            restrictedContributionsCount: opts.restricted ?? 0,
            contributionCalendar: {
              weeks: [{ contributionDays: [{ date: opts.date ?? today(), contributionCount: opts.count }] }],
            },
          },
        },
      },
    }),
    stderr: '',
  };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  // The token path must not be reachable by accident; it uses fetch, not execa,
  // and would escape the mock straight onto the network.
  delete process.env.GH_TOKEN;
  delete process.env.GH_USER;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('checkContributions', () => {
  it('reports agreement when GitHub recorded exactly what the ledger committed', async () => {
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 12 }) as never);

    const check = await checkContributions(12);

    expect(check.verdict).toBe('agree');
    expect(check.snapshot.recorded).toBe(12);
    expect(check.snapshot.source).toBe('gh');
    expect(check.notes).toEqual([]);
  });

  it('names the likely causes when GitHub recorded fewer than the ledger committed', async () => {
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 46 }) as never);

    const check = await checkContributions(98);

    expect(check.verdict).toBe('github-lower');
    const all = check.notes.join('\n');
    expect(all).toContain('never pushed');
    // The 34-commit rewrite was caused by exactly this and nothing said so.
    expect(all).toContain('git config user.email');
    expect(all).toContain('fork');
  });

  it('does not call a surplus on GitHub a failure', async () => {
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 20 }) as never);

    const check = await checkContributions(12);

    expect(check.verdict).toBe('github-higher');
    expect(check.notes.join('\n')).toContain('outside ShanAuto');
  });

  it('explains private repos instead of reporting them as a discrepancy', async () => {
    // Both configured repos are private, so every contribution is "restricted".
    // Counting agrees; only the PUBLIC profile can disagree, and for a reason
    // that is a settings toggle rather than a bug.
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 12, restricted: 12 }) as never);

    const check = await checkContributions(12);

    expect(check.verdict).toBe('agree');
    expect(check.notes.join('\n')).toContain('Include private contributions on my profile');
  });

  it('asks GitHub only for the local day, and matches GitHub\'s own date label', async () => {
    // GitHub labels each calendar day itself; the window can straddle two of
    // them, so the neighbouring day's count must never be read as today's.
    const yesterday = '2000-01-01';
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        data: {
          viewer: {
            login: 'shan3520',
            contributionsCollection: {
              restrictedContributionsCount: 0,
              contributionCalendar: {
                weeks: [
                  {
                    contributionDays: [
                      { date: yesterday, contributionCount: 77 },
                      { date: today(), contributionCount: 3 },
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
    } as never);

    const check = await checkContributions(3);

    expect(check.snapshot.recorded).toBe(3);
    expect(check.verdict).toBe('agree');
  });

  it('skips rather than fails when gh is not installed', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('spawn gh ENOENT'));

    const check = await checkContributions(12);

    expect(check.verdict).toBe('unverified');
    expect(check.snapshot.recorded).toBeNull();
    expect(check.snapshot.skipped).toContain('gh');
  });

  it('skips rather than fails when gh is installed but not logged in', async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 4,
      stdout: '',
      stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n',
    } as never);

    const check = await checkContributions(12);

    expect(check.verdict).toBe('unverified');
    expect(check.snapshot.skipped).toContain('gh auth login');
  });

  it('skips rather than fails when GitHub answers with GraphQL errors', async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({ errors: [{ message: 'Bad credentials' }] }),
    } as never);

    const check = await checkContributions(12);

    expect(check.verdict).toBe('unverified');
    expect(check.snapshot.skipped).toContain('Bad credentials');
  });

  it('skips rather than throwing when gh emits something that is not JSON', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: 'not json at all', stderr: '' } as never);

    const check = await checkContributions(12);

    expect(check.verdict).toBe('unverified');
  });

  it('warns when the credential belongs to a different account than GH_USER', async () => {
    process.env.GH_USER = 'someone-else';
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 12, login: 'shan3520' }) as never);

    const check = await checkContributions(12);

    expect(check.notes.join('\n')).toContain('someone-else');
    expect(check.notes.join('\n')).toContain('shan3520');
  });

  it('kills a hung gh instead of hanging the report', async () => {
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 1 }) as never);
    await checkContributions(1);

    // Every subprocess in this codebase must be non-interactive and bounded;
    // a report that blocks forever is worse than one that says "unverified".
    const [, , opts] = vi.mocked(execa).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(opts.stdin).toBe('ignore');
    expect(opts.killSignal).toBe('SIGKILL');
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.reject).toBe(false);
  });

  it('never puts a token on the gh command line', async () => {
    process.env.GH_TOKEN = 'ghp_secret_value_that_must_not_leak';
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 1 }) as never);

    const check = await checkContributions(1);

    const [bin, args] = vi.mocked(execa).mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('gh');
    expect(args.join(' ')).not.toContain('ghp_secret');
    expect(JSON.stringify(check)).not.toContain('ghp_secret');
  });
});

describe('summariseContributions', () => {
  it('says plainly that the two numbers disagree when work went missing', async () => {
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 46 }) as never);

    const line = summariseContributions(await checkContributions(98));

    expect(line).toContain('98');
    expect(line).toContain('46');
    expect(line).toContain('DISAGREE');
    expect(needsAttention(await checkContributions(98))).toBe(true);
  });

  /*
   * The other direction is not a fault and must not read like one.
   *
   * Measured 2026-08-30: ledger 6, GitHub 8, every commit verified present on
   * origin/main with nothing unpushed. The run had done its job and signed off
   * with "they DISAGREE" in capitals, about the one thing this system exists to
   * do. GitHub counts issues, reviews and anything done by hand, so it is
   * higher on any day the owner touched their own work.
   */
  it('does not cry wolf when GitHub counted more than we committed', async () => {
    vi.mocked(execa).mockResolvedValue(ghReply({ count: 8 }) as never);

    const check = await checkContributions(6);
    const line = summariseContributions(check);

    expect(line).toContain('6');
    expect(line).toContain('8');
    expect(line).not.toContain('DISAGREE');
    expect(line).toContain('every commit arrived');
    expect(needsAttention(check)).toBe(false);
  });

  it('reports the skip reason when verification was unavailable', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('spawn gh ENOENT'));

    expect(summariseContributions(await checkContributions(5))).toContain('unavailable');
  });
});
