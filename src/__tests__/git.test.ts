import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  commitMessage,
  CO_AUTHOR,
  commitAndPush,
  rollback,
  ensureClean,
  diffStat,
  listFiles,
} from '../git.js';
import { simpleGit } from 'simple-git';
import { rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('simple-git');
vi.mock('../logger.js');
vi.mock('node:fs');

describe('git', () => {
  describe('commitMessage', () => {
    it('formats a commit message correctly', () => {
      const message = commitMessage('feature', 'Implement test suite', 'Adds tests for git.ts');
      expect(message).toBe('feat: Implement test suite\n\nAdds tests for git.ts\n');
    });

    /*
     * A declared contract change, in the one place that leaves this machine.
     *
     * The run report is a file on this disk and the ledger is a database on
     * this disk. The commit is on the operator's GitHub, which is where anyone
     * who was calling the changed thing will actually be looking.
     */
    it('marks a declared contract change the way the convention does', () => {
      const message = commitMessage(
        'feature',
        'Return frequent queries in an envelope',
        'the endpoint returns an object with a data key',
        'callers that index the response break',
      );
      expect(message).toContain('feat!: Return frequent queries in an envelope');
      expect(message).toContain('BREAKING CHANGE: callers that index the response break');
    });

    it('leaves an ordinary commit exactly as it was', () => {
      const message = commitMessage('bugfix', 'Handle the empty case', 'it returns 0');
      expect(message).toBe('fix: Handle the empty case\n\nit returns 0\n');
      expect(message).not.toContain('!');
      expect(message).not.toContain('BREAKING');
    });

    it('does not mark a commit for a declaration that says nothing', () => {
      expect(commitMessage('feature', 'Add a counter', 'it counts', '')).not.toContain('feat!');
    });

    /*
     * git reads trailers out of the LAST paragraph only. A `Co-authored-by:`
     * line pressed up against the acceptance prose is just prose, and GitHub
     * credits nobody - so the blank line before it is the whole feature.
     */
    it('credits ShanAuto in its own trailer block', () => {
      const message = commitMessage('feature', 'Add a counter', 'it counts', undefined, true);
      expect(message).toBe(
        [
          'feat: Add a counter',
          '',
          'it counts',
          '',
          'Co-authored-by: shanauto <noreply@shanauto.invalid>',
          '',
        ].join('\n'),
      );
      const paragraphs = message.trimEnd().split('\n\n');
      expect(paragraphs.at(-1)).toBe(CO_AUTHOR);
    });

    /*
     * The agent is an interchangeable worker the router picked, and naming it
     * would date the history the moment the roster changes. Only the machine
     * that planned, gated and committed the work is named.
     */
    it('never names the agent that took the job', () => {
      const message = commitMessage('feature', 'Add a counter', 'it counts', undefined, true);
      for (const agent of ['opencode', 'agy', 'copilot', 'antigravity']) {
        expect(message).not.toContain(agent);
      }
    });

    it('keeps the breaking-change footer and the co-author in one trailer block', () => {
      const message = commitMessage(
        'feature',
        'Return frequent queries in an envelope',
        'the endpoint returns an object with a data key',
        'callers that index the response break',
        true,
      );
      const paragraphs = message.trimEnd().split('\n\n');
      expect(paragraphs.at(-1)).toBe(
        ['BREAKING CHANGE: callers that index the response break', CO_AUTHOR].join('\n'),
      );
    });

    /*
     * A human finishing a handed-off task wrote that diff by hand; the
     * orchestrator only committed it. Omitting the argument has to stay silent.
     */
    it('names no co-author when a human did the work', () => {
      expect(commitMessage('bugfix', 'Handle the empty case', 'it returns 0')).not.toContain(
        'Co-authored-by',
      );
    });

    /*
     * The ONE thing this address must never do is resolve. GitHub maps
     * `<name>@users.noreply.github.com` onto the user called `name`, which
     * would credit a stranger who owns that account; `.invalid` is reserved by
     * RFC 2606 so that it cannot.
     */
    it('cannot credit a real GitHub account', () => {
      expect(CO_AUTHOR).toBe('Co-authored-by: shanauto <noreply@shanauto.invalid>');
      expect(CO_AUTHOR).not.toContain('users.noreply.github.com');
      expect(CO_AUTHOR).toMatch(/<[^>]+@[^>]*\.invalid>$/);
    });

    /*
     * The marker has to survive the 72-char clamp. Putting it outside would
     * make a long title silently drop the one character that carries the
     * meaning, and a long title is exactly what a big change tends to have.
     */
    it('keeps the marker on a title long enough to be clamped', () => {
      const message = commitMessage(
        'refactor',
        'Move every saved search endpoint behind the new envelope response format used elsewhere',
        'the endpoints return envelopes',
        'the bare-list responses are gone',
      );
      const subject = message.split('\n')[0]!;
      expect(subject.length).toBeLessThanOrEqual(72);
      expect(subject.startsWith('refactor!: ')).toBe(true);
    });
  });

  describe('commitAndPush', () => {
    let mockGit: any;

    beforeEach(() => {
      mockGit = {
        add: vi.fn().mockResolvedValue(undefined),
        diff: vi.fn().mockResolvedValue('file1.txt\n'),
        commit: vi.fn().mockResolvedValue({ commit: 'abc123sha' }),
        push: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit);
    });

    it('throws error if paths array is empty', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await expect(commitAndPush(repo, 'msg', [])).rejects.toThrow('Refusing to commit: no paths supplied');
      expect(mockGit.add).not.toHaveBeenCalled();
    });

    it('throws error if nothing is staged', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      mockGit.diff.mockResolvedValue('');
      await expect(commitAndPush(repo, 'msg', ['file1.txt'])).rejects.toThrow('Refusing to commit: nothing staged');
      expect(mockGit.add).toHaveBeenCalledWith(['file1.txt']);
      expect(mockGit.commit).not.toHaveBeenCalled();
    });

    it('throws error if commit produces no SHA', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      mockGit.commit.mockResolvedValue({ commit: '' });
      await expect(commitAndPush(repo, 'msg', ['file1.txt'])).rejects.toThrow('Commit produced no SHA (nothing staged?)');
    });

    it('returns commit SHA and pushed=true when the push succeeds', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const { sha, pushed } = await commitAndPush(repo, 'my commit', ['file1.txt', 'file2.txt']);

      expect(sha).toBe('abc123sha');
      expect(pushed).toBe(true);
      expect(mockGit.add).toHaveBeenCalledWith(['file1.txt', 'file2.txt']);
      expect(mockGit.diff).toHaveBeenCalledWith(['--cached', '--name-only']);
      // The pathspec is the guarantee: the commit contains exactly what the gate
      // inspected. Committing the index instead let diffStat's `git add -A`
      // smuggle in deletions the gate never saw — measured at four files landing
      // when one was authorised.
      expect(mockGit.commit).toHaveBeenCalledWith('my commit', ['file1.txt', 'file2.txt']);
      expect(mockGit.push).toHaveBeenCalledWith('origin', 'main');
    });

    it('returns the SHA with pushed=false when the push fails, not a silent success', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      mockGit.push.mockRejectedValue(new Error('Push failed'));

      const { sha, pushed } = await commitAndPush(repo, 'my commit', ['file1.txt']);
      expect(sha).toBe('abc123sha');
      expect(pushed).toBe(false);
      expect(mockGit.push).toHaveBeenCalled();
    });
  });

  describe('rollback', () => {
    let mockGit: any;

    beforeEach(() => {
      mockGit = {
        raw: vi.fn().mockResolvedValue('tracked.txt\n'),
        checkout: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue(undefined),
        diffSummary: vi.fn().mockResolvedValue({ files: [], insertions: 0, deletions: 0 }),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit);
      vi.mocked(rmSync).mockClear();
      vi.mocked(copyFileSync).mockClear();
      // No stale git lock unless a test says so; the lock check runs first and
      // abandons the rollback entirely when one is held.
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it('does nothing if no files to rollback', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await rollback(repo, []);
      // diffStat still runs (an empty array means "work it out"), but nothing
      // is stashed, reverted or removed.
      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(['stash']));
      expect(mockGit.checkout).not.toHaveBeenCalled();
    });

    /*
     * O24. Every entry in example-api's pile of 38 was `shanauto-rollback
     * <timestamp>` and nothing else, so "restore the newest" was a coin toss
     * over which rejected task you got back. One of them was run 21's real fix
     * for the global-slice bug, found again only by reading diffs.
     */
    it('puts the task and the reason in the stash message', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await rollback(repo, ['a.txt'], 'T4uxha4ldlc Implement the add command');

      const push = mockGit.raw.mock.calls.find((c: unknown[][]) =>
        Array.isArray(c[0]) && (c[0] as string[]).includes('stash'),
      );
      const message = (push?.[0] as string[]).join(' ');
      expect(message).toContain('shanauto-rollback');
      expect(message).toContain('T4uxha4ldlc');
      expect(message).toContain('Implement the add command');
    });

    it('keeps the message to one line, whatever it is handed', async () => {
      // A stash subject is one line and a gate detail can run to paragraphs.
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await rollback(repo, ['a.txt'], `T1 broke

${'x'.repeat(400)}`);

      const push = mockGit.raw.mock.calls.find((c: unknown[][]) =>
        Array.isArray(c[0]) && (c[0] as string[]).includes('stash'),
      );
      const label = (push?.[0] as string[]).find((a) => a.startsWith('shanauto-rollback')) ?? '';
      expect(label).not.toContain('\n');
      expect(label.length).toBeLessThan(160);
    });

    it('still labels a rollback nobody gave a reason for', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await rollback(repo, ['a.txt']);

      const push = mockGit.raw.mock.calls.find((c: unknown[][]) =>
        Array.isArray(c[0]) && (c[0] as string[]).includes('stash'),
      );
      const label = (push?.[0] as string[]).find((a) => a.startsWith('shanauto-rollback')) ?? '';
      expect(label).toMatch(/^shanauto-rollback \S+$/);
    });

    it('stashes the paths instead of destroying them', async () => {
      // It cannot tell the agent's work from the owner's — a task runs for up to
      // 15 minutes, and diffStat reports anything written in that window as the
      // agent's. So it must stop being able to lose it: a stash reverts the tree
      // AND keeps a copy.
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      mockGit.raw.mockResolvedValue('stashed 2 files');

      await rollback(repo, ['tracked.txt', 'untracked.txt']);

      expect(mockGit.raw).toHaveBeenCalledWith(
        expect.arrayContaining(['stash', 'push', '-u', 'tracked.txt', 'untracked.txt']),
      );
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('falls back to the destructive path only when stashing fails', async () => {
      // Leaving the agent's work in the tree would break the next task, so the
      // old behaviour survives as a last resort — and now warns that it can lose
      // an owner's concurrent edit.
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      // `reset` runs before `stash`; only the stash itself fails here.
      mockGit.raw.mockImplementation(async (args: string[]) =>
        args[0] === 'stash' ? Promise.reject(new Error('no stash here')) : 'tracked.txt\n',
      );
      // The target file exists (so it is copied aside), but .git/index.lock
      // does not — a held lock abandons the rollback before any of this.
      // Exists ONLY for the untracked source itself: the SEC-9 quarantine
      // collision loop must see a free destination or it spins forever (this
      // mock used to return true for every non-lock path, including the tmpdir
      // quarantine, which sent that loop infinite).
      const untrackedSrc = join('/test', 'untracked.txt');
      vi.mocked(existsSync).mockImplementation((f) => String(f) === untrackedSrc);

      await rollback(repo, ['tracked.txt', 'untracked.txt']);

      // Copied aside BEFORE being removed: this path only runs when git could
      // not help, and an untracked file is the owner's until proven otherwise.
      expect(copyFileSync).toHaveBeenCalled();

      expect(mockGit.checkout).toHaveBeenCalledWith(['HEAD', '--', 'tracked.txt']);
      expect(rmSync).toHaveBeenCalledWith(join('/test', 'untracked.txt'), { force: true });
    });

    it('uses diffStat if paths are not provided', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      mockGit.diffSummary.mockResolvedValue({ files: [{ file: 'changed.txt' }] });
      mockGit.raw.mockResolvedValue('changed.txt\n');
      
      await rollback(repo);
      
      expect(mockGit.add).toHaveBeenCalledWith(['-A', '--intent-to-add', '.']);
      // Against HEAD, so a deletion is visible whether or not it has been staged.
      // The unstaged diff hid every deletion, because diffStat's own
      // `git add -A --intent-to-add` stages them for real.
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['HEAD', '--numstat']);
      expect(mockGit.raw).toHaveBeenCalledWith(expect.arrayContaining(['stash', 'push', 'changed.txt']));
    });
    
    it('catches and ignores checkout/rmSync errors', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      mockGit.raw.mockResolvedValue('tracked.txt\n');
      mockGit.checkout.mockRejectedValue(new Error('Checkout failed'));
      
      /*
       * Resolves rather than throws, which is the point of the test. It used to
       * assert `undefined` because rollback returned void; it now reports what
       * it did, so the assertion is that a failing checkout is still swallowed
       * and the caller still gets an answer.
       */
      await expect(rollback(repo, ['tracked.txt'])).resolves.toMatchObject({
        reverted: 1,
      });
    });
  });

  describe('diffStat', () => {
    let mockGit: any;

    beforeEach(() => {
      mockGit = {
        add: vi.fn().mockResolvedValue(undefined),
        // rev-parse --verify HEAD: an empty repo has no HEAD, and diffing
        // against it there is fatal.
        raw: vi.fn().mockResolvedValue('abc123'),
        // Per-file counts are now required: diffStat recomputes the totals from
        // them (§9.4), so a mock carrying only the summary totals would yield NaN.
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'file1.ts', insertions: 6, deletions: 2 },
            { file: 'file2.ts', insertions: 4, deletions: 3 },
          ],
          insertions: 10,
          deletions: 5,
        }),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit);
    });

    it('returns expected counts for staged files', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const stat = await diffStat(repo);

      expect(mockGit.add).toHaveBeenCalledWith(['-A', '--intent-to-add', '.']);
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['HEAD', '--numstat']);
      expect(stat).toEqual({
        files: ['file1.ts', 'file2.ts'],
        insertions: 10,
        deletions: 5,
        renames: 0,
      });
    });

    it('counts a rename as one entry while expanding it to both paths (F11)', async () => {
      // git reports a move as a single diff entry `old.ts => new.ts`. splitRename
      // expands it into both paths for the file list, but the rename count must
      // stay 1 so the TRIVIAL floor sees real work in a pure `git mv`.
      mockGit.diffSummary.mockResolvedValue({
        files: [
          { file: 'src/old.ts => src/new.ts', insertions: 0, deletions: 0 },
          { file: 'plain.ts', insertions: 0, deletions: 0 },
        ],
        insertions: 0,
        deletions: 0,
      });
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const stat = await diffStat(repo);

      expect(stat.files).toEqual(['src/old.ts', 'src/new.ts', 'plain.ts']);
      expect(stat.renames).toBe(1);
      expect(stat.insertions + stat.deletions + stat.renames).toBe(1);
    });

    it('restores the index to HEAD after measuring (SEC-8)', async () => {
      // diffStat's `git add -A --intent-to-add .` stages deletions for real and
      // records i-t-a entries for untracked files. Both would ride along into
      // an OWNER'S next `git add -A && git commit`; the finally resets the
      // index so the measurement has no side effects that outlive it.
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await diffStat(repo);
      expect(mockGit.raw).toHaveBeenCalledWith(['reset', '-q', '--', '.']);
    });

    it('restores the index even when the diff read fails', async () => {
      mockGit.diffSummary.mockRejectedValue(new Error('boom'));
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await expect(diffStat(repo)).rejects.toThrow('boom');
      expect(mockGit.raw).toHaveBeenCalledWith(['reset', '-q', '--', '.']);
    });

    it('empties the index on a repo with no commits (SEC-8)', async () => {
      // No HEAD yet: rev-parse fails, diffStat falls back to the empty tree,
      // and there is nothing to reset to — the index is emptied instead.
      mockGit.raw.mockRejectedValueOnce(new Error('fatal: no HEAD'));
      mockGit.diffSummary.mockResolvedValue({ files: [], insertions: 0, deletions: 0 });
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await diffStat(repo);
      expect(mockGit.raw).toHaveBeenCalledWith(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
    });

    it('excludes orchestrator .shanauto/ briefs from files and totals (§9.4)', async () => {
      // The handoff driver writes repo/.shanauto/handoff/<id>.md mid-task. It is
      // not the agent's work, so it must not reach the gate's file list, the
      // commit pathspec, or the insertion/deletion totals — git counts it as a
      // real addition otherwise.
      mockGit.diffSummary.mockResolvedValue({
        files: [
          { file: '.shanauto/handoff/t1.md', insertions: 3, deletions: 0 },
          { file: 'src/agent.ts', insertions: 12, deletions: 4 },
        ],
        insertions: 15,
        deletions: 4,
      });
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const stat = await diffStat(repo);

      expect(stat.files).toEqual(['src/agent.ts']);
      expect(stat.insertions).toBe(12);
      expect(stat.deletions).toBe(4);
      expect(stat.renames).toBe(0);
    });

    it('drops a rename whose destination is a .shanauto/ brief (§9.4)', async () => {
      // A rename entry names both sides; either may be a brief. A move INTO
      // .shanauto/ is orchestrator state churn, not the agent's work — neither
      // the source deletion nor the destination should count or scope anything.
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'src/x.ts => .shanauto/handoff/t2.md', insertions: 0, deletions: 0 }],
        insertions: 0,
        deletions: 0,
      });
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const stat = await diffStat(repo);

      expect(stat.files).toEqual([]);
      expect(stat.insertions).toBe(0);
      expect(stat.deletions).toBe(0);
      expect(stat.renames).toBe(0);
    });
  });

  describe('listFiles', () => {
    let mockGit: any;

    beforeEach(() => {
      mockGit = {
        raw: vi.fn().mockResolvedValue('file1.ts\nfile2.ts\n'),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit);
    });

    it('returns a list of tracked files', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const files = await listFiles(repo);
      
      expect(mockGit.raw).toHaveBeenCalledWith(['ls-files']);
      expect(files).toEqual(['file1.ts', 'file2.ts']);
    });

    it('filters out empty lines', async () => {
      mockGit.raw.mockResolvedValue('file1.ts\n\nfile2.ts\n');
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      const files = await listFiles(repo);
      
      expect(files).toEqual(['file1.ts', 'file2.ts']);
    });
  });

  describe('ensureClean', () => {
    let mockGit: any;

    beforeEach(() => {
      mockGit = {
        status: vi.fn().mockResolvedValue({ isClean: () => true, current: 'main', files: [] }),
        stash: vi.fn().mockResolvedValue(undefined),
        checkout: vi.fn().mockResolvedValue(undefined),
        pull: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1234567890));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not stash or checkout if repo is clean and on correct branch', async () => {
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      await ensureClean(repo);
      
      expect(mockGit.stash).not.toHaveBeenCalled();
      expect(mockGit.checkout).not.toHaveBeenCalled();
      expect(mockGit.pull).toHaveBeenCalledWith('origin', 'main', { '--rebase': 'true' });
    });

    it('stashes changes if repo is dirty', async () => {
      mockGit.status.mockResolvedValue({ isClean: () => false, current: 'main', files: [{ path: 'file1' }] });
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      
      await ensureClean(repo);
      
      expect(mockGit.stash).toHaveBeenCalledWith(['push', '-u', '-m', 'shanauto-autostash-1234567890']);
      expect(mockGit.checkout).not.toHaveBeenCalled();
      expect(mockGit.pull).toHaveBeenCalledWith('origin', 'main', { '--rebase': 'true' });
    });

    /*
     * The three ways tidying an empty autostash could destroy real work. Each
     * one needs git to answer in a way a real repo will not hold still for — a
     * failing inspection, another stash on top, the list moving between the
     * look and the drop — so they are driven through the mock rather than a
     * temp repo. The tidying itself is proven against real git in
     * data-safety.test.ts; these prove it gives up when it cannot be sure.
     */
    function dirtyWith(raw: (args: string[]) => Promise<string>) {
      mockGit.status.mockResolvedValue({ isClean: () => false, current: 'main', files: [{ path: 'f' }] });
      mockGit.raw = vi.fn((args: string[]) => raw(args));
      return mockGit;
    }
    const OURS = 'On main: shanauto-autostash-1234567890';
    const dropped = (g: any) =>
      g.raw.mock.calls.some((c: any[]) => c[0][0] === 'stash' && c[0][1] === 'drop');

    it('does not drop a stash it could not inspect', async () => {
      // Empty output means "git looked and found nothing". An inspection that
      // never happened produces the same empty string and means nothing at all.
      const g = dirtyWith(async (args) => {
        if (args[0] === 'log') return OURS;
        throw new Error('fatal: run_command failed');
      });

      await ensureClean({ id: 'test', path: '/test', branch: 'main' } as any);

      expect(dropped(g)).toBe(false);
    });

    it('does not drop a stash that is not the one it just made', async () => {
      /*
       * If our own stash push did nothing, the stash on top is someone else's.
       * The inspection is empty here on purpose: a stash holding content is
       * refused by the check below regardless of whose it is, so only an empty
       * one asks whether identity is checked at all. Not hypothetical — two of
       * example-api's stashes are empty, and either could be the top of that list.
       */
      const g = dirtyWith(async (args) =>
        args[0] === 'log' ? 'On main: my own half-finished work' : '',
      );

      await ensureClean({ id: 'test', path: '/test', branch: 'main' } as any);

      expect(dropped(g)).toBe(false);
    });

    it('does not drop a stash that arrived while it was looking', async () => {
      // `stash drop` takes a position, not an identity: stash@{0} is whatever
      // is on top at that instant, and something else may have pushed onto it.
      let logs = 0;
      const g = dirtyWith(async (args) => {
        if (args[0] === 'log') return ++logs === 1 ? OURS : 'On main: someone else, just now';
        return ''; // ours, and empty — everything short of the re-read says drop
      });

      await ensureClean({ id: 'test', path: '/test', branch: 'main' } as any);

      expect(logs).toBe(2);
      expect(dropped(g)).toBe(false);
    });

    it('drops the stash when every check agrees it holds nothing', async () => {
      const g = dirtyWith(async (args) => (args[0] === 'log' ? OURS : ''));

      await ensureClean({ id: 'test', path: '/test', branch: 'main' } as any);

      expect(dropped(g)).toBe(true);
    });

    it('checks out branch if current branch is different', async () => {
      mockGit.status.mockResolvedValue({ isClean: () => true, current: 'other', files: [] });
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      
      await ensureClean(repo);
      
      expect(mockGit.stash).not.toHaveBeenCalled();
      expect(mockGit.checkout).toHaveBeenCalledWith('main');
      expect(mockGit.pull).toHaveBeenCalledWith('origin', 'main', { '--rebase': 'true' });
    });

    it('catches and ignores pull errors', async () => {
      mockGit.pull.mockRejectedValue(new Error('Pull failed'));
      const repo = { id: 'test', path: '/test', branch: 'main' } as any;
      
      await expect(ensureClean(repo)).resolves.toBeUndefined();
      expect(mockGit.pull).toHaveBeenCalled();
    });
  });
});
