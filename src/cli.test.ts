import { test, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { ROOT } from './config.js';
import { REPAIR_TITLE_PREFIX } from './core/repair.js';
import { today } from './util.js';
import type { NormalizedTask } from './schemas.js';

/**
 * Runs the real CLI as a subprocess, against a throwaway ledger.
 *
 * It used to `rmSync` the tracked `data/reports/ledger.csv` and then regenerate
 * it from the REAL database — deleting real history on every test run and
 * rebuilding it only because this machine happened to have rows. Any checkout
 * without them ended up committing an empty file over 135 lines of history.
 *
 * `SHANAUTO_DB` is passed through to the child, and `reportsDir()` follows it,
 * so the whole exchange happens in the temp directory.
 */
const dir = mkdtempSync(join(tmpdir(), 'sa-cli-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('CLI --export-csv creates ledger.csv beside its own ledger', async () => {
  const db = join(dir, 'test.db');
  const outPath = join(dir, 'reports', 'ledger.csv');

  // Snapshot the REAL tracked ledger.csv before the export runs against a temp
  // DB, so "the real data/reports is left alone" is asserted, not assumed.
  const realPath = join(ROOT, 'data', 'reports', 'ledger.csv');
  const realBefore = existsSync(realPath) ? readFileSync(realPath, 'utf8') : null;

  const { exitCode } = await execa('tsx', ['src/index.ts', '--export-csv'], {
    cwd: ROOT,
    env: { SHANAUTO_DB: db },
  });

  expect(exitCode).toBe(0);
  expect(existsSync(outPath)).toBe(true);
  expect(readFileSync(outPath, 'utf8')).toContain('ID,milestone_id,repo,title,kind,instruction');

  // The whole point of routing reports through SHANAUTO_DB (see the file header):
  // the tracked file is byte-identical — or still absent — after an export ran.
  if (realBefore === null) {
    expect(existsSync(realPath)).toBe(false);
  } else {
    expect(readFileSync(realPath, 'utf8')).toBe(realBefore);
  }
});

/* ------------------------------------------------------------------ Part 3 */

/**
 * The daily-engine commands (run/plan/report/resolve) had no subprocess tests:
 * the run.lock lifecycle, the F3 run-close, and the F9 resolve guard were all
 * only ever exercised by hand. These tests drive the real CLI against a
 * throwaway SHANAUTO_DB + SHANAUTO_CONFIG, with a scratch git repo standing in
 * for the operator's real projects.
 */

/** A fresh git repo with an identity configured, on branch main. */
async function scratchRepo(name: string): Promise<string> {
  const path = join(dir, 'repos', name);
  mkdirSync(path, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: path });
  await execa('git', ['config', 'user.name', 'ShanAuto Test'], { cwd: path });
  await execa('git', ['config', 'user.email', 'shanauto-test@example.com'], { cwd: path });
  return path;
}

/**
 * The temp drivers.yaml: a brain that boots but never thinks, chat disabled,
 * agents registered so routing validates. Only the brain is ever instantiated,
 * and only by `plan` — so a test can never reach a real binary or a network.
 */
const TEMP_DRIVERS = `brain:
  active: stub
  registry:
    stub:
      module: ./drivers/__fixtures__/brain.stub.js
chat:
  active: chatgpt
  enabled: false
  registry:
    chatgpt:
      module: ./drivers/chat.chatgpt.js
agents:
  registry:
    opencode:
      module: ./drivers/agent.opencode.js
      kind: cli
    agy:
      module: ./drivers/agent.agy.js
      kind: cli
    copilot:
      module: ./drivers/agent.copilot.js
      kind: cli
    antigravity:
      module: ./drivers/agent.antigravity.js
      kind: ide
routing:
  complex_agents: [agy, copilot]
  simple_agents: [opencode]
  default: opencode
  complexity:
    min_est_lines: 25
    min_files: 2
    complex_kinds: [feature, refactor, bugfix]
  rules: []
`;

/**
 * A throwaway config dir for one CLI invocation.
 *
 * The real config/repos.yaml names the operator's actual projects, so a test
 * that ran the CLI against it would touch them. system.yaml is a copy with two
 * overrides tuned for the seeded fixtures: daily_target 1 makes a handful of
 * queued tasks read as a 3+ day runway (so `run` does not try to plan), and
 * min_ready 5 lets `plan` short-circuit its refill after a few seeded tasks.
 */
function writeConfig(cfgDir: string, repoPath: string): void {
  mkdirSync(cfgDir, { recursive: true });
  /*
   * `\r?\n`, not `\n`. config/system.yaml is CRLF, and in JavaScript `.` does not
   * match `\r` - so `min_ready:.*\n` could never match `min_ready: 30\r\n` and
   * NEITHER override applied. Every subprocess test in this file ran against the
   * real daily_target of 30 and min_ready of 30 while its comments described 1
   * and 5, for as long as they have existed.
   *
   * They passed anyway, for a reason unrelated to what they say: with no
   * unplanned milestone in the ledger, planNextMilestone returns 0 before it
   * reaches the brain, so the stub never threw and the backlog never needed to
   * be full. The first test to seed a milestone found it immediately.
   *
   * Asserted rather than trusted, because a silent no-op is exactly how this
   * survived - and it is the same trap as the assertion in offersCommand over
   * in agent-check-cmd.test.ts: a transformation that quietly does nothing.
   */
  const system = readFileSync(join(ROOT, 'config', 'system.yaml'), 'utf8')
    .replace(/daily_target:.*\r?\n/, 'daily_target: 1\n')
    .replace(/min_ready:.*\r?\n/, 'min_ready: 5\n');
  expect(system, 'daily_target override').toMatch(/^daily_target: 1$/m);
  expect(system, 'min_ready override').toMatch(/^\s*min_ready: 5$/m);
  writeFileSync(join(cfgDir, 'system.yaml'), system);
  writeFileSync(join(cfgDir, 'drivers.yaml'), TEMP_DRIVERS);
  writeFileSync(
    join(cfgDir, 'repos.yaml'),
    `repos:\n  - id: scratch\n    path: ${repoPath.replace(/\\/g, '/')}\n` +
      `    branch: main\n    stack: test\n    verify_cmd: git status\n    weight: 1\n`,
  );
}

