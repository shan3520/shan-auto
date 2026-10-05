import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedTask } from '../schemas.js';

/**
 * The previous version of this file asserted that writeWeeklyReport called
 * JSON.stringify — true, and worthless. The function took an untyped
 * `{[key: string]: any}` that nothing in the codebase ever built, so it could not
 * be called at all; mocking `writeFileSafe` meant the test never touched disk
 * either. It now reads the ledger itself, so this exercises real data.
 */
const dir = mkdtempSync(join(tmpdir(), 'sa-reporter-'));
process.env.SHANAUTO_DB = join(dir, 'test.db');

const ledger = await import('../ledger.js');
const {
  writeWeeklyReport,
  notify,
  denseDaily,
  problemsSection,
  staleFailuresSection,
  blockedNote,
  breakingNote,
  testsOnlyNote,
  agentOutNote,
  heldNote,
  stashNote,
  runwayCell,
} = await import('../core/reporter.js');
type Run = Parameters<typeof problemsSection>[0];

/** A run in which nothing at all happened; each test sets only what it is about. */
function emptyRun(over: Partial<Run> = {}): Run {
  return {
    attempted: 0, committed: 0, failed: 0, sentBack: 0, handoff: 0, dropped: 0, parked: 0,
    blocked: 0, blockedBy: [], blockedShipped: [], breakingShipped: [], testsOnlyShipped: [],
    agentsOut: [], problems: [], held: [], stashes: [],
    ...over,
  };
}

/*
 * Run 22 committed one test file under a title promising a behaviour change,
 * closed the milestone it belonged to, and reported an empty backlog. Three
 * separate ways of telling the operator their idea was done, over a bug that
 * was still in the code.
 */
describe('tests shipped and nothing else', () => {
  const shipped = (over = {}) => ({ id: 'T1', title: 'prove the impact query', predicted: null, ...over });

  it('says nothing when every commit changed something that runs', () => {
    expect(testsOnlyNote(emptyRun())).toEqual([]);
  });

  it('names the task, so the operator has somewhere to look', () => {
    const out = testsOnlyNote(emptyRun({ testsOnlyShipped: [shipped()] })).join('\n');

    expect(out).toContain('T1');
    expect(out).toContain('prove the impact query');
  });

  it('says what it means: nothing runs differently, and the milestone closed anyway', () => {
    const out = testsOnlyNote(emptyRun({ testsOnlyShipped: [shipped()] })).join('\n');

    expect(out).toMatch(/nothing this project does at runtime[\s\S]*different/i);
    expect(out).toMatch(/wrong file/i);
    expect(out).toMatch(/milestone closes/i);
  });

  it('withdraws a breaking change that was predicted and did not happen', () => {
    const out = testsOnlyNote(
      emptyRun({ testsOnlyShipped: [shipped({ predicted: 'callers that index the response break' })] }),
    ).join('\n');

    expect(out).toMatch(/no BREAKING CHANGE was recorded/i);
  });

  it('withdraws nothing when nothing was predicted', () => {
    const out = testsOnlyNote(emptyRun({ testsOnlyShipped: [shipped()] })).join('\n');

    expect(out).not.toMatch(/BREAKING CHANGE/i);
  });

  it('counts only the ones that carried a prediction', () => {
    const out = testsOnlyNote(
      emptyRun({
        testsOnlyShipped: [shipped(), shipped({ id: 'T2', predicted: 'the shape changes' })],
      }),
    ).join('\n');

    expect(out).toContain('**2 task(s) shipped tests and nothing else.**');
    expect(out).toMatch(/^> 1 of those were planned as a change/m);
  });
});

function task(title: string): NormalizedTask {
  return {
    title,
    kind: 'feature',
    instruction: 'do the thing',
    acceptance: 'done',
    files_hint: [],
    verify_cmd: 'echo ok',
    depends_on: [],
    est_lines: 10,
    executor_hint: 'cli',
  };
}