/**
 * Run the real CLI. NTFY_TOPIC and GH_TOKEN are pinned empty so a test can
 * never fire the operator's notifications or GitHub lookups through whatever
 * happens to be in the inheriting environment.
 */
async function runCli(args: string[], env: Record<string, string>) {
  const res = await execa('tsx', ['src/index.ts', ...args], {
    cwd: ROOT,
    env: { NTFY_TOPIC: '', GH_TOKEN: '', ...env },
    reject: false,
    timeout: 120_000,
  });
  return { exitCode: res.exitCode, out: `${res.stdout}\n${res.stderr}` };
}

/**
 * A temp db path whose parent directory is guaranteed to exist. The subprocess
 * normally creates the db, but seeding runs first — and one test must not depend
 * on an earlier test having created the directory.
 */
function dbFile(name: string): string {
  const db = join(dir, 'dbs', name);
  mkdirSync(dirname(db), { recursive: true });
  return db;
}

/** Read a temp ledger in-process (module cached; the handle follows the env). */
async function withLedger<T>(db: string, fn: (ledger: typeof import('./ledger.js')) => T): Promise<T> {
  process.env.SHANAUTO_DB = db;
  const ledger = await import('./ledger.js');
  try {
    return fn(ledger);
  } finally {
    ledger.closeForTest();
  }
}

function baseTask(over: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    title: 'base', kind: 'feature', instruction: 'do it', acceptance: 'done',
    files_hint: [], verify_cmd: 'git status', depends_on: [],
    est_lines: 5, executor_hint: 'cli', ...over,
  };
}

test('run with nothing ready acquires then releases the lock, and closes the run (F3, SEC-5)', async () => {
  const repo = await scratchRepo('run-nothing');
  const cfgDir = join(dir, 'cfg-run-nothing');
  const db = dbFile('run-nothing.db');
  writeConfig(cfgDir, repo);

  // A blocked barrier keeps every dependent pending without deadlocking it: the
  // barrier is 'blocked', not 'failed', so no chain is parked; no task is
  // 'ready', so nothing dispatches; and 4 pending / daily_target 1 = a 4-day
  // runway, so run() does not try to plan.
  await withLedger(db, (ledger) => {
    const ids = ledger.insertTasks(null, 'scratch', [
      baseTask({ title: 'blocked barrier' }),
      ...Array.from({ length: 4 }, (_, i) => baseTask({ title: `waiting ${i}`, depends_on: [0] })),
    ]);
    ledger.setStatus(ids[0]!, 'blocked');
    expect(ids).toHaveLength(5);
  });

  const { exitCode, out } = await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(exitCode).toBe(0);
  expect(out).toContain('Nothing to work on.');
  const lock = join(dirname(db), 'state', 'run.lock');
  expect(existsSync(lock)).toBe(false);

  // F3: the run row is closed on the no-op path, not left ended_at NULL.
  await withLedger(db, (ledger) => {
    const rows = ledger
      .open()
      .prepare('SELECT ended_at, notes FROM runs')
      .all() as { ended_at: string | null; notes: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(rows[0]!.notes).toBe('nothing_ready');
  });
});

test('run refuses a live lock and leaves it in place (SEC-5)', async () => {
  const repo = await scratchRepo('run-live');
  const cfgDir = join(dir, 'cfg-run-live');
  const db = dbFile('run-live.db');
  writeConfig(cfgDir, repo);

  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const lock = join(dirname(db), 'state', 'run.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, String(child.pid));
  try {
    const { exitCode, out } = await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

    expect(exitCode).toBe(1);
    expect(out).toContain('Another run holds');
    expect(readFileSync(lock, 'utf8')).toBe(String(child.pid));
  } finally {
    child.kill();
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
  }
});

test('run takes over a stale lock left by a dead pid (SEC-5)', async () => {
  const repo = await scratchRepo('run-stale');
  const cfgDir = join(dir, 'cfg-run-stale');
  const db = dbFile('run-stale.db');
  writeConfig(cfgDir, repo);

  // A pid that is genuinely gone: spawn a process that exits immediately and
  // keep its number.
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    dead.once('spawn', () => resolve());
    dead.once('error', reject);
  });
  const deadPid = dead.pid;
  await new Promise<void>((resolve, reject) => {
    dead.once('exit', () => resolve());
    dead.once('error', reject);
  });

  const lock = join(dirname(db), 'state', 'run.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, String(deadPid));

  const { exitCode, out } = await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(exitCode).toBe(0);
  expect(out).toContain('stale');
  expect(existsSync(lock)).toBe(false);
});

/**
 * `--dry` is documented as "show what would run, change nothing", and planning
 * was happening above the dry check: shaping ideas, MOVING ideas/inbox.md into
 * the archive, refilling the backlog, spending a provider call on each. The one
 * command offered as safe to try was the one that emptied the inbox.
 *
 * The trigger here is the runway, not the inbox, on purpose: INBOX() is
 * ROOT-relative and cannot be redirected, so a test that proved this through
 * the inbox would have to write the operator's real file — the mistake this
 * file's header and the KILLSWITCH comment both already record.
 *
 * 2 ready tasks / daily_target 1 = a 2-day runway, under the 3-day floor.
 */
test('run --dry reports the planning it would do without doing any of it', async () => {
  const repo = await scratchRepo('run-dry');
  const cfgDir = join(dir, 'cfg-run-dry');
  const db = dbFile('run-dry.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    ledger.insertTasks(null, 'scratch', [
      baseTask({ title: 'short runway 0' }),
      baseTask({ title: 'short runway 1' }),
    ]);
  });

  const { exitCode, out } = await runCli(['run', '--dry'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
  });

  expect(exitCode).toBe(0);
  expect(out).toContain('Nothing planned, nothing archived, no provider call made.');
  // The planning path announces itself before it runs; neither line may appear.
  expect(out).not.toContain('planning more work first');
  expect(out).not.toContain('to work out first');
  // It still says what it would attempt — dry means silent about nothing.
  expect(out).toContain('DRY RUN — would attempt');

  // Nothing written: no new tasks, and the two seeded ones still ready.
  await withLedger(db, (ledger) => {
    const rows = ledger
      .open()
      .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
      .all() as { status: string; n: number }[];
    expect(rows).toEqual([{ status: 'ready', n: 2 }]);
  });
});

/** The other write a dry run used to make: queueing a repair job for a red repo. */
test('run --dry names the repair job it would queue without queueing it', async () => {
  const repo = await scratchRepo('run-dry-red');
  const cfgDir = join(dir, 'cfg-run-dry-red');
  const db = dbFile('run-dry-red.db');
  writeConfig(cfgDir, repo);
  // A check that fails without needing a broken project: the ref does not exist,
  // so git exits non-zero and the repo reads as red.
  writeFileSync(
    join(cfgDir, 'repos.yaml'),
    `repos:\n  - id: scratch\n    path: ${repo.replace(/\\/g, '/')}\n` +
      `    branch: main\n    stack: test\n` +
      `    verify_cmd: git rev-parse --verify no-such-ref\n    weight: 1\n`,
  );

  // 3 ready / daily_target 1 = a 3-day runway, so the planning branch above is
  // not what this test is measuring.
  await withLedger(db, (ledger) => {
    ledger.insertTasks(null, 'scratch', [
      ...Array.from({ length: 3 }, (_, i) => baseTask({ title: `queued ${i}` })),
    ]);
  });

  const { exitCode, out } = await runCli(['run', '--dry'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
  });

  expect(exitCode).toBe(0);
  expect(out).toContain('would add a repair job');

  await withLedger(db, (ledger) => {
    const titles = ledger.openTasksByRepo('scratch').map((t) => t.title);
    expect(titles).toHaveLength(3);
    expect(titles.some((t) => t.startsWith(REPAIR_TITLE_PREFIX))).toBe(false);
  });
});

test('plan boots the stub brain and reports an empty refill', async () => {
  const repo = await scratchRepo('plan');
  const cfgDir = join(dir, 'cfg-plan');
  const db = dbFile('plan.db');
  writeConfig(cfgDir, repo);

  // 6 ready tasks >= min_ready 5, so refillBacklog short-circuits and the stub
  // brain is never asked. True only since the CRLF fix in writeConfig above:
  // before it min_ready was 30, the backlog check never fired, and this passed
  // because there was no unplanned milestone rather than because it stopped.
  await withLedger(db, (ledger) => {
    ledger.insertTasks(null, 'scratch', [
      ...Array.from({ length: 6 }, (_, i) => baseTask({ title: `ready ${i}` })),
    ]);
  });

  const { exitCode, out } = await runCli(['plan'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(exitCode).toBe(0);
  expect(out).toContain('Backlog: +0');
});

test('report writes its markdown beside the redirected ledger', async () => {
  const repo = await scratchRepo('report');
  const cfgDir = join(dir, 'cfg-report');
  const db = dbFile('report.db');
  writeConfig(cfgDir, repo);

  // A gh shim that exits 1, so the contribution check degrades to "unverified"
  // instantly instead of calling the real GitHub CLI (which is installed here).
  const shim = join(dir, 'fauxbin');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'gh.cmd'), '@echo off\r\nexit /b 1\r\n');

  const { exitCode, out } = await runCli(['report'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
    PATH: `${shim}${delimiter}${process.env.PATH ?? ''}`,
  });

  expect(exitCode).toBe(0);
  const reportPath = join(dirname(db), 'reports', `${today()}.md`);
  expect(existsSync(reportPath)).toBe(true);
  const report = readFileSync(reportPath, 'utf8');
  expect(report).toContain(`# ShanAuto - ${today()}`);
  expect(report).toContain('**Committed: 0**');
  // The gh shim won, so the report says it could not verify rather than
  // inventing a GitHub number.
  expect(report).toContain('unverified');
});