beforeAll(() => {
  ledger.open().exec('DELETE FROM tasks;');
  const ids = ledger.insertTasks(null, 'shanauto', [task('first'), task('second')]);
  ledger.markCommitted(ids[0]!, 'aaaaaaa');
  ledger.markCommitted(ids[1]!, 'bbbbbbb');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('writeWeeklyReport', () => {
  it('writes markdown, not a JSON dump', () => {
    const file = writeWeeklyReport();
    expect(file).toMatch(/weekly-\d{4}-\d{2}-\d{2}\.md$/);

    const md = readFileSync(file, 'utf8');
    expect(md).toContain('# ShanAuto');
    expect(() => JSON.parse(md)).toThrow(); // prose, not a data dump
  });

  it('reports the real commit count read from the ledger', () => {
    const md = readFileSync(writeWeeklyReport(), 'utf8');
    expect(md).toContain('**2 commit(s)');
  });

  it('renders the sparkline as a real svg element, not a bare path', () => {
    // generateSparklineSvg returns only "M … L …"; unwrapped that renders as nothing.
    const md = readFileSync(writeWeeklyReport(), 'utf8');
    if (md.includes('<svg')) {
      expect(md).toContain('</svg>');
      expect(md).toMatch(/<path d="M/);
    } else {
      expect(md).toContain('not enough history');
    }
  });

  it('includes the backlog breakdown', () => {
    const md = readFileSync(writeWeeklyReport(), 'utf8');
    expect(md).toContain('| backlog | count |');
    expect(md).toContain('committed');
  });
});

/*
 * The report is the only thing the operator reads, and until now none of its
 * body was tested — which is how three separate misleading-number defects
 * shipped and survived two days of reports. Each test below names the report
 * that got it wrong.
 */
describe('denseDaily: the trend has to be able to show a bad day', () => {
  it('turns a missing day into a zero rather than dropping it', () => {
    const rows = [
      { date: '2026-08-09', count: 4 },
      { date: '2026-08-12', count: 2 },
    ];
    const out = denseDaily(rows, 5, '2026-08-13');
    expect(out).toEqual([
      { date: '2026-08-09', count: 4 },
      { date: '2026-08-10', count: 0 },
      { date: '2026-08-11', count: 0 },
      { date: '2026-08-12', count: 2 },
      { date: '2026-08-13', count: 0 },
    ]);
  });

  it('draws a different line the day after a zero-commit day', () => {
    // The actual bug: 2026-08-12 and 2026-08-13 shipped byte-identical
    // sparkline paths, because a day with no commits produced no row and so
    // could not move the graph. A trend that cannot fall is not a trend.
    const rows = [{ date: '2026-08-12', count: 2 }];
    const on12 = denseDaily(rows, 7, '2026-08-12');
    const on13 = denseDaily(rows, 7, '2026-08-13');
    expect(on13).not.toEqual(on12);
    expect(on13.at(-1)).toEqual({ date: '2026-08-13', count: 0 });
  });

  it('always returns exactly the window asked for', () => {
    expect(denseDaily([], 14, '2026-08-13')).toHaveLength(14);
    expect(denseDaily([{ date: '2026-08-13', count: 9 }], 3, '2026-08-13')).toHaveLength(3);
  });

  it('leaves history older than the window out of it', () => {
    const out = denseDaily([{ date: '2026-07-01', count: 40 }], 3, '2026-08-13');
    expect(out.every((d) => d.count === 0)).toBe(true);
  });
});

describe('problemsSection: what went wrong in THIS run', () => {
  it('says nothing when nothing went wrong', () => {
    expect(problemsSection(emptyRun())).toEqual([]);
  });

  it('reports a failure that the ledger cannot show, because it went back to ready', () => {
    // A retryable failure resets the task to `ready`, so `recentFailures` will
    // never see it. On 08-13 that hid all six copilot quota failures.
    const out = problemsSection(
      emptyRun({
        problems: [{ id: 'T1', title: 'add a health check', why: 'QUOTA: out until 2026-09-01', retrying: true }],
      }),
    ).join('\n');
    expect(out).toContain('T1');
    expect(out).toContain('add a health check');
    expect(out).toContain('2026-09-01');
  });

  it('distinguishes a task that will retry itself from one that is done trying', () => {
    const [, , retrying] = problemsSection(
      emptyRun({ problems: [{ id: 'T1', title: 'a', why: 'w', retrying: true }] }),
    );
    const [, , spent] = problemsSection(
      emptyRun({ problems: [{ id: 'T2', title: 'a', why: 'w', retrying: false }] }),
    );
    expect(retrying).toContain('will retry');
    expect(spent).toContain('no attempts left');
    expect(retrying).not.toEqual(spent);
  });

  it('keeps a stack trace to its first line', () => {
    const why = 'Error: boom\n    at one\n    at two';
    const out = problemsSection(emptyRun({ problems: [{ id: 'T1', title: 'a', why, retrying: false }] }));
    expect(out.join('\n')).toContain('Error: boom');
    expect(out.join('\n')).not.toContain('at one');
  });
});

describe('staleFailuresSection: older failures, not presented as news', () => {
  const failed = (id: string, updated: string, status = 'failed') =>
    ({ id, title: `task ${id}`, status, updated_at: updated, last_error: 'old error' }) as never;

  it('dates what it prints', () => {
    // Trcg4dbivgj and Tgzn7fnkffd failed on 08-09 and were printed undated
    // under "Failures to look at" on both 08-12 and 08-13.
    const out = staleFailuresSection([failed('Told', '2026-08-09T10:00:00Z')], emptyRun()).join('\n');
    expect(out).toContain('last tried 2026-08-09');
  });

  it('does not repeat a task this run already reported', () => {
    const sum = emptyRun({ problems: [{ id: 'Tdup', title: 'x', why: 'w', retrying: false }] });
    expect(staleFailuresSection([failed('Tdup', '2026-08-13T10:00:00Z')], sum)).toEqual([]);
  });

  it('leaves blocked tasks to the blocked note', () => {
    const out = staleFailuresSection([failed('Tblk', '2026-08-09T10:00:00Z', 'blocked')], emptyRun());
    expect(out).toEqual([]);
  });
});

describe('blockedNote: advice you can actually act on', () => {
  it('is silent when nothing was blocked', () => {
    expect(blockedNote(emptyRun())).toEqual([]);
  });

  it('names the refused command and warns that matching is exact', () => {
    const out = blockedNote(emptyRun({ blocked: 1, blockedBy: ['ls frontend'] })).join('\n');
    expect(out).toContain('ls frontend');
    expect(out).toContain('exact');
  });

  it('does not tell you to allow-list something it just said it could not name', () => {
    // Printed verbatim on 2026-08-13: "The driver could not name what was
    // refused" followed immediately by "Allow-list it". Two debugging rounds
    // went into a permission file that was not the problem.
    const out = blockedNote(emptyRun({ blocked: 2, blockedBy: [] })).join('\n');
    expect(out).toContain('could not name');
    expect(out).not.toMatch(/allow-list it/i);
    expect(out).toContain('archived agent output');
  });
});

/*
 * Run 16 shipped one of these and said nothing. A denial that the work survived
 * is not a failure, so it must not arrive under the heading that says the agent
 * wrote nothing - and it must still arrive.
 */
describe('blockedNote: a refusal the work got past anyway', () => {
  const shipped = {
    blockedShipped: [
      { id: 'T7', title: 'add the slow-search warning', permissions: ['bash: python -c'] },
    ],
  };

  it('speaks up even though nothing failed', () => {
    const out = blockedNote(emptyRun(shipped)).join('\n');
    expect(out).toContain('T7');
    expect(out).toContain('bash: python -c');
    expect(out).toContain('add the slow-search warning');
  });

  it('does not call a pushed commit a failure', () => {
    const out = blockedNote(emptyRun(shipped)).join('\n');
    expect(out).toContain('is not a');
    expect(out).not.toMatch(/wrote nothing/);
  });

  it('keeps it clear of the paragraph about tasks that produced nothing', () => {
    const out = blockedNote(emptyRun({ ...shipped, blocked: 1, blockedBy: ['ls frontend'] })).join('\n');
    // Both are reported, and the shipped one comes first: it is the surprising
    // line, and the one a reader skimming for "BLOCKED" would otherwise merge
    // with the failures below it.
    expect(out, 'the shipped denial vanished once something also failed').toContain('T7');
    expect(out).toContain('ls frontend');
    expect(out.indexOf('T7')).toBeLessThan(out.indexOf('BLOCKED, not lazy'));
  });

  it('stays silent when nothing was refused at all', () => {
    expect(blockedNote(emptyRun())).toEqual([]);
  });

  /*
   * Run 17 refused one task two things and this paragraph named one, three
   * lines above a sentence telling the operator to allow "that exact command
   * form". Doing what it said would have left the other refusal in place.
   */
  it('names both refusals when there were two, and asks for both', () => {
    const out = blockedNote(
      emptyRun({
        blockedShipped: [
          {
            id: 'T7',
            title: 'add the slow-search warning',
            permissions: ['bash: Get-ChildItem -Name', 'write: check_db.py'],
          },
        ],
      }),
    ).join('\n');

    expect(out).toContain('bash: Get-ChildItem -Name');
    expect(out, 'the second refusal was dropped, which is the whole bug').toContain(
      'write: check_db.py',
    );

    /*
     * And the instruction has to agree with the list above it. Unquoted and
     * unwrapped first: the note is an array of `> `-prefixed lines joined with
     * newlines, so a sentence that spans two of them is never one substring of
     * `out` and an assertion against it passes whatever the code says.
     */
    const prose = out.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
    expect(prose).toContain('Allow those exact command forms if it should have had them');
    expect(prose).not.toContain('that exact command form');
  });

  /*
   * The other half of the same sentence. Run 18 denied one task one thing and
   * the paragraph read "Allow those exact command forms if it should have had
   * them" — which is the ordinary case, not the rare one.
   */
  it('asks for one command form when only one was refused', () => {
    const prose = blockedNote(emptyRun(shipped)).join('\n').replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
    expect(prose).toContain('Allow that exact command form if it should have had it');
    expect(prose).not.toContain('those exact command forms');
  });

  it('does not print an empty pair of backticks when nothing could be named', () => {
    const out = blockedNote(
      emptyRun({ blockedShipped: [{ id: 'T8', title: 'a task', permissions: [] }] }),
    ).join('\n');

    expect(out).toContain('T8');
    expect(out).toContain('denied a tool permission');
    expect(out).not.toContain('``');

    // ...and the instruction agrees with THAT line, which is singular.
    const prose = out.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
    expect(prose).toContain('Allow that exact command form');
    expect(prose).not.toContain('those exact command forms');
  });
});

describe('stashNote: preserved somewhere nobody looks is still lost', () => {
  const pile = {
    repo: 'example-api',
    path: 'D:/repos/example-api',
    count: 11,
    files: ['make_commits.bat', 'app/models/document.py'],
    oldest: '2026-08-08', recent: [],
  };

  it('is silent when nothing has been set aside', () => {
    expect(stashNote(emptyRun())).toEqual([]);
  });

  it('says how much, how old, and what is in it', () => {
    // The real reading from example-api on 2026-08-15. Every one of those eleven
    // was announced when it happened and never mentioned again.
    const out = stashNote(emptyRun({ stashes: [pile] })).join('\n');
    expect(out).toContain('11 set-aside change(s)');
    expect(out).toContain('example-api');
    expect(out).toContain('2026-08-08');
    expect(out).toContain('make_commits.bat');
  });

  it('prints the command, because the owner does not use git by hand', () => {
    const out = stashNote(emptyRun({ stashes: [pile] })).join('\n');
    expect(out).toContain('git -C D:/repos/example-api stash list');
    expect(out).toContain('stash pop');
  });

  it('still reports a pile whose contents it could not list', () => {
    // `stash show` can fail, and then files is empty while the stashes are very
    // much there. Falling silent because the inventory is missing would hide the
    // pile in exactly the case where something is already wrong with it.
    const out = stashNote(emptyRun({ stashes: [{ ...pile, files: [] }] })).join('\n');
    expect(out).toContain('11 set-aside change(s)');
    expect(out).toContain('git -C D:/repos/example-api stash list');
  });

  it('reaches the report itself, not just its own function', () => {
    // A note nothing prints is not a note. writeReport composes ~10 sections and
    // forgetting one line there is invisible to every test of the section.
    const src = readFileSync(new URL('../core/reporter.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/lines\.push\(\.\.\.stashNote\(sum\)\)/);
  });
});

describe('agentOutNote: a dead provider is not a broken agent', () => {
  it('is silent when every agent survived the run', () => {
    expect(agentOutNote(emptyRun())).toEqual([]);
  });

  it('names the agent, carries the reset date, and says to do nothing', () => {
    const out = agentOutNote(
      emptyRun({ agentsOut: [{ agent: 'copilot', why: 'QUOTA — quota resets 2026-09-01', skipped: 5 }] }),
    ).join('\n');
    expect(out).toContain('copilot');
    expect(out).toContain('2026-09-01');
    expect(out).toContain('5 further task(s)');
    expect(out).toContain('by hand');
  });
});

describe('heldNote: work withheld is not work that never existed', () => {
  it('is silent when nothing was held', () => {
    expect(heldNote(emptyRun())).toEqual([]);
  });

  it('says how much is waiting, on what, and that there is nothing to do', () => {
    // 2026-08-12 printed `stopped because: batch exhausted` two lines above
    // `backlog ready: 8`. Both numbers were true and together they were a lie.
    const out = heldNote(emptyRun({ held: [{ repo: 'example-api', count: 8 }] })).join('\n');
    expect(out).toContain('8 job(s) were held back');
    expect(out).toContain('example-api (8)');
    expect(out).toContain('Nothing to do by hand');
  });

  it('totals across projects rather than reporting only the first', () => {
    const out = heldNote(
      emptyRun({ held: [{ repo: 'example-api', count: 8 }, { repo: 'shanauto', count: 2 }] }),
    ).join('\n');
    expect(out).toContain('10 job(s)');
    expect(out).toContain('shanauto (2)');
  });
});

describe('runwayCell: runway that knows the provider is dead', () => {
  const cfg = {
    system: { daily_target: 30 },
    repos: [],
    drivers: {
      agents: { registry: { copilot: { kind: 'cli' } } },
      routing: {
        rules: [],
        default: 'copilot',
        simple_agents: ['copilot'],
        complex_agents: ['copilot'],
        complexity: { complex_kinds: [], min_est_lines: 500, min_files: 5 },
      },
    },
  } as never;

  afterEach(() => {
    ledger.open().exec("DELETE FROM tasks WHERE repo='runway-test';");
  });

  it('prints the bare number when nothing is out', () => {
    expect(runwayCell(cfg, emptyRun())).toMatch(/^~[\d.]+ day\(s\)$/);
  });

  it('says how much of the ready backlog is stranded behind the dead agent', () => {
    // 2026-08-13 reported `runway ~0.2 day(s)` while five of seven next-up
    // tasks routed to copilot, which was out for another eighteen days. Read
    // straight, that number says "write more tasks" — the opposite of the truth.
    ledger.insertTasks(null, 'runway-test', [task('one'), task('two')]);
    const out = runwayCell(cfg, emptyRun({ agentsOut: [{ agent: 'copilot', why: 'QUOTA', skipped: 2 }] }));
    expect(out).toContain('2 of 2 ready task(s)');
    expect(out).toContain('copilot');
    expect(out).toContain('out');
  });
});

describe('notify (§9.6)', () => {
  const savedTopic = process.env.NTFY_TOPIC;
  const savedToken = process.env.NTFY_TOKEN;

  afterEach(() => {
    vi.unstubAllGlobals();
    // restore the real environment, since these tests scribble on it
    if (savedTopic === undefined) delete process.env.NTFY_TOPIC;
    else process.env.NTFY_TOPIC = savedTopic;
    if (savedToken === undefined) delete process.env.NTFY_TOKEN;
    else process.env.NTFY_TOKEN = savedToken;
  });

  it('sends the title only when the topic is unauthenticated', async () => {
    // §9.6: an unauthenticated ntfy.sh topic is PUBLIC — anyone who guesses it
    // can read every message ever posted to it. The failure body (raw error
    // text, commit titles) must not ride on such a topic; the title alone is
    // enough to get a person to a screen, and already carries the count.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.NTFY_TOKEN;
    process.env.NTFY_TOPIC = 'sa-test-topic';

    await notify('ShanAuto 3/30', 'the secret failure body');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh/sa-test-topic');
    expect(init.headers).toEqual({ Title: 'ShanAuto 3/30' });
    expect(init.body).toBeUndefined();
  });

  it('sends the full body with a Bearer token on a private topic', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.NTFY_TOPIC = 'sa-test-topic';
    process.env.NTFY_TOKEN = 'tk_private';

    await notify('ShanAuto 3/30', 'details for my eyes only');

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toEqual({
      Title: 'ShanAuto 3/30',
      Authorization: 'Bearer tk_private',
    });
    expect(init.body).toBe('details for my eyes only');
  });

  it('does nothing when no topic is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_TOKEN;

    await notify('ShanAuto 3/30', 'irrelevant');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is best-effort: a failed fetch never throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    process.env.NTFY_TOPIC = 'sa-test-topic';
    process.env.NTFY_TOKEN = 'tk_private';

    await expect(notify('x', 'y')).resolves.toBeUndefined();
  });
});

describe('breakingNote: what used to work differently', () => {
  const moved = {
    breakingShipped: [
      {
        id: 'T9',
        title: 'return frequent queries in an envelope',
        what: 'callers that index the response break',
      },
    ],
  };

  it('is silent when nothing changed shape', () => {
    expect(breakingNote(emptyRun())).toEqual([]);
  });

  it('names the task and what stops working', () => {
    const out = breakingNote(emptyRun(moved)).join('\n');
    expect(out).toContain('T9');
    expect(out).toContain('return frequent queries in an envelope');
    expect(out).toContain('callers that index the response break');
  });

  /*
   * These are not incidents. Every one was declared before the work started and
   * passed the repo's own check afterwards, and a report that files them under
   * failures teaches the operator to read a deliberate decision as a fault.
   */
  it('does not read as a fault report', () => {
    const out = breakingNote(emptyRun(moved)).join('\n');
    expect(out).toContain('nothing here went wrong');
    expect(out).not.toMatch(/BLOCKED|failed/);
  });

  /*
   * A note nothing prints is not a note. Same reason as stashNote's own wiring
   * test: writeReport composes ~10 sections, and a section that exists but was
   * never pushed passes every test of the section itself.
   */
  it('reaches the report itself, above the paragraph about refusals', () => {
    const src = readFileSync(new URL('../core/reporter.ts', import.meta.url), 'utf8');
    expect(src, 'the note is never pushed').toMatch(
      /lines\.push\(\.\.\.breakingNote\(sum\)\)/,
    );
    // Presence first: indexOf returns -1 for something absent, so an ordering
    // assertion on its own passes just as well when the line has vanished.
    expect(src.indexOf('breakingNote(sum)')).toBeLessThan(src.indexOf('blockedNote(sum)'));
  });
});