test('report says whether the work is stuck, not just how many tasks landed (O29)', async () => {
  /*
   * The call site, not the rule. `milestonesSection` is covered on its own in
   * report-milestones.test.ts, and deleting the one line that CALLS it from
   * writeReport left every one of those tests green — the same hole that has
   * now appeared five times in this project.
   *
   * What O29 was about is this file on disk. A day where everything stalled
   * printed `committed 0 · backlog ready 0 · runway ~0`, character for
   * character what a day with nothing to do printed, and the report is what
   * gets read when nobody is watching.
   */
  const repo = await scratchRepo('report-stuck');
  const cfgDir = join(dir, 'cfg-report-stuck');
  const db = dbFile('report-stuck.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const m = ledger.addMilestone(epic, 'scratch', 'Rank the attention list', 'detail', 0);
    ledger.setMilestoneStatus(m, 'blocked', 'it did not ship: gate rejected: DEAD_EXPORT');
    // Out of automatic re-plans: the one state that genuinely needs a person.
    ledger.open().prepare('UPDATE milestones SET replans=? WHERE id=?')
      .run(ledger.MILESTONE_AUTO_REPLANS, m);
  });

  const shim = join(dir, 'fauxbin-stuck');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'gh.cmd'), '@echo off\r\nexit /b 1\r\n');

  const { exitCode } = await runCli(['report'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
    PATH: `${shim}${delimiter}${process.env.PATH ?? ''}`,
  });
  expect(exitCode).toBe(0);

  const report = readFileSync(join(dirname(db), 'reports', `${today()}.md`), 'utf8');
  expect(report).toContain('Where the work stands');
  expect(report).toContain('nothing will pick');
  expect(report).toContain('Rank the attention list');
  // And the reason, so the reader can judge without opening anything else.
  expect(report).toContain('DEAD_EXPORT');
});

test('report on a quiet day does not read like a stalled one (O29)', async () => {
  // The other half. If both days print the same thing, nothing has been fixed.
  const repo = await scratchRepo('report-quiet');
  const cfgDir = join(dir, 'cfg-report-quiet');
  const db = dbFile('report-quiet.db');
  writeConfig(cfgDir, repo);

  const shim = join(dir, 'fauxbin-quiet');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'gh.cmd'), '@echo off\r\nexit /b 1\r\n');

  await runCli(['report'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
    PATH: `${shim}${delimiter}${process.env.PATH ?? ''}`,
  });

  const report = readFileSync(join(dirname(db), 'reports', `${today()}.md`), 'utf8');
  expect(report).toContain('Where the work stands');
  expect(report).not.toContain('nothing will pick');
});

test('run says so when the acceptance check doubts a finished milestone (O25)', async () => {
  /*
   * Run 22, reproduced. Three commits, zero failures, the idea reported done —
   * and the thing the operator complained about still broken, because one of
   * the commits was a test file proving a function already behaved correctly.
   * True, committed, beside the point.
   *
   * Bypassing the check left every acceptance test green, because those cover
   * the reader and this covers whether anything calls it.
   */
  const repo = await scratchRepo('accept-short');
  const cfgDir = join(dir, 'cfg-accept-short');
  const db = dbFile('accept-short.db');
  writeConfig(cfgDir, repo);

  const ms = await withLedger(db, (ledger) => {
    const idea = ledger.addIdea(
      'Fix retrieval',
      'Documents with few retrievals must not be ranked top.',
      'scratch',
    );
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const m = ledger.addMilestone(epic, 'scratch', 'Rank the attention list', 'ranking', 0);
    const ids = ledger.insertTasks(m, 'scratch', [
      baseTask({ title: 'Add a test proving combine_scores is correct' }),
    ]);
    // Committed, and the milestone `planned` — settleMilestones only looks at
    // milestones that were actually decomposed, which is what a real one is by
    // the time its tasks are landing.
    ledger.setStatus(ids[0]!, 'committed');
    ledger.setMilestoneStatus(m, 'planned');
    return m;
  });

  const { out } = await runCli(['run'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
    SHANAUTO_STUB_ACCEPT: JSON.stringify({
      satisfied: false,
      missing: ['nothing enforces a minimum retrieval count before ranking'],
    }),
  });

  // Reopened, with what is missing, in a state the rest of the system handles.
  const after = await withLedger(db, (ledger) =>
    ledger.open().prepare('SELECT status,detail FROM milestones WHERE id=?').get(ms),
  ) as { status: string; detail: string };

  /*
   * ADVISORY since 2026-08-31. The milestone stays finished and the doubt is
   * printed, because across the three runs this check was live it reopened four
   * milestones and every one of them was wrong. It has never yet found a real
   * shortfall, and a check with no true positives must not overrule work that
   * already passed the gate, the reviewer and the acceptance criteria.
   *
   * What must NOT be lost is the operator hearing about it.
   */
  expect(after.status).toBe('done');
  expect(after.detail).not.toContain('STILL MISSING');
  expect(out).toContain('may not be finished');
  expect(out).toContain('minimum retrieval count');
  expect(out).toContain('Advisory only');
});

test('run checks a milestone whose work was all dropped, too (O25)', async () => {
  /*
   * Found by running it, 2026-08-31. `settleMilestones` returns a milestone in
   * neither `done` nor `blocked` when every task under it was DROPPED — the
   * "hollow" case — so the acceptance check never saw one, and a milestone
   * whose work was all declared unnecessary closed over its request in silence.
   *
   * "We decided none of this was needed" is a claim about the request. If it is
   * wrong, the request is unmet and nothing notices, which is O25 arriving by
   * the other door.
   */
  const repo = await scratchRepo('accept-hollow');
  const cfgDir = join(dir, 'cfg-accept-hollow');
  const db = dbFile('accept-hollow.db');
  writeConfig(cfgDir, repo);

  const ms = await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('Warn me', 'Warn when one category takes over half.', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const m = ledger.addMilestone(epic, 'scratch', 'High-spend warning', 'warn', 0);
    const ids = ledger.insertTasks(m, 'scratch', [baseTask({ title: 'Add the warning' })]);
    // Dropped, not committed: the hollow case.
    ledger.dropTask(ids[0]!, 'agent reported the work was already done');
    ledger.setMilestoneStatus(m, 'planned');
    return m;
  });

  const { out } = await runCli(['run'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
    SHANAUTO_STUB_ACCEPT: JSON.stringify({
      satisfied: false,
      missing: ['nothing warns when a category is over half the month'],
    }),
  });

  const after = (await withLedger(db, (ledger) =>
    ledger.open().prepare('SELECT status,detail FROM milestones WHERE id=?').get(ms),
  )) as { status: string; detail: string };

  // Advisory: reported, not acted on. See the test above.
  expect(after.detail).not.toContain('STILL MISSING');
  expect(out).toContain('may not be finished');
  expect(out).toContain('over half the month');
});

test('run leaves a milestone finished when the request was answered (O25)', async () => {
  // The other side. A checker that reopens satisfied work would spend every day
  // re-planning yesterday's, which is worse than the bug it is here to catch.
  const repo = await scratchRepo('accept-ok');
  const cfgDir = join(dir, 'cfg-accept-ok');
  const db = dbFile('accept-ok.db');
  writeConfig(cfgDir, repo);

  const ms = await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('Fix retrieval', 'Rank documents by retrieval count.', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const m = ledger.addMilestone(epic, 'scratch', 'Rank the attention list', 'ranking', 0);
    const ids = ledger.insertTasks(m, 'scratch', [baseTask({ title: 'Rank by retrieval count' })]);
    ledger.setStatus(ids[0]!, 'committed');
    ledger.setMilestoneStatus(m, 'planned');
    return m;
  });

  await runCli(['run'], {
    SHANAUTO_DB: db,
    SHANAUTO_CONFIG: cfgDir,
    SHANAUTO_STUB_ACCEPT: JSON.stringify({ satisfied: true, missing: [] }),
  });

  const after = await withLedger(db, (ledger) =>
    ledger.open().prepare('SELECT status FROM milestones WHERE id=?').get(ms),
  ) as { status: string };

  expect(after.status).toBe('done');
});

test('resolve commits exactly the hinted files and marks the task committed (F9)', async () => {
  const repo = await scratchRepo('resolve');
  const cfgDir = join(dir, 'cfg-resolve');
  const db = dbFile('resolve.db');
  writeConfig(cfgDir, repo);

  // Four lines so the TRIVIAL floor (min_insertions 3) is cleared; a .txt file
  // so the dead-export check has nothing to object to.
  writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\nthree\nfour\n');

  const tid = await withLedger(db, (ledger) => {
    const [id] = ledger.insertTasks(null, 'scratch', [
      baseTask({
        title: 'write a note', instruction: 'add notes.txt', acceptance: 'notes.txt exists',
        files_hint: ['notes.txt'], verify_cmd: '', depends_on: [],
      }),
    ]);
    ledger.setStatus(id!, 'handoff');
    return id!;
  });

  const first = await runCli(['resolve', tid], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });
  expect(first.exitCode).toBe(0);
  expect(first.out).toContain('Resolved');
  // The scratch repo has no remote, so the commit is local-only — which is
  // exactly the SEC-7 warning path, and still a successful resolve.
  expect(first.out).toContain('LOCAL ONLY');

  await withLedger(db, (ledger) => {
    expect(ledger.getTask(tid)?.status).toBe('committed');
  });

  // The tree is clean now, so a forced second resolve finds nothing to commit.
  const second = await runCli(['resolve', tid, '--force'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });
  expect(second.exitCode).toBe(1);
  expect(second.out).toContain('NO_CHANGES');
});

test('resolve refuses a non-handoff task without --force, and honours --force (F9)', async () => {
  const repo = await scratchRepo('resolve-ready');
  const cfgDir = join(dir, 'cfg-resolve-ready');
  const db = dbFile('resolve-ready.db');
  writeConfig(cfgDir, repo);
  writeFileSync(join(repo, 'ready.txt'), 'one\ntwo\nthree\nfour\n');

  const tid = await withLedger(db, (ledger) => {
    const [id] = ledger.insertTasks(null, 'scratch', [
      baseTask({
        title: 'ready work', files_hint: ['ready.txt'], verify_cmd: '', depends_on: [],
      }),
    ]);
    return id!; // no deps -> status 'ready', not 'handoff'
  });

  const refused = await runCli(['resolve', tid], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });
  expect(refused.exitCode).toBe(1);
  expect(refused.out).toContain("not 'handoff'");

  const forced = await runCli(['resolve', tid, '--force'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });
  expect(forced.exitCode).toBe(0);
  expect(forced.out).toContain('Resolved');

  await withLedger(db, (ledger) => {
    expect(ledger.getTask(tid)?.status).toBe('committed');
  });
});

test('resolve reports an unknown task id', async () => {
  const repo = await scratchRepo('resolve-nope');
  const cfgDir = join(dir, 'cfg-resolve-nope');
  const db = dbFile('resolve-nope.db');
  writeConfig(cfgDir, repo);

  const { exitCode, out } = await runCli(['resolve', 'NOPE'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(exitCode).toBe(1);
  expect(out).toContain('No such task');
});

/**
 * The queue can stop moving without anything announcing it.
 *
 * Observed 2026-08-15: one job failed, three more sat parked behind it, nothing
 * was left ready, and every later run reported "Nothing to work on". The status
 * screen showed `failed 6` and `blocked 3` among five other counts and offered
 * no hint that the machine had come to a halt — while the main menu read
 * "Nothing to build. Choose the first option and tell it what you want."
 */
test('status says so when everything is parked and nothing is queued', async () => {
  const repo = await scratchRepo('status-parked');
  const cfgDir = join(dir, 'cfg-status-parked');
  const db = dbFile('status-parked.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const ids = ledger.insertTasks(null, 'scratch', [
      baseTask({ title: 'Add Group model and Document relation' }),
      baseTask({ title: 'waiting behind it', depends_on: [0] }),
    ]);
    ledger.setStatus(ids[0]!, 'failed', 'VERIFY_FAIL - the repo own check failed');
    ledger.setStatus(ids[1]!, 'blocked');
  });

  const { out } = await runCli(['status'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(out).toContain('NEEDS YOU');
  // The count, the consequence, the name of the job, and the way out.
  expect(out).toMatch(/2 job\(s\) are stopped/);
  expect(out).toMatch(/next\s+run will find nothing to do/);
  expect(out).toContain('Add Group model and Document relation');
  expect(out).toContain('retry --failed');
});

test('status does not shout about a failure the next run is going to redo', async () => {
  /*
   * The contradiction this screen printed on 2026-08-30, four lines apart:
   *
   *   NEEDS YOU
   *     1 job(s) are stopped ... They are not picked up again on their own.
   *     To put them all back in the queue:  npm run sa -- retry --failed
   *   1 milestone(s) stopped - every task under them failed:
   *   1 of them will be planned again automatically on the next run. Nothing to do.
   *
   * Both true of the same task, from the same ledger, on the same screen. The
   * banner counted every failure; the line below it counted the ones that were
   * actually stranded. A failed task under a milestone with automatic re-plans
   * left is superseded and re-decomposed by the next run, and telling the
   * operator to go and type a command for it is the failure this whole screen
   * exists to prevent.
   *
   * Nothing caught the difference: swapping the query back for the old one left
   * every status test green, because none of them had a milestone.
   */
  const repo = await scratchRepo('status-recoverable');
  const cfgDir = join(dir, 'cfg-status-recoverable');
  const db = dbFile('status-recoverable.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'scratch', 'Create and view tasks by priority', 'd', 0);
    const ids = ledger.insertTasks(ms, 'scratch', [
      baseTask({ title: 'Add priority parameter to add_task' }),
    ]);
    ledger.setStatus(ids[0]!, 'failed', 'NO_CHANGES: agent produced no file changes');
    // The reason settleMilestones writes: the task titles and why each failed.
    ledger.setMilestoneStatus(
      ms,
      'blocked',
      'Add priority parameter to add_task: NO_CHANGES: agent produced no file changes',
    );
  });

  const { out } = await runCli(['status'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  // It is still reported - it failed, and the record says so.
  expect(out).toContain('Add priority parameter to add_task');
  expect(out).toContain('planned again automatically on the next run');
  // But it is not something the operator has to do anything about.
  expect(out).not.toContain('NEEDS YOU');
  expect(out).not.toContain('retry --failed');
});

test('status does shout once that milestone has no automatic retries left', async () => {
  // The same task, with the machine genuinely out of moves. This is the case
  // the banner was written for, and it has to survive the fix above.
  const repo = await scratchRepo('status-stranded');
  const cfgDir = join(dir, 'cfg-status-stranded');
  const db = dbFile('status-stranded.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'scratch', 'Create and view tasks by priority', 'd', 0);
    const ids = ledger.insertTasks(ms, 'scratch', [
      baseTask({ title: 'Add priority parameter to add_task' }),
    ]);
    ledger.setStatus(ids[0]!, 'failed', 'NO_CHANGES: agent produced no file changes');
    ledger.setMilestoneStatus(ms, 'blocked', 'its only task failed');
    ledger
      .open()
      .prepare('UPDATE milestones SET replans=? WHERE id=?')
      .run(ledger.MILESTONE_AUTO_REPLANS, ms);
  });

  const { out } = await runCli(['status'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(out).toContain('NEEDS YOU');
  expect(out).toContain('Add priority parameter to add_task');
  expect(out).toContain('retry --failed');
});

test('status stays quiet about parked work while there is still work queued', async () => {
  /*
   * A failure while the queue keeps moving is ordinary and is reported in the
   * run's own output. Shouting NEEDS YOU at every such failure would train the
   * operator to scroll past the one time it means the machine has stopped.
   */
  const repo = await scratchRepo('status-moving');
  const cfgDir = join(dir, 'cfg-status-moving');
  const db = dbFile('status-moving.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const ids = ledger.insertTasks(null, 'scratch', [
      baseTask({ title: 'one that failed' }),
      baseTask({ title: 'one still ready' }),
    ]);
    ledger.setStatus(ids[0]!, 'failed', 'VERIFY_FAIL');
  });

  const { out } = await runCli(['status'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(out).not.toContain('NEEDS YOU');
});

/*
 * Finding AP's wiring, end to end through the real CLI.
 *
 * settleMilestones and autoReplanBlocked are proven against a real database in
 * ledger.test.ts. What is proven here is that anything CALLS them: cut either
 * call out of index.ts and every one of those ledger tests stays green while
 * the machine goes back to stalling silently. That is the same gap that hid the
 * driver hop in finding AO a few hours earlier, so it is worth the subprocess.
 */
test('run finishes a milestone whose work is done, without being asked', async () => {
  const repo = await scratchRepo('settle-done');
  const cfgDir = join(dir, 'cfg-settle-done');
  const db = dbFile('settle-done.db');
  writeConfig(cfgDir, repo);

  // 4 pending behind a blocked barrier: nothing is ready, so no dispatch, and
  // daily_target 1 makes that a 4-day runway so `run` never reaches the planner.
  // What is left is the settle pass on its own.
  let ms = '';
  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    ms = ledger.addMilestone(epic, 'scratch', 'a finished milestone', 'detail', 0);
    const done = ledger.insertTasks(ms, 'scratch', [baseTask({ title: 'it shipped' })]);
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(done[0]!, 'committed');

    const ids = ledger.insertTasks(null, 'scratch', [
      baseTask({ title: 'blocked barrier' }),
      ...Array.from({ length: 4 }, (_, i) => baseTask({ title: `waiting ${i}`, depends_on: [0] })),
    ]);
    ledger.setStatus(ids[0]!, 'blocked');
  });

  const { exitCode, out } = await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(exitCode).toBe(0);
  expect(out).toContain('1 milestone(s) finished');
  const status = await withLedger(db, (ledger) =>
    (ledger.open().prepare('SELECT status FROM milestones WHERE id=?').get(ms) as {
      status: string;
    }).status,
  );
  expect(status).toBe('done');
});

test('run puts a stopped milestone back in the queue, without being asked', async () => {
  /*
   * The whole point of the finding. Before this, a milestone whose tasks all
   * failed stayed `planned` for ever: invisible to the planner, to `sa status`
   * and to `sa retry --failed` at the same time, while the run reported an
   * empty backlog and a zero-day runway. Unattended, that reads as finished.
   */
  const repo = await scratchRepo('settle-blocked');
  const cfgDir = join(dir, 'cfg-settle-blocked');
  const db = dbFile('settle-blocked.db');
  writeConfig(cfgDir, repo);

  let ms = '';
  let failedId = '';
  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    ms = ledger.addMilestone(epic, 'scratch', 'a stopped milestone', 'detail', 0);
    failedId = ledger.insertTasks(ms, 'scratch', [baseTask({ title: 'it did not ship' })])[0]!;
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(failedId, 'failed', 'gate rejected: DEAD_EXPORT');

    const ids = ledger.insertTasks(null, 'scratch', [
      baseTask({ title: 'blocked barrier' }),
      ...Array.from({ length: 4 }, (_, i) => baseTask({ title: `waiting ${i}`, depends_on: [0] })),
    ]);
    ledger.setStatus(ids[0]!, 'blocked');
  });

  const { exitCode, out } = await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  // The CLI output is the assertion message: a non-zero exit here is otherwise
  // reported as "expected 1 to be 0" with the actual error nowhere on screen.
  expect(exitCode, out).toBe(0);
  expect(out).toMatch(/1 milestone\(s\) stopped/);
  expect(out).toMatch(/Planning 1 of them again/);

  const after = await withLedger(db, (ledger) => ({
    milestone: ledger.open().prepare('SELECT status, replans FROM milestones WHERE id=?').get(ms) as {
      status: string;
      replans: number | null;
    },
    task: ledger.getTask(failedId)?.status,
  }));

  // Back in the queue, counted so it cannot happen twice, and the failure
  // superseded so the re-plan can actually reach `done`.
  expect(after.milestone.status).toBe('unplanned');
  expect(after.milestone.replans).toBe(1);
  expect(after.task).toBe('dropped');
});

test('plan settles before it refills, so a requeued milestone is in scope', async () => {
  // Ordering, not just presence: settling after refillBacklog would leave the
  // requeued milestone for the NEXT run, which is a person noticing again.
  const repo = await scratchRepo('settle-plan');
  const cfgDir = join(dir, 'cfg-settle-plan');
  const db = dbFile('settle-plan.db');
  writeConfig(cfgDir, repo);

  let ms = '';
  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    ms = ledger.addMilestone(epic, 'scratch', 'a stopped milestone', 'detail', 0);
    const t = ledger.insertTasks(ms, 'scratch', [baseTask({ title: 'it did not ship' })])[0]!;
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(t, 'failed', 'gate rejected: TEST_TAMPER');

    // 6 ready >= min_ready 5, so the refill short-circuits and the stub brain
    // is never asked - the settle pass is the only thing under test.
    ledger.insertTasks(null, 'scratch', [
      ...Array.from({ length: 6 }, (_, i) => baseTask({ title: `ready ${i}` })),
    ]);
  });

  const { exitCode, out } = await runCli(['plan'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(exitCode, out).toBe(0);
  const status = await withLedger(db, (ledger) =>
    (ledger.open().prepare('SELECT status FROM milestones WHERE id=?').get(ms) as {
      status: string;
    }).status,
  );
  expect(status).toBe('unplanned');
});

test('status names the stopped milestones and the way out of them', async () => {
  const repo = await scratchRepo('status-blocked');
  const cfgDir = join(dir, 'cfg-status-blocked');
  const db = dbFile('status-blocked.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'scratch', 'Rank the attention list', 'detail', 0);
    ledger.setMilestoneStatus(ms, 'blocked', 'it did not ship: gate rejected: DEAD_EXPORT');
    // Enough queued work that the NEEDS YOU banner stays quiet, so what is
    // asserted below is this list and not the parked-work one above it.
    ledger.insertTasks(null, 'scratch', [baseTask({ title: 'still ready' })]);
  });

  const { out } = await runCli(['status'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(out).toMatch(/1 milestone\(s\) stopped/);
  expect(out).toContain('Rank the attention list');
  expect(out).toContain('DEAD_EXPORT');
  /*
   * It has used none of its automatic re-plans, so the honest thing to tell the
   * operator is that the next run handles it. This line used to read "Each is
   * planned again automatically once. These have used that up" and send them to
   * `retry <milestoneId>` — a terminal command, given to the person this
   * interface exists to keep out of a terminal, to do by hand the thing that
   * was going to happen anyway.
   */
  expect(out).toContain('planned again automatically on the next run');
  expect(out).toContain('Nothing to do');
  expect(out).not.toContain('retry <milestoneId>');
  // Not filed under the heading for milestones that were never given any tasks.
  expect(out).not.toContain('no task was ever queued for them');
});

test('status only asks for help once the automatic re-plans really are used up', async () => {
  /*
   * The other half. Asking is right eventually — a milestone decomposed
   * MILESTONE_AUTO_REPLANS different ways and failed every time is telling us
   * it cannot be built here, and at that point the operator genuinely is the
   * next step. What was wrong was asking on the first failure and calling the
   * recovery spent when it had not started.
   */
  const repo = await scratchRepo('status-exhausted');
  const cfgDir = join(dir, 'cfg-status-exhausted');
  const db = dbFile('status-exhausted.db');
  writeConfig(cfgDir, repo);

  await withLedger(db, (ledger) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'scratch');
    const epic = ledger.addEpic(idea, 'scratch', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'scratch', 'Rank the attention list', 'detail', 0);
    ledger.setMilestoneStatus(ms, 'blocked', 'it did not ship: gate rejected: DEAD_EXPORT');
    ledger
      .open()
      .prepare('UPDATE milestones SET replans=? WHERE id=?')
      .run(ledger.MILESTONE_AUTO_REPLANS, ms);
    ledger.insertTasks(null, 'scratch', [baseTask({ title: 'still ready' })]);
  });

  const { out } = await runCli(['status'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(out).toContain('stopped there');
  expect(out).toContain('retry <milestoneId>');
  expect(out).not.toContain('planned again automatically on the next run');
});

test('run tightens a scaffolded gate the day the project grows tests', async () => {
  /*
   * The greenfield path, end to end. `sa new` writes a syntax-only check
   * because a brand-new project has nothing to test; the first task it is given
   * writes tests; and until 2026-08-26 nothing closed that loop except a person
   * reading a `doctor` warning and editing YAML.
   *
   * example-api lived in exactly that state for three days with three failing
   * tests being waved through. A project built from an idea unattended would
   * reach it on its first task and never leave.
   */
  const repo = await scratchRepo('gate-grows');
  const cfgDir = join(dir, 'cfg-gate-grows');
  const db = dbFile('gate-grows.db');
  writeConfig(cfgDir, repo);

  // A python project with a real test in it, and a config that still says the
  // check is the floor.
  const floor = 'python -m compileall -q -x "(node_modules|[.]venv|[.]next)" .';
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'test_smoke.py'), 'def test_ok():\n    assert True\n');
  writeFileSync(
    join(cfgDir, 'repos.yaml'),
    `repos:\n  - id: scratch\n    path: ${repo.replace(/\\/g, '/')}\n` +
      `    branch: main\n    stack: python\n    verify_cmd: '${floor}'\n` +
      `    enabled: true\n    weight: 1\n`,
  );

  const { out } = await runCli(['run', '--dry'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  // --dry says what it would do and changes nothing, like every other thing
  // this command decides.
  expect(out).toMatch(/has tests now; would tighten/);
  expect(readFileSync(join(cfgDir, 'repos.yaml'), 'utf8')).not.toContain('pytest');

  const real = await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  const after = readFileSync(join(cfgDir, 'repos.yaml'), 'utf8');
  expect(after, real.out).toContain('pytest');
  expect(after).toContain('- id: scratch');
});

test('run leaves a check the owner wrote by hand exactly as it is', async () => {
  /*
   * suggestedGate is documented as never loosening a gate, because "a gate
   * someone chose by hand is theirs". Applying its suggestion automatically
   * would break that promise for anyone who has touched this line - so the
   * automatic path fires only when the command is still EXACTLY the stack
   * floor, the one value nobody chose.
   */
  const repo = await scratchRepo('gate-handwritten');
  const cfgDir = join(dir, 'cfg-gate-handwritten');
  const db = dbFile('gate-handwritten.db');
  writeConfig(cfgDir, repo);

  const mine = 'python -m compileall -q . && echo mine';
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'test_smoke.py'), 'def test_ok():\n    assert True\n');
  writeFileSync(
    join(cfgDir, 'repos.yaml'),
    `repos:\n  - id: scratch\n    path: ${repo.replace(/\\/g, '/')}\n` +
      `    branch: main\n    stack: python\n    verify_cmd: '${mine}'\n` +
      `    enabled: true\n    weight: 1\n`,
  );

  await runCli(['run'], { SHANAUTO_DB: db, SHANAUTO_CONFIG: cfgDir });

  expect(readFileSync(join(cfgDir, 'repos.yaml'), 'utf8')).toContain(`verify_cmd: '${mine}'`);
});
