import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as logger from '../../logger.js';
import type { AppConfig } from '../../config.js';
import type { TaskRow } from '../../schemas.js';

/**
 * Orchestration tests with a fake agent, a fake gate and a fake ledger.
 *
 * Everything the run touches for real — git, the provider, the database — is
 * replaced, because the two faults these guard were both invisible to a green
 * suite and only appeared during live runs on 2026-08-08.
 */

const h = vi.hoisted(() => ({
  calls: {
    status: [] as { id: string; status: string; reason?: string }[],
    remembered: [] as { kind: string; reason?: string }[],
    journal: [] as { stage: string; detail: string }[],
    rollbacks: [] as string[],
    refunds: [] as string[],
    dispatched: [] as string[],
    /** Task ids the attempt counter was moved for, one entry per charge. */
    bumps: [] as string[],
    /** Every dispatch billed, so a discarded one can be told from a lost one. */
    costs: [] as { id: string; units: number }[],
    /** Which repos the end-of-run stash read was asked about. */
    stashReads: [] as string[][],
    /** Repos whose reverted tree was re-checked, in order. */
    rechecks: [] as string[],
    /** Repair jobs queued mid-run, with the brief each was given. */
    repairs: [] as { repo: string; brief?: string }[],
    /** What the baseline cache was told once the answer was measured. */
    baselineSet: [] as { repo: string; green: boolean }[],
    /** Repos asked to revive work reverted for somebody else failure. */
    reopened: [] as string[],
    /** Briefs written to the ledger, so a re-used one can be told from a fresh one. */
    briefs: [] as { id: string; brief: string }[],
    /** The brief each dispatch actually carried, undefined for none. */
    agentBriefs: [] as (string | undefined)[],
    /**
     * The originating idea each dispatch carried, in order.
     *
     * Recorded from the execute ARGUMENT, like agentBriefs and for the same
     * reason: the ledger lookup passing is not the claim. The claim is that
     * what it returned reached the agent, and a redispatch is a second chance
     * to drop it.
     */
    agentIdeas: [] as ({ title: string; body: string } | null | undefined)[],
    /**
     * The prompt the senior was handed to write each brief.
     *
     * `briefs` records what came back and `agentBriefs` what the intern got.
     * Neither can see what the senior was TOLD, which is where finding AE
     * lived: the drift verdict was right, the log line was right, and the
     * sentence never travelled any further than the operator's terminal.
     */
    briefPrompts: [] as string[],
    /** The rework text each dispatch carried. Undefined on a first attempt. */
    agentRework: [] as (string | undefined)[],
    /** One entry per review the senior was actually asked for. */
    reviews: [] as { id: string; patch: string }[],
    /** Paths workingPatch was asked to render, so an empty diff can be told apart. */
    patchReads: [] as string[][],
    /** Every commitMessage argument list, so what reached the subject line is checkable. */
    commitMsgs: [] as unknown[][],
    /**
     * Task ids the gate was asked about, in order.
     *
     * The verdict was always readable through what followed it; whether the
     * question was ever PUT was not. Finding AJ was exactly that: a tree with
     * four changed files in it, reverted without the gate being asked anything.
     */
    gates: [] as string[],
  },
  state: {
    stopRequested: false,
    /** Task ids reopenUnrelatedFailures hands back, per repo. */
    reopens: {} as Record<string, string[]>,
    committedToday: 0,
    /**
     * What ledger.ideaForTask hands back for every task.
     *
     * Null by default, which is the honest default: it is what the real one
     * returns for a task with no milestone, an orphaned milestone, or a repo
     * seeded straight into the backlog. Every test written before the idea
     * existed therefore asserts against the unchanged prompt.
     */
    idea: null as { title: string; body: string } | null,
    /** Reset the day's count once this many commits land, i.e. the clock rolls over. */
    midnightAfter: 0,
    exec: {} as Record<string, unknown>,
    /**
     * Results handed out one per dispatch, ahead of `exec`.
     *
     * Empty by default: every test written before a task could be dispatched
     * more than once per attempt gets the single fixed answer it expects.
     */
    execQueue: [] as unknown[],
    gate: {} as Record<string, unknown>,
    /** Per-task gate verdicts, so one task can fail while the next one commits. */
    gateFor: {} as Record<string, unknown>,
    // F2: make execute/gate throw, so the runBatch catch path is exercised.
    execThrow: undefined as Error | undefined,
    gateThrow: undefined as Error | undefined,
    /** Per-task routing. Absent means the default single agent, as before. */
    route: {} as Record<string, string>,
    /**
     * Who else could take a task if its routed agent goes out — the pool-mate
     * the real router falls back to. Empty by default, so every test written
     * before the fallback existed still reads as "this agent or nobody".
     */
    poolMate: {} as Record<string, string>,
    /** Per-agent results, so one provider can fail while another works. */
    execFor: {} as Record<string, unknown>,
    /**
     * What a mid-run refill finds waiting. Empty by default, which is what every
     * test predating the red-repo work assumed.
     */
    refillWith: [] as unknown[],
    /** What the end-of-run stash read finds. Nothing set aside, by default. */
    stashes: [] as unknown[],
    /**
     * What git says is sitting in the worktree when a dead session is looked at.
     *
     * Empty by default, which is what every test written before the salvage
     * path existed means by "the agent failed": nothing to judge, so the old
     * revert-and-charge behaviour is what they still assert.
     */
    diff: { files: [] as string[], insertions: 0, deletions: 0, renames: 0 },
    /** Makes the worktree unreadable, so a git that cannot answer is exercised. */
    diffThrow: undefined as Error | undefined,
    /**
     * What the repo's own check says once the task has been reverted out of it.
     *
     * Green by default: the task was the cause, which is the ordinary case and
     * what every test written before this existed assumed.
     */
    recheckGreen: true,
    /** Makes the senior unreachable, so the fallback to the plain instruction is exercised. */
    brainThrow: undefined as Error | undefined,
    /** What the senior hands back when it is reachable. */
    brief: {} as unknown,
    /** The verdict the senior returns when asked to review. */
    review: { verdict: 'ship', summary: 'looks right', findings: [] } as unknown,
    /** The diff the reviewer is shown. Empty means git had nothing to render. */
    patch: 'diff --git a/src/a.ts b/src/a.ts' as string,
    /** Which attempt this is. 2 == max_attempts in the fixture, i.e. the last one. */
    attempt: 1,
    /** Makes the review itself unusable - the brain gave up repairing it. */
    reviewThrow: undefined as Error | undefined,
    /** What a task's own journal thread says, keyed by task id. */
    thread: {} as Record<string, string>,
    /*
     * The staleness inputs. Null claim is what this file has always returned,
     * and it short-circuits assessTaskStaleness on its first line - so every
     * test that does not set these reaches the dispatch exactly as before.
     */
    /*
     * What `git.rollback` reports back. It returned void until 2026-08-31 and
     * the retry note described its work anyway — see `treeNote`. The default is
     * the ordinary case: the failed attempt HAD written something, and it was
     * reverted and stashed.
     */
    rollback: { reverted: 2, stash: 'shanauto-rollback X', skipped: false } as
      | { reverted: number; stash: string | null; skipped: boolean }
      | null,
    claim: null as Record<string, unknown> | null,
    /*
     * What `checkDropClaim` says. Mocked rather than driven through real files
     * because the two questions are separate: whether the check READS the tree
     * correctly is dropcheck.test.ts's job, against real files on disk; what the
     * executor DOES with each verdict is this file's, and it has no repo.
     */
    dropCheck: { verdict: 'unchecked', evidence: 'nothing was declared' } as
      | { verdict: 'unchecked'; evidence: string }
      | { verdict: 'confirmed'; evidence: string }
      | { verdict: 'contradicted'; missing: string[]; evidence: string },
    head: 'head' as string,
    commits: [] as { sha: string }[],
    resolutions: [] as Record<string, unknown>[],
    /** The task a drifting commit belongs to, or null for a hand edit. */
    priorTask: null as Record<string, unknown> | null,
    /** Makes workingPatch itself fail, which must still ship. */
    patchThrow: undefined as Error | undefined,
    /**
     * Who the brain says produced its last answer.
     *
     * Undefined by default, which is what a driver that cannot tell reports and
     * what every test predating the attribution assumed.
     */
    answered: undefined as { model: string; fallback: boolean } | undefined,
  },
}));

vi.mock('../../ledger.js', () => ({
  getClaim: () => h.state.claim,
  resolutionsForShas: () => h.state.resolutions,
  getTask: () => h.state.priorTask,
  setStatus: (id: string, status: string, reason?: string) =>
    h.calls.status.push({ id, status, reason }),
  bumpAttempt: (id: string) => {
    h.calls.bumps.push(id);
    return h.state.attempt;
  },
  refundAttempt: (id: string) => h.calls.refunds.push(id),
  markCommitted: () => {
    h.state.committedToday++;
    if (h.state.midnightAfter && h.state.committedToday >= h.state.midnightAfter) {
      h.state.committedToday = 0;
    }
  },
  committedToday: () => h.state.committedToday,
  remember: (r: { kind: string; reason?: string }) => h.calls.remembered.push(r),
  addResolution: () => undefined,
  setTaskBrief: (id: string, brief: string) => h.calls.briefs.push({ id, brief }),
  ideaForTask: () => h.state.idea,
  // Cost accounting, added on the branch that landed alongside this test. A
  // module mock is exhaustive — an export it omits does not fall through to the
  // real one, it throws — so the executor's spend recording surfaced here as
  // eight unrelated failures rather than as a missing mock.
  recordAgentCost: (_run: string, units: number, id: string) =>
    h.calls.costs.push({ id, units }),
  agentSpendForDay: () => ({ units: null, dispatches: 0, unknown: 0 }),
  reopenUnrelatedFailures: (repo: string) => {
    h.calls.reopened.push(repo);
    return h.state.reopens[repo] ?? [];
  },
}));

vi.mock('../../git.js', () => ({
  ensureClean: async () => undefined,
  // Read by the brief author. A module mock is exhaustive, so its absence made
  // authorBrief throw and briefFor swallow it - which is how every test in this
  // file ran for months without one brief ever being written.
  fileTree: async () => 'app/api/search.py\napp/services/hybrid_search.py',
  headSha: async () => h.state.head,
  commitsBetween: async () => h.state.commits,
  rollback: async (_repo: unknown, _paths?: string[], why?: string) => {
    // The reason is recorded, not just the fact: it becomes the stash label,
    // and a pile of identically-named stashes is what O24 is about.
    h.calls.rollbacks.push(why ?? 'rollback');
    return h.state.rollback;
  },
  commitAndPush: async () => ({ sha: 'abcdef1234567890', pushed: true }),
  commitMessage: (...a: unknown[]) => {
    h.calls.commitMsgs.push(a);
    return 'chore: test';
  },
  diffStat: async () => {
    if (h.state.diffThrow) throw h.state.diffThrow;
    return h.state.diff;
  },
  workingPatch: async (_r: unknown, paths: string[]) => {
    if (h.state.patchThrow) throw h.state.patchThrow;
    h.calls.patchReads.push(paths);
    return { text: h.state.patch, truncated: false, fullLength: h.state.patch.length };
  },
  stashSummary: async (repos: { id: string }[]) => {
    h.calls.stashReads.push(repos.map((r) => r.id));
    return h.state.stashes;
  },
}));

vi.mock('../verifier.js', async (orig) => ({
  /*
   * Three pure helpers taken from the real module rather than stubbed. The
   * review runs the changed files through the first two to mark the ones the
   * plan never asked for, and the commit path asks the third whether the diff
   * was all tests. A hand-written stand-in would be a mock deciding what
   * "declared" and "a test" mean — the things these comparisons exist to answer.
   */
  declaredFiles: (await orig<typeof import('../verifier.js')>()).declaredFiles,
  normPath: (await orig<typeof import('../verifier.js')>()).normPath,
  isTestPath: (await orig<typeof import('../verifier.js')>()).isTestPath,
  gate: async (_cfg: unknown, t: { id: string }) => {
    h.calls.gates.push(t.id);
    if (h.state.gateThrow) throw h.state.gateThrow;
    return h.state.gateFor[t.id] ?? h.state.gate;
  },
  // Measured once per repo per run: was the project already passing its own
  // check before anything was attempted? Green here, so the size floor stays in
  // force for these tests exactly as it did before.
  baselineGreen: async () => true,
  // Asked on the failure path only, and only when the REPO's check was the half
  // that failed: does it still fail with this task reverted back out of it?
  recheckRepo: async (_cfg: unknown, r: { id: string }) => {
    h.calls.rechecks.push(r.id);
    return {
      green: h.state.recheckGreen,
      // The real one returns the suite's own output, which is what makes it
      // usable as a repair brief without paying to run the suite again.
      out: h.state.recheckGreen
        ? ''
        : 'FAILED tests/api/test_stats.py::test_popular_documents_endpoint\n1 failed, 133 passed',
    };
  },
  resetBaselineCache: () => undefined,
  setBaselineCache: (repo: string, green: boolean) =>
    h.calls.baselineSet.push({ repo, green }),
}));
/*
 * Partial: holdBlockedWork is pure and doing its real work here is the point,
 * but ensureRepairTask would want a live ledger and a real test suite to run.
 */
// Partial, like the two above it: the executor wants one symbol from here and
// the staleness path calls it before reading anything, but the real one talks
// to git and the database.
// Partial: the executor's other readers of this module stay real, but the
// symbol list is read off the working tree and there is no tree here.
vi.mock('../context.js', async (orig) => ({
  ...((await orig()) as object),
  apiSurface: async () => 'def search_user_documents\ndef combine_scores',
}));

vi.mock('../dropcheck.js', async (orig) => ({
  ...(await orig<typeof import('../dropcheck.js')>()),
  checkDropClaim: () => h.state.dropCheck,
}));

vi.mock('../ingest.js', async (orig) => ({
  ...((await orig()) as object),
  ingestCommits: async () => undefined,
}));

vi.mock('../repair.js', async (orig) => ({
  ...(await orig<typeof import('../repair.js')>()),
  ensureRepairTask: async (_cfg: unknown, r: { id: string }, brief?: string) => {
    h.calls.repairs.push({ repo: r.id, brief });
    return { detail: brief ?? '', taskId: 'REPAIR1' };
  },
}));
vi.mock('../allocator.js', () => ({ selectBatch: () => h.state.refillWith }));
vi.mock('../router.js', () => ({
  pickAgent: (_cfg: unknown, t: { id: string }) => h.state.route[t.id] ?? 'agy',
  /*
   * Mirrors the real reroute: the stable pick unless it is out, then a pool-mate
   * if this task has one, then null. Null is the "nobody eligible is left"
   * signal that stops the run.
   */
  reroute: (_cfg: unknown, t: { id: string }, out: ReadonlySet<string>) => {
    const first = h.state.route[t.id] ?? 'agy';
    if (!out.has(first)) return first;
    const mate = h.state.poolMate[t.id];
    return mate && !out.has(mate) ? mate : null;
  },
}));
vi.mock('../journal.js', () => ({
  appendEntry: (e: { stage: string; detail: string }) => h.calls.journal.push(e),
  readRecent: () => '',
  // The shared tail and the task's own thread are separate reads on purpose:
  // this one answers "why was I sent back", and the other cannot promise to.
  readTaskThread: (id: string) => h.state.thread[id] ?? '',
}));
vi.mock('../../drivers/registry.js', () => ({
  makeBrain: async () => {
    if (h.state.brainThrow) throw h.state.brainThrow;
    return {
      id: 'agy',
      // Read by the executor straight after each ask, like the real drivers.
      get answered() {
        return h.state.answered;
      },
      init: async () => undefined,
      // The executor asks this same brain for two different things. Keying on
      // the label is how the real driver's caller tells them apart too, and a
      // mock that returned a brief to a review request would make every QA
      // test pass against a schema mismatch the real run would hit.
      ask: async (text: string, _schema: unknown, label: string) => {
        if (label.startsWith('review-')) {
          h.calls.reviews.push({ id: label.slice('review-'.length), patch: text });
          if (h.state.reviewThrow) throw h.state.reviewThrow;
          return h.state.review;
        }
        h.calls.briefPrompts.push(text);
        return h.state.brief;
      },
      dispose: async () => undefined,
    };
  },
  makeAgent: async (_cfg: unknown, id: string) => ({
    id,
    kind: 'cli',
    // Recorded per agent so a test can prove a dead provider was never asked
    // again — a skipped task and a dispatched-then-failed one are easy to
    // confuse in a summary and mean opposite things about spend.
    execute: async (
      t: { id: string; brief?: string | null },
      _repo?: unknown,
      _timeoutS?: number,
      _context?: string,
      rework?: string,
      idea?: { title: string; body: string } | null,
    ) => {
      h.calls.dispatched.push(`${id}:${t.id}`);
      h.calls.agentRework.push(rework || undefined);
      // Mirrors what the real drivers send: `task.brief ?? undefined`. Asserting
      // on the row value instead would pass while the drivers were broken.
      h.calls.agentBriefs.push(t.brief ?? undefined);
      h.calls.agentIdeas.push(idea);
      if (h.state.execThrow) throw h.state.execThrow;
      if (h.state.execQueue.length) return h.state.execQueue.shift();
      return h.state.execFor[id] ?? h.state.exec;
    },
    healthCheck: async () => ({ ok: true, detail: '' }),
  }),
}));

const { runBatch, detectBlocked, saysAlreadyDone, netFailed, priorWorkNote, keepTrying } = await import(
  '../executor.js'
);

/*
 * These tests decide whether the run should stop; they do not ask the machine.
 * runBatch used to read state/KILLSWITCH directly, so PAUSING the system made
 * eight of them fail — the suite reported a fault in the code when the only
 * thing that had changed was the owner pressing pause.
 */
const stop = () => h.state.stopRequested;

function config(over: Record<string, unknown> = {}): AppConfig {
  return {
    system: {
      daily_target: 100,
      max_daily_commits: 3,
      work_hours: { start: '00:00', end: '23:59' },
      timeouts: { task_s: 60, verify_s: 60, brain_s: 60 },
      limits: {
        max_attempts: 2,
        max_files_per_task: 4,
        min_insertions: 3,
        scope_blowout_multiplier: 2,
        max_run_hours: 8,
        forbid_dead_exports: false,
      },
      ...over,
    },
    drivers: { routing: { brief_for: [], qa_for: [] } },
    repos: [{ id: 'r1', path: 'D:/nowhere', branch: 'main', stack: 'typescript', verify_cmd: 'echo ok', enabled: true, weight: 1 }],
  } as unknown as AppConfig;
}

function task(n: number): TaskRow {
  return {
    id: `T${n}`,
    milestone_id: null,
    repo: 'r1',
    title: `task ${n}`,
    kind: 'feature',
    instruction: 'do it',
    acceptance: 'done',
    files_hint: '[]',
    verify_cmd: 'echo ok',
    depends_on: '[]',
    est_lines: 10,
    executor_hint: 'cli',
    status: 'ready',
    attempts: 0,
    last_error: null,
    commit_sha: null,
    brief: null,
    ord: n,
    created_at: '',
    updated_at: '',
  } as TaskRow;
}

const NO_CHANGES = {
  ok: false,
  failure: 'NO_CHANGES',
  detail: 'agent produced no file changes',
  diff: { files: [], insertions: 0, deletions: 0 },
};
const GATE_OK = {
  ok: true,
  detail: '1 file(s), +5/-0',
  diff: { files: ['src/a.ts'], insertions: 5, deletions: 0 },
};

beforeEach(() => {
  h.calls.status = [];
  h.calls.remembered = [];
  h.calls.commitMsgs = [];
  h.calls.journal = [];
  h.calls.rollbacks = [];
  h.calls.refunds = [];
  h.calls.dispatched = [];
  h.calls.stashReads = [];
  h.calls.rechecks = [];
  h.calls.reopened = [];
  h.state.reopens = {};
  h.calls.briefs = [];
  h.calls.briefPrompts = [];
  h.calls.agentBriefs = [];
  h.calls.agentIdeas = [];
  h.state.idea = null;
  h.state.rollback = { reverted: 2, stash: 'shanauto-rollback X', skipped: false };
  h.state.claim = null;
  h.state.dropCheck = { verdict: 'unchecked', evidence: 'nothing was declared' };
  h.state.head = 'head';
  h.state.commits = [];
  h.state.resolutions = [];
  h.state.priorTask = null;
  h.calls.agentRework = [];
  h.state.thread = {};
  h.state.brainThrow = undefined;
  h.calls.reviews = [];
  h.calls.patchReads = [];
  h.state.review = { verdict: 'ship', summary: 'looks right', findings: [] };
  h.state.patch = 'diff --git a/src/a.ts b/src/a.ts';
  h.state.patchThrow = undefined;
  h.state.answered = undefined;
  h.state.reviewThrow = undefined;
  // Same reason as refillWith below: a test that made this count up per call
  // left a getter here, and a plain assignment over one throws in the NEXT
  // test's setup, reporting the fault against the wrong test.
  Object.defineProperty(h.state, 'attempt', { configurable: true, writable: true, value: 1 });
  h.calls.repairs = [];
  h.calls.baselineSet = [];
  h.state.recheckGreen = true;
  h.state.stashes = [];
  h.state.route = {};
  h.state.poolMate = {};
  h.state.execFor = {};
  // A test may have replaced this with a getter-only sequence to make refill
  // return something different each call. Assigning over that throws, and the
  // failure lands in the NEXT test setup, pointing at the wrong test entirely.
  Object.defineProperty(h.state, 'refillWith', { configurable: true, writable: true, value: [] });
  h.state.stopRequested = false;
  h.state.committedToday = 0;
  h.state.midnightAfter = 0;
  h.state.gate = NO_CHANGES;
  h.state.gateFor = {};
  h.state.exec = { ok: true, stdout: 'all done', durationMs: 1000 };
  h.state.execQueue = [];
  h.calls.bumps = [];
  h.calls.costs = [];
  h.state.execThrow = undefined;
  h.state.gateThrow = undefined;
  h.calls.gates = [];
  h.state.diff = { files: [], insertions: 0, deletions: 0, renames: 0 };
  h.state.diffThrow = undefined;
});

describe('detectBlocked', () => {
  it('names the tool agy said it was refused', () => {
    const b = detectBlocked({
      reason: 'PERMISSION_DENIED',
      stdout: 'Tool `run_command` requires a permission that headless mode cannot prompt for.',
    });
    expect(b?.permissions).toEqual(['run_command']);
  });

  it('names it from the sentence agy really writes, not the one we imagined', () => {
    /*
     * Byte-for-byte from data/artifacts, run Rqz8ynvkv54 on 2026-08-15. Both
     * blocked tasks that run were reported to the operator as "the driver could
     * not name it" while the word `command` sat in quotes in the output. The
     * test above this one passed throughout, because it asserts against a
     * sentence shape agy does not produce.
     */
    const real =
      'jetski: no output produced — a tool required the "command" permission that ' +
      'headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under ' +
      'permissions.allow in settings.json (e.g. command(<target>)). Alternatively, ' +
      're-run with --dangerously-skip-permissions to auto-approve all tools.';
    const b = detectBlocked({ reason: 'PERMISSION_DENIED', stdout: real });
    expect(b?.permissions).toEqual(['command']);
    expect(b?.detail).toContain('command');
    expect(b?.detail).not.toContain('could not name it');

    /*
     * And it has to be a PERMISSION, not any quoted noun in the neighbourhood.
     * Agents narrate; "required the X" is ordinary prose. Naming the wrong
     * thing is worse than naming nothing, because the operator would go and
     * allow-list it. A looser pattern passes the assertion above and fails here.
     */
    const prose = detectBlocked({
      reason: 'PERMISSION_DENIED',
      stdout: 'The change required the "documents.py" module to be imported first.',
    });
    expect(prose?.permissions).toEqual([]);
  });

  it('prefers the commands the copilot stream already collected', () => {
    const b = detectBlocked({ stdout: 'wrote nothing', deniedTools: ['pytest tests/', 'npm i'] });
    expect(b?.permissions).toEqual(['pytest tests/', 'npm i']);
    expect(b?.detail).toContain('2 tool permission(s)');
  });

  /*
   * Run 17, task Tnh94ojojey: denied `bash: Get-ChildItem -Name` AND a `write`
   * under the temp directory. The count said 2 and the field carried the first,
   * so the report named one - and the one it dropped is the refusal that pushes
   * opencode onto writing files through bash heredocs. Keeping both is the
   * whole of this fix; the assertion above used to say `toBe('pytest tests/')`.
   */
  it('keeps every refused command, not the first one and a count', () => {
    const b = detectBlocked({
      stdout: 'wrote nothing',
      deniedTools: ['bash: Get-ChildItem -Name', 'write: C:\\Temp\\opencode\\check_db.py'],
    });
    expect(b?.permissions).toHaveLength(2);
    expect(b?.permissions[1]).toContain('check_db.py');
  });

  /*
   * `detail` is the one line that goes in a task status and a log warning, so
   * it stays short - but it says when it is short, rather than leaving the
   * reader to compare it against a count printed earlier in the same sentence.
   */
  it('admits it when the one-line form has left some out', () => {
    const b = detectBlocked({ stdout: '', deniedTools: ['a', 'b', 'c', 'd', 'e'] });
    expect(b?.permissions).toHaveLength(5);
    expect(b?.detail).toContain('+2 more');
  });

  it('still reports a refusal it cannot name', () => {
    const b = detectBlocked({ reason: 'PERMISSION_DENIED', stdout: 'auto-denied' });
    expect(b).not.toBeNull();
    expect(b?.permissions).toEqual([]);
  });

  it('does not call an ordinary empty result blocked', () => {
    expect(detectBlocked({ ok: true, stdout: 'I had nothing to do' } as never)).toBeNull();
  });
});

describe('a task the agent was refused permission to do', () => {
  beforeEach(() => {
    h.state.exec = {
      ok: true,
      stdout: 'Tool `pytest` requires a permission that headless mode cannot prompt for.',
      durationMs: 1000,
      reason: 'PERMISSION_DENIED',
    };
  });

  it('is reported as BLOCKED, not as an agent that produced nothing', async () => {
    /*
     * Refilled so the task gets the second dispatch it now earns: a refusal is
     * fed back rather than abandoned (see refusalNote), and what ends it is
     * being refused the SAME thing twice. The final status is still `failed`.
     */
    h.state.refillWith = [task(1)];
    const sum = await runBatch(config(), [task(1)], stop);

    // `failed` counts dispatches and is netted against `sentBack`; one refused
    // task retried once is two of the first and one real failure.
    expect(netFailed(sum)).toBe(1);
    expect(sum.blocked).toBe(1);
    expect(sum.blockedBy).toEqual(['pytest']);

    const status = h.calls.status.find((s) => s.status === 'failed');
    expect(status?.reason).toMatch(/^BLOCKED/);
    expect(status?.reason).toContain('pytest');
  });

  /*
   * The same drop, on the list the report turns into the operator's to-do. One
   * task refused two things is two entries to add; the dedupe is there for the
   * other case, seventeen tasks refused the same one.
   */
  it('carries every refused command onto the list the operator works from', async () => {
    h.state.exec = {
      ...h.state.exec,
      deniedTools: ['bash: Get-ChildItem -Name', 'write: check_db.py'],
    };
    // As above: each of the two is offered again and refused identically.
    h.state.refillWith = [task(1), task(2)];
    const sum = await runBatch(config(), [task(1), task(2)], stop);

    expect(sum.blocked).toBe(2);
    expect(sum.blockedBy).toEqual(['bash: Get-ChildItem -Name', 'write: check_db.py']);

    // And the one line the operator reads down the run names both as well.
    const status = h.calls.status.find((s) => s.status === 'failed');
    expect(status?.reason).toContain('bash: Get-ChildItem -Name');
    expect(status?.reason).toContain('write: check_db.py');
  });

  it('says so in the ledger memory, so the next planner sees the real cause', async () => {
    /*
     * Refilled so the task gets the second dispatch it now earns: a refusal is
     * fed back rather than abandoned (see refusalNote), and what ends it is
     * being refused the SAME thing twice. The final status is still `failed`.
     */
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);
    const mem = h.calls.remembered.find((r) => r.kind === 'gate_rejection');
    expect(mem?.reason).toContain('BLOCKED');
    expect(mem?.reason).toContain('pytest');
  });

  it('says so in the work journal, including on the result line that read "ok"', async () => {
    await runBatch(config(), [task(1)], stop);
    const gateEntry = h.calls.journal.find((e) => e.stage === 'gate');
    expect(gateEntry?.detail).toContain('BLOCKED');
    const resultEntry = h.calls.journal.find((e) => e.stage === 'result');
    expect(resultEntry?.detail).toContain('BLOCKED');
  });

  /*
   * The point of retrying a refusal at all. Telling the agent it was refused
   * `pytest` is the only thing that lets the next attempt do anything other
   * than walk into it again, so if this note is not written the retry is worth
   * nothing and the old carve-out was right.
   */
  it('tells the next attempt what refused it', async () => {
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note');
    expect(note?.detail).toContain('REFUSED');
    expect(note?.detail).toContain('pytest');
    // And what to do instead, which is the actionable half.
    expect(note?.detail).toMatch(/your own tools/i);
  });

  /*
   * The other half of "the agent wrote nothing". A refusal gets refusalNote; an
   * agent that was refused nothing and still wrote nothing gets told which of
   * the two endings this task has, because it took neither.
   */
  it('tells an agent that changed nothing which two endings it had', async () => {
    h.state.exec = { ok: true, stdout: 'I read the code. It looks fine.', durationMs: 1000 };
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note');
    expect(note?.detail).toContain('ALREADY_DONE');
    expect(note?.detail).toMatch(/changed no files/i);
  });

  it('does not say it to an agent that was refused a tool', async () => {
    /*
     * A blocked agent's NO_CHANGES is a symptom of the refusal, not a choice it
     * made between two endings. Telling it to consider saying ALREADY_DONE
     * would be advice about the wrong problem.
     */
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);

    const notes = h.calls.journal.filter((e) => e.stage === 'note');
    expect(notes.some((n) => /REFUSED/.test(String(n.detail)))).toBe(true);
    expect(notes.some((n) => /which two endings|changed no files/i.test(String(n.detail)))).toBe(
      false,
    );
  });

  /*
   * What the note may CLAIM about the attempt it is describing.
   *
   * Traced from the real thing on 2026-08-30. Task T4uxha4ldlc was refused
   * `cd /d D:\repos\example-tracker`, then carried on, ran a different
   * check, and finished — having written both files it was asked for. The first
   * version of this note opened by telling it its turn had ended and nothing
   * was written. Two false sentences at the top of the one message in the whole
   * prompt that exists to be believed, and nothing here caught them: the tests
   * asked what the note CONTAINED and never what it ASSERTED.
   */
  it('does not tell an agent that finished that its turn ended', async () => {
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('REFUSED');
    expect(note.detail).not.toMatch(/turn ended/i);
    expect(note.detail).not.toMatch(/nothing was written/i);
    // And says the true thing in its place.
    expect(note.detail).toMatch(/carried on afterwards and finished/i);
  });

  it('does tell one that really was cut off, because that one is true', async () => {
    /*
     * The pre-gate path: refused AND stopped there, which is the case the
     * original wording described and the only one it was ever true of.
     * `deniedTools` because detectBlocked reads free text only when the driver
     * itself reported PERMISSION_DENIED, and this agent died mid-work instead.
     */
    h.state.exec = {
      ok: false,
      reason: 'INCOMPLETE',
      stdout: 'I was going to run the tests',
      deniedTools: ['bash: pytest'],
      durationMs: 1000,
    };
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toMatch(/turn ended/i);
    expect(note.detail).toMatch(/nothing was written/i);
  });

  it('says nothing of the sort on a rejection that was not a refusal', async () => {
    h.state.exec = { ok: true, stdout: 'I looked and did nothing', durationMs: 1000 };
    h.state.refillWith = [task(1)];
    await runBatch(config(), [task(1)], stop);

    const notes = h.calls.journal.filter((e) => e.stage === 'note');
    expect(notes.some((n) => /REFUSED/.test(String(n.detail)))).toBe(false);
  });

  /*
   * Two DIFFERENT refusals are progress — the agent routed around the first and
   * hit something else — so it keeps going. Same rule as every other failure;
   * the only reason to write it down is that this path used to be exempt.
   */
  it('keeps going while it is being refused something new each time', async () => {
    const refused = (name: string) => ({
      ok: true,
      stdout: `Tool \`${name}\` requires a permission that headless mode cannot prompt for.`,
      durationMs: 1000,
      reason: 'PERMISSION_DENIED',
    });
    // A different tool each time: the agent routed around the last wall and
    // found another, which is movement, so it is not stopped for repeating.
    h.state.execQueue = [refused('one'), refused('two'), refused('three')];
    h.state.refillWith = [task(1)];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched.length).toBeGreaterThan(2);
  });

  it('leaves an ordinary NO_CHANGES verdict alone', async () => {
    h.state.exec = { ok: true, stdout: 'I looked and did nothing', durationMs: 1000 };
    /*
     * "Out of chances" is a REPEATED failure now, not a spent counter — see
     * keepTrying. The task is re-offered so it fails the same way twice, which
     * is what ends it. Setting h.state.attempt no longer decides anything.
     */
    const t = task(1);
    h.state.refillWith = [t];
    const sum = await runBatch(config(), [t], stop);

    expect(sum.blocked).toBe(0);
    expect(sum.blockedBy).toEqual([]);
    expect(h.calls.status.find((s) => s.status === 'failed')?.reason).toMatch(/^NO_CHANGES/);
  });
});

/**
 * F2: runBatch's catch must treat an unexpected throw the way runOne treats a
 * gate rejection — the agent's edits cannot be left in the tree for the next
 * task to trip over. The ordinary rejection path rolls back inside runOne; this
 * is the path where the throw happens outside it.
 */
describe('an unexpected throw still rolls the tree back (F2)', () => {
  it('calls git.rollback when the agent throws, and counts the task failed', async () => {
    h.state.execThrow = new Error('agent exploded');

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.rollbacks).toHaveLength(1);
    expect(sum.failed).toBe(1);
    // 'running' is recorded first; the catch overwrites with 'failed'.
    expect(h.calls.status.filter((s) => s.id === 'T1').at(-1)?.status).toBe('failed');
  });

  it('calls git.rollback when the gate throws, and counts the task failed', async () => {
    h.state.exec = { ok: true, stdout: 'made the change', durationMs: 1000 };
    h.state.gateThrow = new Error('gate exploded');

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.rollbacks).toHaveLength(1);
    expect(sum.failed).toBe(1);
    expect(h.calls.status.filter((s) => s.id === 'T1').at(-1)?.status).toBe('failed');
  });

  it('does not roll back a second time for a gate rejection that returns, not throws', async () => {
    // NO_CHANGES (the default verdict) is ok:false: runOne rolls back in its own
    // failure branch, and runBatch's catch must not run on top of that.
    h.state.exec = { ok: true, stdout: 'made the change', durationMs: 1000 };

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.failed).toBe(1);
    expect(h.calls.rollbacks).toHaveLength(1);
  });
});

/**
 * On 2026-08-12 copilot's monthly allowance ran out and six tasks were sent into
 * it anyway. The stream parser has since been taught to recognise that (see
 * copilotstream.test.ts); this is what the run is supposed to DO about it.
 *
 * Three providers on three independent quotas is the whole design. One going out
 * must cost exactly the tasks routed to it, and nothing else.
 */
describe('an agent that runs out of quota mid-run', () => {
  const QUOTA_FATAL = {
    ok: false,
    fatal: true,
    stdout: 'You have exceeded your monthly quota — quota resets 2026-09-01T00:00:00Z',
    durationMs: 1000,
    reason: 'QUOTA',
  };

  beforeEach(() => {
    h.state.gate = GATE_OK;
    h.state.execFor = { copilot: QUOTA_FATAL };
  });

  it('gives back the attempt, because the provider never looked at the task', () => {
    // The counter moves before dispatch, which is right for anything the agent
    // did. A provider that refused to run reported premiumRequests: 0 — nothing
    // was spent, so charging a retry would punish the task for the outage.
    h.state.route = { T1: 'copilot' };
    return runBatch(config(), [task(1)], stop).then(() => {
      expect(h.calls.refunds).toEqual(['T1']);
      expect(h.calls.status.filter((s) => s.id === 'T1').at(-1)?.status).toBe('ready');
    });
  });

  it('keeps running the other providers instead of stopping the whole run', async () => {
    h.state.route = { T1: 'copilot', T2: 'agy', T3: 'agy' };

    const sum = await runBatch(config(), [1, 2, 3].map(task), stop);

    expect(sum.committed).toBe(2);
    expect(sum.stopped).toBeUndefined();
  });

  it('never dispatches to it again, rather than failing task after task', async () => {
    h.state.route = { T1: 'copilot', T2: 'agy', T3: 'copilot', T4: 'copilot' };

    const sum = await runBatch(config(), [1, 2, 3, 4].map(task), stop);

    expect(h.calls.dispatched).toEqual(['copilot:T1', 'agy:T2']);
    expect(sum.agentsOut[0]?.skipped).toBe(2);
  });

  it('leaves the skipped tasks exactly as it found them', async () => {
    h.state.route = { T1: 'copilot', T2: 'agy', T3: 'copilot' };

    await runBatch(config(), [1, 2, 3].map(task), stop);

    // Not failed, not parked, not touched at all: the next run picks T3 up as
    // though this one had never reached it.
    expect(h.calls.status.filter((s) => s.id === 'T3')).toEqual([]);
    expect(h.calls.refunds).not.toContain('T3');
  });

  it('does stop once nothing left has a live agent to run it', async () => {
    h.state.route = { T1: 'copilot', T2: 'copilot' };

    const sum = await runBatch(config(), [1, 2].map(task), stop);

    expect(sum.stopped).toMatch(/^FATAL: QUOTA/);
    expect(h.calls.dispatched).toEqual(['copilot:T1']);
  });

  /*
   * The live run of 2026-08-15, as a test.
   *
   * 4 ready jobs, all four routed to copilot by the stable hash, every one of
   * them also eligible for agy — the routing screen prints "(shared with agy)"
   * against each. copilot answered QUOTA on the first, and the run ended 38
   * seconds later having committed nothing, with agy healthy and idle and
   * copilot's quota 16 days from resetting.
   */
  it('hands the rest to the pool-mate instead of ending the run', async () => {
    h.state.route = { T1: 'copilot', T2: 'copilot', T3: 'copilot', T4: 'copilot' };
    h.state.poolMate = { T1: 'agy', T2: 'agy', T3: 'agy', T4: 'agy' };

    const sum = await runBatch(config(), [1, 2, 3, 4].map(task), stop);

    expect(h.calls.dispatched).toEqual(['copilot:T1', 'agy:T2', 'agy:T3', 'agy:T4']);
    expect(sum.stopped).toBeUndefined();
    expect(sum.committed).toBe(3);
    // Nothing was skipped: a task the pool can still run is not a task withheld.
    expect(sum.agentsOut[0]?.skipped).toBe(0);
  });

  it('does not announce a hand-over for a task the run then never reaches', async () => {
    /*
     * A real run on 2026-08-15 printed "copilot is out for this run — agy takes
     * it instead." and stopped on the operator's own stop request one line
     * later. Agy never touched that job. Deciding who would take it is not
     * doing it, and the operator reads these lines as a record of what happened.
     */
    h.state.route = { T1: 'copilot', T2: 'copilot' };
    h.state.poolMate = { T1: 'agy', T2: 'agy' };
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let asked = 0;
    try {
      const sum = await runBatch(config(), [1, 2].map(task), () => asked++ > 0);
      expect(sum.stopped).toBe('KILLSWITCH');
      expect(h.calls.dispatched).toEqual(['copilot:T1']);
      const said = info.mock.calls.map((c) => String(c[0]));
      expect(said.some((l) => l.includes('takes it instead'))).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  it('stops only when the pool-mate is out too', async () => {
    h.state.execFor = { copilot: QUOTA_FATAL, agy: { ...QUOTA_FATAL, reason: 'AUTH' } };
    h.state.route = { T1: 'copilot', T2: 'copilot' };
    h.state.poolMate = { T1: 'agy', T2: 'agy' };

    const sum = await runBatch(config(), [1, 2].map(task), stop);

    expect(h.calls.dispatched).toEqual(['copilot:T1', 'agy:T2']);
    expect(sum.stopped).toMatch(/^FATAL:/);
  });

  it('names the agent and carries the reset date through to the summary', async () => {
    h.state.route = { T1: 'copilot', T2: 'agy' };

    const sum = await runBatch(config(), [1, 2].map(task), stop);

    expect(sum.agentsOut).toHaveLength(1);
    expect(sum.agentsOut[0]?.agent).toBe('copilot');
    expect(sum.agentsOut[0]?.why).toContain('2026-09-01');
  });

  it('counts it as neither a failure nor a commit', async () => {
    h.state.route = { T1: 'copilot', T2: 'agy' };

    const sum = await runBatch(config(), [1, 2].map(task), stop);

    // A quota outage is not a task that failed. Recording it as one puts a
    // planning problem in the failure column and sends the search the wrong way.
    expect(sum.failed).toBe(0);
    expect(sum.committed).toBe(1);
  });

  it('takes each agent out separately', async () => {
    h.state.execFor = { copilot: QUOTA_FATAL, opencode: { ...QUOTA_FATAL, reason: 'AUTH' } };
    h.state.route = { T1: 'copilot', T2: 'opencode', T3: 'agy' };

    const sum = await runBatch(config(), [1, 2, 3].map(task), stop);

    expect(sum.agentsOut.map((a) => a.agent)).toEqual(['copilot', 'opencode']);
    expect(sum.committed).toBe(1);
  });
});

describe('the daily commit ceiling across midnight', () => {
  it('bounds one run even when the day count resets underneath it', async () => {
    // The day rolls over after two commits: without a run-scoped budget the loop
    // sees 0 of 3 again and keeps going until the queue runs dry.
    h.state.gate = GATE_OK;
    h.state.midnightAfter = 2;

    const sum = await runBatch(config(), [1, 2, 3, 4, 5, 6].map(task), stop);

    expect(sum.committed).toBe(3);
    expect(sum.stopped).toBe('RUN_CEILING');
  });

  it('still stops on the day count when the clock does not move', async () => {
    h.state.gate = GATE_OK;
    const sum = await runBatch(config(), [1, 2, 3, 4, 5].map(task), stop);

    expect(sum.committed).toBe(3);
    expect(sum.stopped).toBe('DAILY_CEILING');
  });

  it('gives a run only what the day has left, not a full budget', async () => {
    h.state.gate = GATE_OK;
    h.state.committedToday = 2; // an earlier run today already spent two

    const sum = await runBatch(config(), [1, 2, 3, 4].map(task), stop);
    expect(sum.committed).toBe(1);
  });

  it('lets the next run start again once the day genuinely resets', async () => {
    h.state.gate = GATE_OK;
    const first = await runBatch(config(), [1, 2, 3, 4].map(task), stop);
    expect(first.committed).toBe(3);

    h.state.committedToday = 0; // a new day, a new run
    const second = await runBatch(config(), [5, 6, 7, 8].map(task), stop);
    expect(second.committed).toBe(3);
  });
});

/**
 * The verbatim output that put a lie in the ledger on 2026-08-08. copilot was
 * asked for Document and Chunk models, found nothing to change, and said so —
 * using the token in a sentence refusing it. The whole-output regex matched, the
 * task was recorded "dropped — agent reported the work was already done", the
 * models were never written, and that false record then blocked the milestone
 * from being re-planned because dedupe correctly trusts known work.
 */
describe('saysAlreadyDone', () => {
  const REAL_DENIAL = [
    'I’ll check the existing model/migration/test layout first, then make the smallest possible change set.',
    'The repo layout differs from the task paths, so I’m locating the actual app structure first.',
    'No `app/` directory or Alembic files exist here, so this task is already satisfied only if there’s another branch.',
    '`ALREADY_DONE` is not accurate here: this workspace doesn’t contain the requested `app/` SQLAlchemy/Alembic structure at all, only the FastAPI `src/` app and unrelated tests.',
  ].join('\n');

  it('does not read a refusal of the token as a claim', () => {
    expect(saysAlreadyDone(REAL_DENIAL)).toBe(false);
  });

  it('accepts a plain closing claim', () => {
    expect(saysAlreadyDone('Checked every file.\nNothing to change.\nALREADY_DONE')).toBe(true);
  });

  it('accepts the spaced spelling the prompt also permits', () => {
    expect(saysAlreadyDone('Nothing to do here.\nALREADY DONE')).toBe(true);
  });

  it('ignores the token mentioned while thinking, then contradicted', () => {
    // The agent talks itself out of it. Only the conclusion counts.
    const s = [
      'I might report ALREADY_DONE if the models exist.',
      'They do not exist.',
      'I have created app/models/document.py instead.',
      'Done.',
    ].join('\n');
    expect(saysAlreadyDone(s)).toBe(false);
  });

  it('is not fooled by the task instruction being echoed back', () => {
    // Every prompt ends with "If the task is already satisfied, change nothing
    // and say ALREADY_DONE" — an agent that echoes its brief has claimed nothing.
    const s = 'My instructions said: if the task is already satisfied, say ALREADY_DONE.\nI could not complete it.\nStopping.';
    expect(saysAlreadyDone(s)).toBe(false);
  });

  it('says nothing about an empty result', () => {
    expect(saysAlreadyDone('')).toBe(false);
  });
});

/*
 * A project whose own check is failing gets one job — repair it — and its other
 * work waits, because the gate would reject all of it. The waiting was right;
 * the never-stopping-waiting was not.
 *
 * `repair.js` is deliberately NOT mocked here, so `holdBlockedWork` and
 * `isRepairTask` are the real ones.
 */
describe('a project that is repaired mid-run', () => {
  /** Titled so the real isRepairTask recognises it. */
  function repairTask(): TaskRow {
    return { ...task(0), id: 'Trepair', title: "Make the project's own check pass again (r1)" };
  }

  it('releases the work it was holding as soon as the repair lands', async () => {
    // 2026-08-12, run R4oyj70s3v2: attempted 1, committed 1 — the example-api
    // repair job — then `stopped because: batch exhausted` with 8 ready jobs
    // sitting in the same report's table. Repairing the repo is what made those
    // 8 runnable, and the run held every one of them back afterwards.
    h.state.gate = GATE_OK;
    h.state.refillWith = [repairTask(), task(1), task(2)];

    const sum = await runBatch(config(), [repairTask()], stop, new Set(['r1']));

    expect(h.calls.dispatched).toEqual(['agy:Trepair', 'agy:T1', 'agy:T2']);
    expect(sum.committed).toBe(3);
    expect(sum.held).toEqual([]);
  });

  it('keeps holding the work when the repair does not land', async () => {
    // The hold itself is correct and must survive: nothing else in a red repo
    // can pass the gate, so dispatching it spends a request to learn that.
    h.state.gate = NO_CHANGES;
    h.state.refillWith = [repairTask(), task(1), task(2)];

    const sum = await runBatch(config(), [repairTask()], stop, new Set(['r1']));

    // Two dispatches: a repair that produced nothing is asked again, and the
    // identical second failure is what ends it. The HOLD is what this proves.
    expect(h.calls.dispatched).toEqual(['agy:Trepair', 'agy:Trepair']);
    expect(sum.committed).toBe(0);
    expect(sum.held).toEqual([{ repo: 'r1', count: 2 }]);
  });

  it('reports held work instead of dropping it on the floor', async () => {
    // `refill` destructured `held` away entirely, so a run could withhold work
    // and finish with nothing anywhere saying it had. That is what made
    // "batch exhausted" beside "backlog ready: 8" unreadable.
    const sum = await runBatch(config(), [], stop, new Set(['r1']));
    h.state.refillWith = [task(1), task(2), task(3)];

    const sum2 = await runBatch(config(), [], stop, new Set(['r1']));

    expect(sum.held).toEqual([]); // nothing was waiting
    expect(sum2.held).toEqual([{ repo: 'r1', count: 3 }]);
    expect(h.calls.dispatched).toEqual([]); // and none of it was spent on
  });

  it('does not count work it went on to commit as held', async () => {
    // T2 is genuinely held at the first refill — the repo is still red — and
    // released at the next, once the repair lands. It must not appear in both
    // places. Counting held tasks as they arrive rather than tracking which are
    // STILL held would report the very work the run committed as work it
    // withheld, which is the same class of lie this whole finding is about.
    h.state.gateFor = { T1: NO_CHANGES, Trepair: GATE_OK, T2: GATE_OK };
    h.state.refillWith = [repairTask(), task(2)];

    const sum = await runBatch(config(), [task(1)], stop, new Set(['r1']));

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:Trepair', 'agy:T2']);
    expect(sum.committed).toBe(2);
    expect(sum.failed).toBe(1);
    expect(sum.held).toEqual([]);
  });

  it('leaves a healthy project alone', async () => {
    h.state.gate = GATE_OK;
    h.state.refillWith = [task(1), task(2)];

    const sum = await runBatch(config(), [task(1)], stop); // no red repos at all

    expect(sum.held).toEqual([]);
    expect(sum.committed).toBe(2);
  });
});

describe('what the run swept aside reaches the summary', () => {
  /*
   * The whole of finding 8 is that a stash nobody is told about is
   * indistinguishable from lost work. Reading the pile at the end of the run is
   * the only thing that carries it to the report, so the read is worth a test of
   * its own: without one, deleting the call leaves 871 green tests behind it.
   */
  const pile = { repo: 'r1', path: 'D:/nowhere', count: 2, files: ['notes.txt'], oldest: '2026-08-08' };

  it('carries the set-aside pile out of the run', async () => {
    h.state.gate = GATE_OK;
    h.state.stashes = [pile];

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.stashes).toEqual([pile]);
  });

  it('asks only about the projects the run actually touched', async () => {
    // Reading every configured repo would report a pile in a project this run
    // never went near, and there is no run to attribute it to.
    const cfg = config();
    (cfg.repos as unknown[]).push({ ...cfg.repos[0], id: 'r2' });
    h.state.gate = GATE_OK;

    await runBatch(cfg, [task(1)], stop);

    expect(h.calls.stashReads).toEqual([['r1']]);
  });

  it('says nothing when the run touched nothing', async () => {
    const sum = await runBatch(config(), [], stop);

    expect(sum.stashes).toEqual([]);
    expect(h.calls.stashReads).toEqual([[]]);
  });
});

/*
 * A project that goes red mid-run, on something no task in this run caused.
 *
 * Traced on 2026-08-20. Task Thbswhqeaoe was reverted and its four files
 * stashed because tests/api/test_stats.py failed — a test it never opened,
 * broken by rows example-api's own suite accumulates in app.db and never cleans
 * up, which ShanAuto pushed past the endpoint's limit by running that suite
 * four times in one run. The task was then marked `ready`, so the next run
 * would spend another agent request learning the same thing.
 *
 * The gate does not decide whose failure it was — it reports which half of the
 * check failed, and the answer is measured here, on a tree that has just been
 * reverted to exactly what it was before the agent touched it. Still red with
 * the task no longer in it means the task was never the cause.
 */
describe('a repo that goes red on something this run did not cause', () => {
  const BASE_FAIL = {
    ok: false,
    failure: 'VERIFY_FAIL',
    baseFailed: true,
    detail: "the repo's own check failed (python -m pytest -q)\nfailing in: tests/api/test_stats.py",
    diff: { files: ['app/api/feedback.py'], insertions: 40, deletions: 2 },
  };

  it('asks the reverted tree whether the task was the cause', async () => {
    h.state.gate = BASE_FAIL;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.rechecks).toEqual(['r1']);
    // Reverted BEFORE it is asked, or it would measure the agent's work
    // rather than the baseline and answer the wrong question.
    expect(h.calls.rollbacks.length).toBe(1);
  });

  it('does not ask when it was the task\'s own check that failed', async () => {
    // A task's own command names the tests it wants run, so a failure there is
    // its own by construction. Nothing to ask, and a full suite run not spent.
    h.state.gate = { ...BASE_FAIL, baseFailed: false };

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.rechecks).toEqual([]);
  });

  it('blames the task when the check passes again without it', async () => {
    h.state.gate = BASE_FAIL;
    h.state.recheckGreen = true;

    const sum = await runBatch(config(), [task(1)], stop);

    // Its own doing, so nothing changes: still VERIFY_FAIL, still retryable,
    // and the project is not held.
    expect(h.calls.repairs).toEqual([]);
    expect(sum.held).toEqual([]);
    expect(h.calls.status.some((s) => s.status === 'ready')).toBe(true);
  });

  /** The last word on a task, not the `running` the run opened with. */
  const verdict = (id: string) => h.calls.status.filter((s) => s.id === id).at(-1);

  it('does not retry a task reverted for a failure that was never its own', async () => {
    // The decisive one. Retrying is for a task that might do better next time;
    // this one would do exactly as well and exactly as badly, forever.
    h.state.gate = BASE_FAIL;
    h.state.recheckGreen = false;

    await runBatch(config(), [task(1)], stop);

    expect(verdict('T1')?.status).toBe('failed');
    expect(verdict('T1')?.reason).toContain('VERIFY_UNRELATED');
  });

  it('says so plainly, instead of leaving the task looking guilty', async () => {
    h.state.gate = BASE_FAIL;
    h.state.recheckGreen = false;

    await runBatch(config(), [task(1)], stop);

    expect(verdict('T1')?.reason).toContain('not its doing');
  });

  it('queues one repair job, briefed with what the gate already saw', async () => {
    // The gate ran the check and has the output. Paying for another full suite
    // run to rediscover it is the thing this avoids.
    h.state.gate = BASE_FAIL;
    h.state.recheckGreen = false;

    await runBatch(config(), [task(1), task(2)], stop);

    expect(h.calls.repairs.length).toBe(1);
    expect(h.calls.repairs[0]?.repo).toBe('r1');
    expect(h.calls.repairs[0]?.brief).toContain('tests/api/test_stats.py');
  });

  it('holds the rest of that project\'s work instead of failing it one by one', async () => {
    h.state.gate = BASE_FAIL;
    h.state.recheckGreen = false;

    const sum = await runBatch(config(), [task(1), task(2), task(3)], stop);

    // Task 1 discovered it; 2 and 3 are held without being dispatched.
    expect(h.calls.dispatched).toEqual(['agy:T1']);
    expect(sum.held).toEqual([{ repo: 'r1', count: 2 }]);
  });

  it('tells the baseline cache what it measured, either way', async () => {
    // Or the TRIVIAL floor spends the rest of the run treating a red project
    // as green, which is the opposite of what it is for.
    h.state.gate = BASE_FAIL;
    h.state.recheckGreen = false;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.baselineSet).toContainEqual({ repo: 'r1', green: false });
  });

  it('holds only the project that went red, not the whole run', async () => {
    const cfg = config();
    (cfg.repos as unknown[]).push({ ...cfg.repos[0], id: 'r2' });
    // Per task, so r2's work genuinely passes rather than being swept up by a
    // gate stub that fails everything.
    h.state.gateFor = { T1: BASE_FAIL, T3: GATE_OK };
    h.state.recheckGreen = false;

    const t3 = { ...task(3), repo: 'r2' } as TaskRow;
    const sum = await runBatch(cfg, [task(1), task(2), t3], stop);

    // T1 discovers r1 is red. T2 shares that project and is held. T3 does not,
    // and is dispatched and committed as usual.
    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T3']);
    expect(sum.held).toEqual([{ repo: 'r1', count: 1 }]);
    expect(sum.committed).toBe(1);
    // One repo went red, so one repair job — not one per project in the run.
    expect(h.calls.repairs.map((r) => r.repo)).toEqual(['r1']);
  });
});

/*
 * The other half of holding work: giving it back.
 *
 * Traced on the 2026-08-20 from-zero run. A repair job landed, the project went
 * green, the run logged "its held work is back in play" — and then ended,
 * having run none of it, with a report claiming nothing was held at all. Five
 * jobs went quiet between one line and the next.
 */
describe('work held mid-run is genuinely given back', () => {
  const BASE_FAIL = {
    ok: false,
    failure: 'VERIFY_FAIL',
    baseFailed: true,
    detail: "the repo's own check failed (python -m pytest -q)",
    diff: { files: ['app/api/feedback.py'], insertions: 40, deletions: 2 },
  };

  it('runs the released work instead of forgetting it', async () => {
    // T1 finds the repo red and T2 is held behind it. The repair lands, the
    // repo goes green, and a refill offers T2 again — which only works if
    // being held took it back out of the run's "already offered" set.
    h.state.gateFor = { T1: BASE_FAIL, T2: GATE_OK, T9: GATE_OK };
    h.state.recheckGreen = false;

    const repair = { ...task(9), title: "Make the project's own check pass again (r1)" } as TaskRow;
    let refills = 0;
    h.state.refillWith = [];
    const t2 = task(2);
    // First refill offers the repair job; once it commits, the repo is green
    // and the same held task comes back round, exactly as selectBatch would
    // return it from the ledger.
    Object.defineProperty(h.state, 'refillWith', {
      configurable: true,
      get: () => (++refills === 1 ? [repair] : refills === 2 ? [t2] : []),
    });

    const sum = await runBatch(config(), [task(1), t2], stop);

    expect(h.calls.dispatched).toContain('agy:T9'); // the repair ran
    expect(h.calls.dispatched).toContain('agy:T2'); // and so did the held work
    expect(sum.held).toEqual([]); // released, and reported as released
  });

  /*
   * Held work came back. Work already REVERTED as innocent did not.
   *
   * Run 5 on 2026-08-20: T27s1zfnz64 was reverted VERIFY_UNRELATED — the gate
   * measured that the repo was already broken and that it stayed broken with
   * the task removed, which is a finding of innocence. It was still marked
   * `failed`, and `failed` is terminal: only `sa retry --failed` revives it,
   * and the operator drives a TUI. The repair landed, the held work resumed,
   * and the innocent task stayed dead. It was the central feature of the idea.
   *
   * Both halves are asserted. Setting it `ready` while leaving its id in
   * `seen` would read as fixed and change nothing — which is exactly how the
   * held-work bug survived being fixed once already.
   */
  it('puts back the work it reverted for a failure that was never its fault', async () => {
    h.state.gateFor = { T1: BASE_FAIL, T9: GATE_OK, T2: GATE_OK };
    h.state.recheckGreen = false;

    const repair = { ...task(9), title: "Make the project's own check pass again (r1)" } as TaskRow;
    const innocent = task(2);
    // The ledger holds it as failed VERIFY_UNRELATED; the repair going green
    // is what makes it runnable again.
    h.state.reopens = { r1: ['T2'] };

    let refills = 0;
    h.state.refillWith = [];
    Object.defineProperty(h.state, 'refillWith', {
      configurable: true,
      get: () => (++refills === 1 ? [repair] : refills === 2 ? [innocent] : []),
    });

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.reopened).toContain('r1'); // asked, for the repo that recovered
    expect(h.calls.dispatched).toContain('agy:T2'); // and it actually ran again
    expect(sum.held).toEqual([]);
  });

  it('asks nothing of a project that never went red', async () => {
    h.state.gateFor = { T1: GATE_OK };
    const sum = await runBatch(config(), [task(1)], stop);
    expect(h.calls.reopened).toEqual([]);
    expect(sum.committed).toBe(1);
  });
});

/*
 * Whether a task is briefed is a ROUTING decision, taken per dispatch. The
 * drivers pass `task.brief` through unconditionally and identically, so these
 * are the only tests that decide which agents ever see a brief — and the only
 * ones that decide what happens on the day the senior is unreachable.
 */
describe('the senior brief at dispatch', () => {
  const BRIEF = '<brief>\n  <objective>already designed</objective>\n</brief>';
  const briefed = (over: Record<string, unknown> = {}) =>
    ({
      ...config(),
      drivers: { routing: { brief_for: ['agy'], qa_for: [] } },
      ...over,
    }) as unknown as AppConfig;

  it('gives the intern the brief instead of the planner instruction', async () => {
    h.state.gate = GATE_OK;
    await runBatch(briefed(), [{ ...task(1), brief: BRIEF }], stop);

    expect(h.calls.agentBriefs).toEqual([BRIEF]);
    const d = h.calls.journal.find((e) => e.stage === 'dispatch');
    expect(d?.detail).toContain('briefed by the senior');
    expect(d?.detail).toContain('already designed');
  });

  /*
   * A brief already on the row was paid for on an earlier attempt. Re-authoring
   * it costs a second brain call and, worse, can hand attempt 2 a DIFFERENT
   * design from the one the journal says attempt 1 failed at.
   */
  it('reuses a brief from an earlier attempt rather than buying another', async () => {
    h.state.gate = GATE_OK;
    await runBatch(briefed(), [{ ...task(1), brief: BRIEF }], stop);

    expect(h.calls.briefs).toEqual([]);
  });

  it('leaves the agent unbriefed when routing does not name it', async () => {
    h.state.gate = GATE_OK;
    // The row carries a brief; routing says this agent does not get one.
    await runBatch(config(), [{ ...task(1), brief: BRIEF }], stop);

    expect(h.calls.agentBriefs).toEqual([undefined]);
    const d = h.calls.journal.find((e) => e.stage === 'dispatch');
    expect(d?.detail).toContain('do it');
    expect(d?.detail).not.toContain('briefed by the senior');
  });

  /*
   * The senior being down must not stop the shop. A task that cannot be briefed
   * still has a planner instruction and acceptance criteria, which is what every
   * task ran on before briefs existed.
   */
  it('falls back to the planner instruction when the senior cannot be reached', async () => {
    h.state.gate = GATE_OK;
    h.state.brainThrow = new Error('agy exited 1');
    const sum = await runBatch(briefed(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(h.calls.dispatched).toEqual(['agy:T1']);
    expect(h.calls.agentBriefs).toEqual([undefined]);
    expect(h.calls.briefs).toEqual([]);
    const d = h.calls.journal.find((e) => e.stage === 'dispatch');
    expect(d?.detail).toContain('do it');
    expect(d?.detail).toContain('ACCEPTANCE: done');
  });
});

/*
 * The seam between a green gate and a push.
 *
 * Two properties matter here and nothing else does. A rejection must UNDO the
 * work — a "rework" that leaves the change in the tree is a rejection the next
 * task inherits. And every way the review can fail to happen must SHIP, because
 * the review is a filter on work that is already correct by measurement: a
 * senior that is down turning into a run that deletes everything it makes is the
 * worst failure this pipeline has available.
 */
describe('the senior review before the commit', () => {
  const SHIP = { verdict: 'ship', summary: 'the boundary case is covered', findings: [] };
  const REWORK = {
    verdict: 'rework',
    summary: 'the only new test passes against any implementation',
    findings: [
      {
        file: 'src/a.ts',
        severity: 'untested',
        detail: 'the assertion reads back the value fed to the mock two lines above it',
        fix: 'insert a real row outside the window and assert it is excluded',
      },
    ],
  };
  const reviewed = (over: Record<string, unknown> = {}) =>
    ({
      ...config(),
      drivers: { routing: { brief_for: [], qa_for: ['agy'] } },
      ...over,
    }) as unknown as AppConfig;

  it('asks nobody when routing does not name the agent', async () => {
    h.state.gate = GATE_OK;
    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.reviews).toEqual([]);
    expect(sum.committed).toBe(1);
  });

  it('commits work the senior approves', async () => {
    h.state.gate = GATE_OK;
    h.state.review = SHIP;
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.reviews.map((r) => r.id)).toEqual(['T1']);
    expect(sum.committed).toBe(1);
    expect(h.calls.rollbacks).toEqual([]);
  });

  /*
   * The approval is journalled too. The journal is what the next task is handed
   * as context, and "this shape of work was accepted" is worth as much there as
   * a rejection.
   */
  it('records the approval where the next task will read it', async () => {
    h.state.gate = GATE_OK;
    h.state.review = SHIP;
    await runBatch(reviewed(), [task(1)], stop);

    const r = h.calls.journal.find((e) => e.stage === 'review');
    expect(r?.detail).toContain('SENIOR REVIEW: SHIP');
    expect(r?.detail).toContain('the boundary case is covered');
  });

  it('shows the reviewer exactly the files the gate accounted for', async () => {
    h.state.gate = GATE_OK;
    h.state.review = SHIP;
    await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.patchReads).toEqual([GATE_OK.diff.files]);
  });

  /*
   * A rejection is the same shape as a gate rejection: the tree goes back to
   * what the task was planned against, because attempt two must not start from a
   * half-accepted version of attempt one.
   */
  it('reverts the change when the senior sends it back', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.rollbacks).toHaveLength(1);
    expect(sum.committed).toBe(0);
    expect(sum.failed).toBe(1);
  });

  it('leaves the task ready when it still has an attempt left', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    await runBatch(reviewed(), [task(1)], stop);

    const last = h.calls.status.filter((s) => s.id === 'T1').at(-1);
    expect(last?.status).toBe('ready');
    expect(last?.reason).toMatch(/^QA_REWORK: /);
  });

  /*
   * The findings go into the journal in full, because the journal is the context
   * the retry is handed. A summary that dropped the fix would leave the intern
   * to guess at the defect it was sent back to correct.
   */
  it('hands the retry the findings, not just the verdict', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    await runBatch(reviewed(), [task(1)], stop);

    const r = h.calls.journal.find((e) => e.stage === 'review');
    expect(r?.detail).toContain('SENIOR REVIEW: REWORK');
    expect(r?.detail).toContain('src/a.ts [untested]');
    expect(r?.detail).toContain('FIX: insert a real row outside the window');
    expect(r?.detail).toContain('one more attempt');
  });

  it('gives up on a repeated verdict instead of looping', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    /*
     * "Out of chances" is a REPEATED failure now, not a spent counter — see
     * keepTrying. The task is re-offered so it fails the same way twice, which
     * is what ends it. Setting h.state.attempt no longer decides anything.
     */
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(reviewed(), [t], stop);

    expect(h.calls.status.filter((s) => s.id === 'T1').at(-1)?.status).toBe('failed');
    // The LAST review, not the first: the first one still had a successor and
    // correctly promised it one more attempt.
    expect(h.calls.journal.filter((e) => e.stage === 'review').at(-1)?.detail).toContain(
      'no attempts left',
    );
  });

  /*
   * Remembered only on the final verdict, and under its own kind: a planner
   * reading these back has to be able to tell "the project's check said no" from
   * "the check said yes and a reader disagreed".
   */
  it('remembers an abandoned task as a rework, not as a gate rejection', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    /*
     * "Out of chances" is a REPEATED failure now, not a spent counter — see
     * keepTrying. The task is re-offered so it fails the same way twice, which
     * is what ends it. Setting h.state.attempt no longer decides anything.
     */
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(reviewed(), [t], stop);

    const mem = h.calls.remembered.find((r) => r.kind === 'qa_rework');
    expect(mem?.reason).toContain('senior rejected');
    expect(h.calls.remembered.find((r) => r.kind === 'gate_rejection')).toBeUndefined();
  });

  it('does not remember a task that still has an attempt left', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.remembered.find((r) => r.kind === 'qa_rework')).toBeUndefined();
  });

  /*
   * Fail-open, every way it can fail. These are the tests that decide whether one
   * provider outage costs a run its entire output.
   */
  it('ships when the senior cannot be reached at all', async () => {
    h.state.gate = GATE_OK;
    h.state.brainThrow = new Error('agy exited 1');
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(h.calls.rollbacks).toEqual([]);
  });

  it('ships when the senior answers with something unusable', async () => {
    h.state.gate = GATE_OK;
    h.state.reviewThrow = new Error('gave up after 3 repair rounds');
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(h.calls.rollbacks).toEqual([]);
  });

  it('ships when git cannot render the change', async () => {
    h.state.gate = GATE_OK;
    h.state.patchThrow = new Error('fatal: bad revision');
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(h.calls.reviews).toEqual([]);
  });

  /*
   * A change the gate counted but git cannot show — a mode bit, a permission
   * change — gives the reviewer nothing to read. Spawning a model to look at an
   * empty diff is a request spent on nothing, and a reviewer shown nothing
   * rejects for what it cannot see.
   */
  it('does not buy a review of an empty diff', async () => {
    h.state.gate = GATE_OK;
    h.state.patch = '';
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.reviews).toEqual([]);
    expect(sum.committed).toBe(1);
  });

  it('never reviews work the gate already rejected', async () => {
    // The default verdict is NO_CHANGES: ok:false. Reviewing here would spend a
    // model call on a change that is not going to be committed either way.
    const sum = await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.reviews).toEqual([]);
    expect(sum.committed).toBe(0);
  });
});

/**
 * `max_attempts: 2` promised a second attempt. It was delivering it tomorrow.
 *
 * `runOne` sets a retryable rejection back to `ready` and every report reads
 * that as "it will be retried". It was not, in this run: the id was still in
 * the run's `seen` set from the first offer, and `refill` discards any id it
 * recognises. Measured on run bhmjn0bci (2026-08-21): two tasks, four
 * dispatches, both ending `failed` with attempts=2 — and each task's second
 * attempt came from the NEXT run, hours after the findings were written.
 *
 * The second half is what the retry is for. A task sent back used to be handed
 * the same prompt it got the first time, with its findings reachable only
 * through the shared journal tail — which, with another task in flight, opens
 * after them. Both faults are asserted here, because fixing either one alone
 * produces a run that repeats its own defect and calls it a retry.
 */
describe('a second attempt, in the run that asked for it', () => {
  const REJECT = {
    ok: false,
    failure: 'VERIFY_FAIL',
    detail: 'two tests red',
    diff: { files: ['src/a.ts'], insertions: 5, deletions: 0 },
  };

  /** Makes bumpAttempt count 1, 2, 3... the way the real ledger does. */
  const countingAttempts = () => {
    let n = 0;
    Object.defineProperty(h.state, 'attempt', { configurable: true, get: () => ++n });
  };

  it('dispatches the rejected task again instead of leaving it for tomorrow', async () => {
    countingAttempts();
    h.state.gate = REJECT;
    const t = task(1);
    // What selectBatch would return: the ledger has it `ready` with one attempt
    // spent, so it is offered again — and used to be dropped on the floor here.
    h.state.refillWith = [t];

    const sum = await runBatch(config(), [t], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T1']);
    expect(sum.failed).toBe(2);
  });

  it('stops at max_attempts rather than looping on the same task', async () => {
    countingAttempts();
    h.state.gate = REJECT;
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(config(), [t], stop);

    // Two dispatches, not three: the second one is the last attempt, so the
    // task goes terminal and its id stays in `seen`.
    expect(h.calls.dispatched).toHaveLength(2);
  });

  it('stops re-offering a task once it fails the same way twice', async () => {
    /*
     * The counter used to end this at one dispatch. What ends it now is the
     * second REJECT being identical to the first — so there are two, and then
     * it stops rather than running to the ceiling.
     */
    h.state.gate = REJECT;
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(config(), [t], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T1']);
  });

  it('does not re-offer a task that committed', async () => {
    h.state.gate = GATE_OK;
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(config(), [t], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1']);
  });

  /*
   * The retry has to arrive knowing what it is retrying. Without this the
   * second dispatch is byte-identical to the first, which is a re-roll, not a
   * correction — and a re-roll of a deterministic-ish model mostly reproduces
   * the same defect.
   */
  it('hands the second dispatch the findings it was sent back for', async () => {
    countingAttempts();
    h.state.gate = REJECT;
    h.state.thread = { T1: 'REWORK: the status filter is never asserted on' };
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(config(), [t], stop);

    expect(h.calls.agentRework).toHaveLength(2);
    // Both dispatches see it now: the first because this fixture gives T1 a
    // thread from the outset, the second because it was just sent back.
    expect(h.calls.agentRework[1]).toContain('status filter is never asserted on');
  });

  it('tells a task with no history nothing, so its presence means what it says', async () => {
    h.state.gate = GATE_OK;
    h.state.thread = {};

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.agentRework).toEqual([undefined]);
  });

  /*
   * This test used to assert the opposite, with the thread set to "REWORK: from
   * some previous run" and the expectation that a first attempt was told
   * nothing. The guard was `attempt > 1`, which reads as "have you done this
   * before" only while nothing resets the counter — and `retryTask` sets
   * attempts to 0, because to the queue a revived task starts again.
   *
   * So every recovery path threw away the history exactly when it mattered:
   * `retry --failed`, `retry <id>`, and the repair job a run now revives by
   * itself. A task that failed yesterday was dispatched today knowing nothing
   * about yesterday, and re-derived the approach it was rejected for. What is
   * being retried is the same piece of work; a fresh counter does not make it
   * a fresh problem.
   */
  it('tells one revived from a previous run what happened last time', async () => {
    h.state.gate = GATE_OK;
    h.state.thread = { T1: 'REWORK: from some previous run' };

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.agentRework[0]).toContain('from some previous run');
  });
});

/**
 * A task that was sent back and then shipped is one piece of work that landed.
 *
 * `runOne` returns `outcome: 'failed'` for a rejection whether or not another
 * attempt is coming, which is right — at that moment the task had not landed,
 * and the report's account of the run has to say so. What was wrong was
 * carrying that straight through to the numbers presented as the run's result.
 *
 * On 2026-08-21 a run planned one task, sent it back over an undeclared schema
 * change, watched the retry fix it, committed and pushed it, and signed off with
 * "1 committed, 1 failed". That line is the one thing a non-technical operator
 * reads at the end, and a run that did exactly what it set out to do should not
 * read as a coin flip.
 *
 * `retrying` is set by whoever rejected it and is the only thing that knows
 * whether the outcome is final, so these pin to that rather than to the attempt
 * counter — the two rejection paths compute retryability differently, and one
 * of them deliberately never retries at all.
 */
describe('a rejection that still has an attempt left is not the run failing', () => {
  const REWORK = { verdict: 'rework', summary: 'undeclared schema change at startup', findings: [] };
  const SHIP = { verdict: 'ship', summary: 'the migration carries it now', findings: [] };

  const qa = () =>
    ({
      ...config(),
      drivers: { routing: { brief_for: [], qa_for: ['agy'] } },
    }) as unknown as AppConfig;

  /** Makes bumpAttempt count 1, 2, 3... the way the real ledger does. */
  const countingAttempts = () => {
    let n = 0;
    Object.defineProperty(h.state, 'attempt', { configurable: true, get: () => ++n });
  };

  /** A different verdict per review call, so one run can be sent back and then ship. */
  const reviewsInTurn = (...verdicts: unknown[]) => {
    let n = 0;
    Object.defineProperty(h.state, 'review', {
      configurable: true,
      get: () => verdicts[Math.min(n++, verdicts.length - 1)],
    });
  };

  // The shared beforeEach assigns h.state.review plainly, which throws over a
  // getter-only property and reports the fault against the following test. Same
  // hazard the `attempt` and `refillWith` resets above already carry a note for.
  afterEach(() => {
    Object.defineProperty(h.state, 'review', { configurable: true, writable: true, value: undefined });
  });

  it('reports a task sent back once and then shipped as one commit and no failure', async () => {
    h.state.gate = GATE_OK;
    countingAttempts();
    reviewsInTurn(REWORK, SHIP);
    const t = task(1);
    // What selectBatch would return: the rework set it back to `ready`, so it is
    // offered again inside this run rather than left for tomorrow.
    h.state.refillWith = [t];

    const sum = await runBatch(qa(), [t], stop);

    expect(sum.committed).toBe(1);
    expect(sum.sentBack).toBe(1);
    // The subtraction every operator-facing number now does.
    expect(sum.failed - sum.sentBack).toBe(0);
  });

  it('still reports one that ran out of attempts as a failure', async () => {
    h.state.gate = GATE_OK;
    countingAttempts();
    reviewsInTurn(REWORK);
    const t = task(1);
    h.state.refillWith = [t];

    const sum = await runBatch(qa(), [t], stop);

    // Two rejections, one task, one piece of work that did not land.
    expect(sum.failed).toBe(2);
    expect(sum.sentBack).toBe(1);
    expect(sum.failed - sum.sentBack).toBe(1);
  });

  /*
   * A refusal IS retried now — it is fed back to the agent, which can route
   * around it with its own file tools. What must not change is the accounting:
   * one refused task that never landed is one real failure however many
   * dispatches it took, and the `blocked` cell is what explains it rather than
   * a discount on the total.
   */
  it('does not discount a refusal, however many attempts it took', async () => {
    h.state.exec = {
      ok: true,
      stdout: 'Tool `pytest` requires a permission that headless mode cannot prompt for.',
      durationMs: 1000,
      reason: 'PERMISSION_DENIED',
    };
    h.state.refillWith = [task(1)];

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.blocked).toBe(1);
    // Sent back once, then refused the same way and stopped.
    expect(sum.sentBack).toBe(1);
    expect(sum.failed - sum.sentBack).toBe(1);
  });

  it('leaves a run in which nothing was rejected reporting nothing sent back', async () => {
    h.state.gate = GATE_OK;

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(sum.failed).toBe(0);
    expect(sum.sentBack).toBe(0);
  });
});
/*
 * The subtraction itself, on its own, because three call sites present it and a
 * change to any one of them is a change to what the operator is told.
 */
describe('what the run ended up with', () => {
  it('does not count a rejection the retry fixed', () => {
    expect(netFailed({ failed: 1, sentBack: 1 })).toBe(0);
  });

  it('still counts one the retry did not fix', () => {
    expect(netFailed({ failed: 2, sentBack: 1 })).toBe(1);
  });

  it('is the plain count when nothing was ever sent back', () => {
    expect(netFailed({ failed: 3, sentBack: 0 })).toBe(3);
    expect(netFailed({ failed: 0, sentBack: 0 })).toBe(0);
  });
});
/**
 * What a revert cannot undo has to reach the attempt that will be graded in its
 * wake — see SIDE_EFFECTS_SURVIVE in executor.ts for the run this cost.
 *
 * The journal entry is the whole delivery mechanism: it is what the next attempt
 * is handed as context. So these assert on the journal, and they assert on the
 * silence too — a task with no attempts left has nobody to warn, and a note
 * printed for nobody is how the next real one gets skimmed past.
 */
describe('telling the next attempt what the revert did not undo', () => {
  const REWORK = { verdict: 'rework', summary: 'undeclared schema change at startup', findings: [] };
  const qa = () =>
    ({ ...config(), drivers: { routing: { brief_for: [], qa_for: ['agy'] } } }) as unknown as AppConfig;

  const warned = (stage: string) =>
    h.calls.journal.filter((e) => e.stage === stage && /NOT reverted/.test(e.detail ?? ''));

  it('warns the next attempt after a senior sends the work back', async () => {
    h.state.gate = GATE_OK;
    h.state.review = REWORK;

    await runBatch(qa(), [task(1)], stop);

    const note = warned('review')[0]?.detail ?? '';
    expect(note).toContain('OUTSIDE git');
    // Named concretely, because 'side effects' is not a thing an intern can check.
    expect(note).toMatch(/database/);
    expect(note).toContain('reverted attempt left behind');
  });

  it('warns it after the gate rejects the work too', async () => {
    h.state.gate = {
      ok: false,
      failure: 'VERIFY_FAIL',
      detail: 'two tests red',
      diff: { files: ['src/a.ts'], insertions: 5, deletions: 0 },
    };

    await runBatch(config(), [task(1)], stop);

    expect(warned('gate')).toHaveLength(1);
  });

  it('says nothing when there is no next attempt to read it', async () => {
    /*
     * "Out of chances" is a REPEATED failure now, not a spent counter — see
     * keepTrying. The task is re-offered so it fails the same way twice, which
     * is what ends it. Setting h.state.attempt no longer decides anything.
     */
    h.state.gate = GATE_OK;
    h.state.review = REWORK;
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(qa(), [t], stop);

    /*
     * One warning, not two. The first rework had a successor and warned it; the
     * second is terminal and writes nothing, because there is nobody to read it.
     */
    expect(warned('review')).toHaveLength(1);
  });

  /*
   * The gate path has its own copy of the condition, so it needs its own proof
   * of the silence. Mutation testing found this one: emptying the ternary there
   * so it warned unconditionally left every test passing.
   */
  it('says nothing after a gate rejection with no attempts left either', async () => {
    /*
     * "Out of chances" is a REPEATED failure now, not a spent counter — see
     * keepTrying. The task is re-offered so it fails the same way twice, which
     * is what ends it. Setting h.state.attempt no longer decides anything.
     */
    h.state.refillWith = [task(1)];
    h.state.gate = {
      ok: false,
      failure: 'VERIFY_FAIL',
      detail: 'two tests red',
      diff: { files: ['src/a.ts'], insertions: 5, deletions: 0 },
    };

    await runBatch(config(), [task(1)], stop);

    // One, for the attempt that had a successor. The final rejection is silent.
    expect(warned('gate')).toHaveLength(1);
  });

  it('says nothing on a run where nothing was reverted', async () => {
    h.state.gate = GATE_OK;

    await runBatch(config(), [task(1)], stop);

    expect(warned('review')).toEqual([]);
    expect(warned('gate')).toEqual([]);
  });
});

/**
 * A retry that is told nothing about the attempt it is repeating.
 *
 * `readTaskThread` is the whole of a retry's memory, and it carries verdicts:
 * gate and review. An attempt that dies before the gate — the agent stops
 * mid-work and the session ends INCOMPLETE — produces neither, so until
 * 2026-08-21 the retry was dispatched blind. On run 14 that was measured against
 * the live journal: the task queued for retry read 0 characters, the task that
 * shipped read 331. The blind one was about to repeat 466 seconds of work,
 * including rediscovering that a column its brief assumed exists does not.
 */
describe('an attempt that died before the gate leaves the retry something to read', () => {
  const INCOMPLETE = {
    ok: false,
    reason: 'INCOMPLETE',
    stdout:
      `THE FIRST THING IT SAID\n${'chatter\n'.repeat(200)}` +
      `BLOCKER: SearchQueryLog has no status column.`,
    durationMs: 466_000,
  };

  it('records why it stopped, and that the tree it left was rolled back', async () => {
    h.state.exec = INCOMPLETE;

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note');
    expect(note).toBeDefined();
    expect(note!.detail).toContain('INCOMPLETE');
    expect(note!.detail).toMatch(/reverted/);
    // The count comes from the rollback, not from the sentence being there.
    expect(note!.detail).toContain('2 file change(s)');
  });

  /*
   * O26. This sentence was unconditional, and `git.rollback` returned void, so
   * nothing at this point knew whether there had been anything to revert. Run
   * 23 logged "Nothing to roll back in example-api" beside every one of them.
   */
  it('does not claim a revert on a tree that was already clean', async () => {
    h.state.exec = INCOMPLETE;
    h.state.rollback = { reverted: 0, stash: null, skipped: false };

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('changed no files');
    expect(note.detail).not.toMatch(/reverted and stashed/);
  });

  it('does not promise a stash the fallback path never made', async () => {
    // The path that has no stash is also the one that may have deleted through.
    h.state.exec = INCOMPLETE;
    h.state.rollback = { reverted: 3, stash: null, skipped: false };

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('WITHOUT a stash');
    expect(note.detail).not.toMatch(/reverted and stashed/);
  });

  it('says the work is STILL THERE when the revert could not run', async () => {
    /*
     * A held git index means nothing was touched, so the next attempt opens a
     * tree containing its predecessor's half-finished work. Telling it the tree
     * is clean is the one version of this sentence that could cause harm.
     */
    h.state.exec = INCOMPLETE;
    h.state.rollback = { reverted: 0, stash: null, skipped: true };

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toMatch(/still in the tree/i);
    expect(note.detail).not.toMatch(/clean tree/);
  });

  it('does not quote ShanAuto\'s own diagnosis back as the agent\'s words', async () => {
    /*
     * The other half of O26. With no agent text at all, the driver falls back to
     * its own sentence — *the session stopped after a step that finished with
     * reason "unknown"* — and this note printed it under "What it reported
     * before it stopped:". The next model was shown a description of the
     * provider and told its predecessor said it.
     */
    h.state.exec = {
      ok: false,
      reason: 'INCOMPLETE',
      spoke: false,
      stdout: 'the session stopped after a step that finished with reason "unknown"',
      durationMs: 1000,
    };

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('produced no account');
    expect(note.detail).not.toContain('What it reported before it stopped');
  });

  it('still attributes real agent text to the agent', async () => {
    h.state.exec = { ...INCOMPLETE, spoke: true };

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('What it reported before it stopped');
  });

  it('warns it that a revert did not undo what happened outside git', async () => {
    h.state.exec = INCOMPLETE;

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('was NOT reverted and is still in place');
  });

  it('leaves that warning out when there was no revert to qualify', async () => {
    // The warning is about what a revert could not reach. With nothing
    // reverted there is nothing to qualify, and saying it anyway is noise in
    // the one message that has to be worth reading.
    h.state.exec = INCOMPLETE;
    h.state.rollback = { reverted: 0, stash: null, skipped: false };

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).not.toContain('was NOT reverted and is still in place');
  });

  /*
   * The tail, not the head. An agent's conclusions are the last thing it says —
   * the same reason `result` entries are kept out of the thread, since an entry
   * too big for the budget is kept from its front.
   */
  it('carries the end of what the agent said, where the blocker it found is', async () => {
    h.state.exec = INCOMPLETE;

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('SearchQueryLog has no status column');
    expect(note.detail).not.toContain('THE FIRST THING IT SAID');
  });

  it('says nothing when there is no next attempt to read it', async () => {
    /*
     * "Out of chances" is a REPEATED failure now, not a spent counter — see
     * keepTrying. The task is re-offered so it fails the same way twice, which
     * is what ends it. Setting h.state.attempt no longer decides anything.
     */
    h.state.exec = INCOMPLETE;
    const t = task(1);
    h.state.refillWith = [t];

    await runBatch(config(), [t], stop);

    // Written for the NEXT attempt, so the final failure writes none.
    expect(h.calls.journal.filter((e) => e.stage === 'note').length).toBeLessThan(2);
  });

  it('leaves an attempt that succeeded unremarked', async () => {
    h.state.gate = GATE_OK;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.journal.find((e) => e.stage === 'note')).toBeUndefined();
  });
});

/*
 * Run 20, task Tz6zyxs1hnm. The first attempt ran 27 steps, wrote four files,
 * +65/-27, and then stopped on a step the provider never finished. Every line
 * of it was reverted without the gate being asked one question, the attempt was
 * charged, and the second attempt rewrote the same change — which passed the
 * gate, passed the review, and committed as 0adee5e7. The tree the first one
 * left was in stash@{0}, and it was almost certainly already good.
 *
 * How a session ENDED is not evidence about what is in the tree.
 */
describe('work a session left behind when it died is judged, not discarded', () => {
  const INCOMPLETE = {
    ok: false,
    reason: 'INCOMPLETE',
    stdout: 'the session stopped after a step that finished with reason "unknown"',
    durationMs: 466_000,
  };
  const LEFT_BEHIND = {
    files: ['app/api/search.py', 'app/services/document_search.py', 'tests/api/test_search.py'],
    insertions: 65,
    deletions: 27,
    renames: 0,
  };

  it('asks the gate about it instead of reverting it unread', async () => {
    h.state.exec = INCOMPLETE;
    h.state.diff = LEFT_BEHIND;
    h.state.gate = GATE_OK;

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.gates).toEqual(['T1']);
    expect(h.calls.rollbacks).toEqual([]);
    expect(sum.committed).toBe(1);
  });

  /*
   * The old note told the retry its work had been "reverted and stashed, so you
   * are starting from a clean tree". On this path that sentence is false, and a
   * retry that believes it would rewrite work that is still sitting there.
   */
  it('says what it kept, and does not tell anyone the tree was cleaned', async () => {
    h.state.exec = INCOMPLETE;
    h.state.diff = LEFT_BEHIND;
    h.state.gate = GATE_OK;

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note')!;
    expect(note.detail).toContain('app/services/document_search.py');
    expect(note.detail).not.toContain('starting from a clean tree');
  });

  it('reverts it after the gate refuses it, exactly as it always did', async () => {
    h.state.exec = INCOMPLETE;
    h.state.diff = LEFT_BEHIND;
    h.state.gate = {
      ok: false,
      failure: 'TEST_TAMPER',
      detail: 'edited tests/db/test_search_logs.py, which the plan did not name',
      diff: { files: ['tests/db/test_search_logs.py'], insertions: 4, deletions: 4 },
    };

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.gates).toEqual(['T1']);
    expect(h.calls.rollbacks).toHaveLength(1);
    expect(sum.committed).toBe(0);
  });

  /*
   * The ordinary case, and the reason the tree is read before the gate is: a
   * dead session that wrote nothing must not cost a verify run to find that out.
   */
  it('does not spend a check on a session that wrote nothing', async () => {
    h.state.exec = INCOMPLETE;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.gates).toEqual([]);
    expect(h.calls.rollbacks).toHaveLength(1);
    expect(h.calls.journal.find((e) => e.stage === 'note')!.detail).toContain(
      'starting from a clean tree',
    );
  });

  /*
   * A timeout is US killing an agent that was demonstrably still working. A
   * file caught half-written is a real possibility there rather than a
   * theoretical one, so that path is untouched.
   */
  it('leaves what a killed agent left behind alone', async () => {
    h.state.exec = { ok: false, reason: 'TIMEOUT', stdout: 'killed after 3600s', durationMs: 3_600_000 };
    h.state.diff = LEFT_BEHIND;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.gates).toEqual([]);
    expect(h.calls.rollbacks).toHaveLength(1);
  });

  it('keeps the old behaviour when git cannot say what is there', async () => {
    h.state.exec = INCOMPLETE;
    h.state.diffThrow = new Error('fatal: not a git repository');

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.gates).toEqual([]);
    expect(h.calls.rollbacks).toHaveLength(1);
    /*
     * And it is the ordinary failure, not an unhandled throw. Both revert, so
     * the rollback above cannot tell them apart: the throw path writes `failed`
     * outright with git's error as the reason, spending the second attempt this
     * task still has and losing what the agent said before it stopped.
     */
    const last = h.calls.status.at(-1)!;
    expect(last.status).toBe('ready');
    expect(last.reason).toContain('INCOMPLETE');
    expect(h.calls.journal.find((e) => e.stage === 'note')!.detail).toContain(
      'starting from a clean tree',
    );
  });
});

/**
 * End to end, through the real review prompt: the reviewer is shown the report.
 *
 * The unit tests in qa.test.ts prove `reviewWork` renders it. This proves the
 * executor actually hands it over — the half that was missing on 2026-08-21,
 * when every piece existed except the wire between them.
 */
describe('the junior report reaching the senior review', () => {
  const reviewed = () =>
    ({
      ...config(),
      drivers: { routing: { brief_for: [], qa_for: ['agy'] } },
    }) as unknown as AppConfig;

  it('puts what the agent said into the prompt the reviewer is asked', async () => {
    h.state.gate = GATE_OK;
    h.state.review = { verdict: 'ship', summary: 'fine', findings: [] };
    h.state.exec = {
      ok: true,
      stdout: 'DEVIATION: SearchQueryLog has no status column, so that filter is not here.',
      durationMs: 1000,
    };

    await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.reviews).toHaveLength(1);
    expect(h.calls.reviews[0]!.patch).toContain('SearchQueryLog has no status column');
  });
});

/*
 * Run 15, 2026-08-21: three of four opencode dispatches ended on a step the
 * provider never ran — reason "unknown", zero tokens in, zero out, no cost,
 * after 69-115 seconds of the agent reading files. Because the attempt counter
 * moves before dispatch and the budget is two, task Tiaybdncsp2 exhausted both
 * without a model ever writing a line, and T0cygl3e2i8 burned its first the
 * same way, then did good work on its second and drew a review naming one real
 * defect with the exact fix — and had nothing left to apply it with. The run
 * committed nothing and reported "2 failed", which reads as two bad tasks.
 */
describe('a dispatch the provider never ran does not count as a try', () => {
  const STALLED = {
    ok: false,
    reason: 'INCOMPLETE',
    stalled: true,
    stdout: 'the session stopped after a step that finished with reason "unknown"',
    durationMs: 90_000,
    costUnits: 0,
  };
  const WORKED = { ok: true, stdout: 'all done', durationMs: 1000, costUnits: 3 };

  beforeEach(() => {
    h.state.gate = GATE_OK;
  });

  it('asks again and ships the work the second dispatch does', async () => {
    h.state.execQueue = [STALLED, WORKED];

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T1']);
    expect(sum.committed).toBe(1);
  });

  /*
   * The point of the whole fix. The attempt counter is the run loop's
   * termination bound, so it cannot be refunded — but it also must not be spent
   * on an outage, or the task's real second chance is gone before it starts.
   */
  it('does not charge the task a second attempt for the outage', async () => {
    h.state.execQueue = [STALLED, WORKED];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.bumps).toEqual(['T1']);
    // Nor is it quietly handed back, which would remove the bound instead.
    expect(h.calls.refunds).toEqual([]);
  });

  /*
   * A provider that is simply down must not be able to keep one task talking to
   * it forever while the rest of the day's work waits behind it.
   */
  it('gives up after the bound', async () => {
    h.state.execQueue = [STALLED, STALLED, STALLED, STALLED, STALLED];

    const sum = await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T1', 'agy:T1']);
    expect(sum.committed).toBe(0);
  });

  /*
   * The other half of the rule. A refusal, a timeout or a crash is a real answer
   * about this task; asking again would just collect it again, more slowly, and
   * every failure in this suite that predates `stalled` must stay one dispatch.
   */
  it('leaves an ordinary failure alone', async () => {
    h.state.exec = { ok: false, reason: 'TIMEOUT', stdout: 'ran out of time', durationMs: 60_000 };

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1']);
  });

  /*
   * A stalled session usually wrote nothing — run 15 logged "Nothing to roll
   * back" all three times — but `usually` is not a thing to hand the next
   * dispatch, which would then be judged on a half-edit it did not make.
   */
  it('rolls the tree back before asking again', async () => {
    h.state.execQueue = [STALLED, WORKED];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.rollbacks).toHaveLength(1);
  });

  /*
   * Discarded results are exactly the spend that would otherwise vanish: the
   * allowance was charged when the request was made, whatever came back.
   */
  it('bills every dead dispatch, not just the one it keeps', async () => {
    h.state.execQueue = [{ ...STALLED, costUnits: 2 }, { ...WORKED, costUnits: 3 }];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.costs).toEqual([
      { id: 'T1', units: 2 },
      { id: 'T1', units: 3 },
    ]);
  });

  it('tells the operator it happened rather than swallowing the extra minutes', async () => {
    const warn = vi.spyOn(logger.log, 'warn').mockImplementation(() => undefined);
    h.state.execQueue = [STALLED, WORKED];

    await runBatch(config(), [task(1)], stop);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('redispatching 1 of 2');
    warn.mockRestore();
  });
});

/*
 * Run 23, 2026-08-23. Every one of 24 dispatches came back the same way: a
 * step-finish with reason "unknown", zero tokens in, zero out, cost zero. Four
 * tasks were charged both attempts and ended `failed`; the operator's report
 * said INCOMPLETE eight times and "no attempts left" four times, and never once
 * said that no model had run. Reproduced afterwards outside ShanAuto entirely -
 * eight identical calls to the same model, seven of them empty - so nothing was
 * wrong with the tasks, the plan or the brief.
 *
 * The redispatch bound above is the right response to one dead dispatch. These
 * are about what reaching that bound MEANS.
 */
describe('a provider that answers nothing for a whole task', () => {
  const STALLED_OUT = {
    ok: false,
    reason: 'INCOMPLETE',
    stalled: true,
    stdout: 'the session stopped after a step that finished with reason "unknown"',
    durationMs: 90_000,
    costUnits: 0,
  };

  beforeEach(() => {
    h.state.gate = GATE_OK;
    h.state.exec = STALLED_OUT;
  });

  it('leaves the task ready instead of failing it', async () => {
    await runBatch(config(), [task(1)], stop);

    // `failed` is a verdict about the work. Nothing here has seen any work.
    expect(h.calls.status.map((s) => s.status)).not.toContain('failed');
    expect(h.calls.status.at(-1)?.status).toBe('ready');
  });

  it('gives the attempt back, because nothing was attempted', async () => {
    await runBatch(config(), [task(1)], stop);

    expect(h.calls.refunds).toEqual(['T1']);
  });

  it('takes the provider out of the run rather than the task', async () => {
    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.agentsOut.map((a) => a.agent)).toEqual(['agy']);
  });

  /*
   * What the operator reads. "INCOMPLETE" is an internal enum and told run 23's
   * reader nothing; the sentence has to name the cause and clear the task.
   */
  it('says the provider is not answering and that the task was fine', async () => {
    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.agentsOut[0]?.why).toMatch(/not answering/i);
    expect(sum.agentsOut[0]?.why).toMatch(/nothing was wrong with the task/i);
  });

  /*
   * The cost of run 23. Once the first task had spent three dispatches on an
   * empty provider, the remaining three were sent to the same one and died the
   * same way. An outage is a fact about the provider, not about a task.
   */
  it('does not spend the rest of the queue on the same dead provider', async () => {
    await runBatch(config(), [1, 2, 3].map(task), stop);

    /*
     * Two tasks' worth, not one, since 2026-08-31: the provider is waited out
     * once and the queue carries on, which costs the next task a round of
     * stalled dispatches to discover it is still down (O22). That is the price
     * of the recovery attempt and it is bounded — T3 is never touched, and the
     * run stops on the second outage.
     */
    expect(h.calls.dispatched).toEqual([
      'agy:T1', 'agy:T1', 'agy:T1',
      'agy:T2', 'agy:T2', 'agy:T2',
    ]);
    expect(h.calls.status.filter((s) => s.id === 'T3')).toEqual([]);
  });

  it('leaves the task it was on ready, not failed, when it waits', async () => {
    // The earlier fix's guarantee, still true through a recovery: a task a dead
    // provider never ran is not the task's fault.
    await runBatch(config(), [1, 2].map(task), stop);

    for (const id of ['T1', 'T2']) {
      const last = h.calls.status.filter((s) => s.id === id).at(-1);
      expect(last?.status, id).toBe('ready');
    }
    expect(h.calls.refunds).toEqual(['T1', 'T2']);
  });

  /*
   * O22. With both pools pointed at one agent — the current configuration — the
   * run used to end the moment that agent went out, and the rest of the day's
   * work waited for the next scheduled run. The tasks survived, which was the
   * earlier fix; the DAY did not.
   *
   * Rerouting is not available: agy is the senior, and a reviewer marking its
   * own homework reviews nothing. So the answer is to wait, briefly, once.
   */
  it('waits and carries on rather than giving up the rest of the day', async () => {
    // One task in the queue: three dispatches, out, wait, and nothing left to
    // carry on to. The run ends, but it ended having tried.
    await runBatch(config(), [1, 2].map(task), stop);

    expect(h.calls.dispatched.length).toBe(6);
  });

  it('gives up on the second outage, which is what makes it a pause not a hang', async () => {
    const sum = await runBatch(config(), [1, 2, 3].map(task), stop);

    expect(sum.stopped).toMatch(/^FATAL/);
    // Waited once, never twice, whatever is still in the queue.
    expect(h.calls.dispatched.length).toBe(6);
  });

  it('still reports the outage it recovered from', async () => {
    /*
     * The record survives the recovery. Deleting the entry to make the summary
     * tidy would hide the one fact that explains a short day, and an outage the
     * run survived is still something that happened.
     */
    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.agentsOut.map((a) => a.agent)).toEqual(['agy']);
    expect(sum.agentsOut[0]?.recovered).toBe(true);
  });

  /*
   * The discrimination that keeps this narrow. A session that produced tokens
   * and then stopped mid-thought HAS run - it is INCOMPLETE without being
   * `stalled` - and asking it again is still the right answer, which is what
   * the bound above exists for.
   */
  it('leaves an incomplete session that actually ran alone', async () => {
    h.state.exec = { ...STALLED_OUT, stalled: false };

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.agentsOut).toEqual([]);
    expect(h.calls.refunds).toEqual([]);
  });
});


/*
 * zero13: the configured senior failed OAuth mid-run, the loop fell back, and
 * the understudy's SHIP authorised a commit and a push to the operator's
 * GitHub. The run said `reviewed by agy: ship` — the same string it says when
 * the senior judges — and recorded the swap as a WARN among five others.
 */
describe('a verdict says which model produced it', () => {
  const UNDERSTUDY = { model: 'gemini-3.6-flash-high', fallback: true };
  const SENIOR = { model: 'gemini-3.1-pro-high', fallback: false };
  const reviewed = () =>
    ({
      ...config(),
      drivers: { routing: { brief_for: [], qa_for: ['agy'] } },
    }) as unknown as AppConfig;

  beforeEach(() => {
    h.state.gate = GATE_OK;
  });

  it('names the understudy in the line the operator reads', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    h.state.answered = UNDERSTUDY;

    await runBatch(reviewed(), [task(1)], stop);

    const said = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('reviewed by agy (fell back to gemini-3.6-flash-high): ship');
    info.mockRestore();
  });

  it('leaves the ordinary line alone when the senior answered', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    h.state.answered = SENIOR;

    await runBatch(reviewed(), [task(1)], stop);

    const said = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('reviewed by agy: ship');
    expect(said).not.toContain('fell back');
    info.mockRestore();
  });

  /*
   * The log scrolls away; the journal is what the next task and the operator
   * actually read. The attribution has to survive the trip from the function
   * that got the verdict to the one that publishes it.
   */
  it('carries it into the journal entry, not just the log', async () => {
    h.state.answered = UNDERSTUDY;

    await runBatch(reviewed(), [task(1)], stop);

    const entry = h.calls.journal.find((j) => j.stage === 'review');
    expect(entry?.detail).toContain('NOT the configured senior');
  });

  /*
   * The one fallback whose consequence leaves the machine. A commit and a push
   * are already public by the time anyone reads the log, so this goes where the
   * operator looks when they want to know why something is on their account.
   */
  it('remembers a push that the understudy authorised', async () => {
    h.state.answered = UNDERSTUDY;

    await runBatch(reviewed(), [task(1)], stop);

    const m = h.calls.remembered.find((r) => r.kind === 'qa_fallback_ship');
    expect(m?.reason).toContain('gemini-3.6-flash-high');
  });

  it('remembers nothing when the senior approved it itself', async () => {
    h.state.answered = SENIOR;

    await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.remembered.filter((r) => r.kind === 'qa_fallback_ship')).toEqual([]);
  });

  /*
   * A rejection is reverted and never reaches git, so there is nothing public
   * to explain — the journal entry above already names the judge.
   */
  it('does not record a fallback ship for work the understudy sent back', async () => {
    h.state.answered = UNDERSTUDY;
    h.state.review = { verdict: 'rework', summary: 'the filter is inverted', findings: [] };

    await runBatch(reviewed(), [task(1)], stop);

    expect(h.calls.remembered.filter((r) => r.kind === 'qa_fallback_ship')).toEqual([]);
  });
});
/*
 * Run 16 (2026-08-21): `[Txv7e3v4mfx] BLOCKED - the agent was denied 1 tool
 * permission(s): bash: python -c`, and it went on to pass the gate, commit and
 * push. The work was sound - the repo's own check ran - but every sentence
 * ShanAuto had about a denial lived on a failure path, so the one run that
 * shipped one said nothing about it anywhere the operator looks.
 */
describe('a denial the work survived is still reported', () => {
  const DENIED = {
    ok: true,
    stdout: 'I could not run python -c, so I used a file instead.',
    durationMs: 1000,
    deniedTools: ['bash: python -c'],
  };

  beforeEach(() => {
    h.state.gate = GATE_OK;
    h.state.exec = DENIED;
  });

  it('is still counted as committed, because it was', async () => {
    const sum = await runBatch(config(), [task(1)], stop);
    expect(sum.committed).toBe(1);
    expect(sum.failed).toBe(0);
  });

  /*
   * `blocked` is documented as an explanation of `failed`. A committed task
   * added to it makes the report claim a failure that did not happen.
   */
  it('does not inflate the count that explains the failures', async () => {
    const sum = await runBatch(config(), [task(1)], stop);
    expect(sum.blocked).toBe(0);
    expect(sum.blockedBy).toEqual([]);
  });

  it('names the task and the permission on its own list', async () => {
    const sum = await runBatch(config(), [task(1)], stop);
    expect(sum.blockedShipped).toEqual([
      { id: 'T1', title: 'task 1', permissions: ['bash: python -c'] },
    ]);
  });

  /*
   * Both of them. The operator reads this list to decide what to allow, and a
   * list that names one of two refusals sends them to fix half of it and be
   * denied the rest on the next run with nothing said.
   */
  it('names every permission it was refused, not the first of them', async () => {
    h.state.exec = {
      ...DENIED,
      deniedTools: ['bash: Get-ChildItem -Name', 'write: C:\\Temp\\opencode\\check_db.py'],
    };
    const sum = await runBatch(config(), [task(1)], stop);
    expect(sum.blockedShipped[0]!.permissions).toEqual([
      'bash: Get-ChildItem -Name',
      'write: C:\\Temp\\opencode\\check_db.py',
    ]);
  });

  it('outlives the run in the ledger, where the operator goes afterwards', async () => {
    await runBatch(config(), [task(1)], stop);
    const mem = h.calls.remembered.find((r) => r.kind === 'blocked_ship');
    expect(mem?.reason).toContain('bash: python -c');
    expect(mem?.reason).toMatch(/committed and pushed/);
  });

  /*
   * The commit entry, not just the result entry. The commit line is what a
   * later task is handed as context and what the operator reads down the run,
   * and on its own it reads as an untroubled piece of work.
   */
  it('says so on the commit entry in the journal', async () => {
    await runBatch(config(), [task(1)], stop);
    const commit = h.calls.journal.find((e) => e.stage === 'commit');
    expect(commit?.detail).toContain('BLOCKED on the way');
    expect(commit?.detail).toContain('bash: python -c');
  });

  it('reports a refusal the driver could not name rather than swallowing it', async () => {
    h.state.exec = {
      ok: true,
      stdout: 'Tool `x` requires a permission that headless mode cannot prompt for.',
      durationMs: 1000,
      reason: 'PERMISSION_DENIED',
    };
    const sum = await runBatch(config(), [task(1)], stop);
    expect(sum.committed).toBe(1);
    expect(sum.blockedShipped).toHaveLength(1);
    /*
     * Empty, and that is the point: the driver refused something it would not
     * name, and the task still appears on the list. This used to assert
     * `.permission` was truthy, which it was - it held the string '(unnamed)',
     * a sentinel invented at the push site to satisfy a non-optional field.
     * There is no sentinel now; an empty list says the same thing honestly and
     * the report has its own wording for it.
     */
    expect(sum.blockedShipped[0]!.permissions).toEqual([]);
  });

  it('leaves an untroubled commit untouched', async () => {
    h.state.exec = { ok: true, stdout: 'done', durationMs: 1000 };
    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(sum.blockedShipped).toEqual([]);
    expect(h.calls.remembered.find((r) => r.kind === 'blocked_ship')).toBeUndefined();
    expect(h.calls.journal.find((e) => e.stage === 'commit')?.detail).not.toContain('BLOCKED');
  });
});

/*
 * Run 12's Tp9l0zbr6pl changed a committed, tested endpoint from a bare list to
 * `{data, message}` and nothing anywhere said so: the kind was `feature`, the
 * brief was silent, the tests were rewritten to match by the task's own
 * instruction, and TEST_TAMPER exempts a test file the planner declared. The
 * plan declares it now. These are about the declaration outliving the run.
 */
describe('a declared contract change is recorded where it outlives the run', () => {
  const BREAKS = 'callers that index the response break';

  const declaring = (what: string | null = BREAKS): TaskRow =>
    ({ ...task(1), breaking: what }) as TaskRow;

  beforeEach(() => {
    h.state.gate = GATE_OK;
  });

  it('lists it on the run summary once it has shipped', async () => {
    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.committed).toBe(1);
    expect(sum.breakingShipped).toEqual([{ id: 'T1', title: 'task 1', what: BREAKS }]);
  });

  it('remembers it in the ledger, where the run report cannot reach', async () => {
    await runBatch(config(), [declaring()], stop);

    const mem = h.calls.remembered.find((r) => r.kind === 'breaking_ship');
    expect(mem, 'nothing was written to the ledger').toBeTruthy();
    expect(mem!.reason).toContain(BREAKS);
  });

  it('hands it to the commit message, which is the copy that leaves the machine', async () => {
    await runBatch(config(), [declaring()], stop);

    expect(h.calls.commitMsgs.at(-1)![3]).toBe(BREAKS);
  });

  /*
   * The co-author trailer is OPTIONAL in commitMessage, because a `resolve` of
   * a handed-off task must not claim one. That makes dropping it here a silent
   * change: the argument is allowed to be absent, so typecheck is happy, and
   * git.test.ts proves commitMessage CAN emit the trailer without proving
   * anyone asks it to. This asserts the asking, which is the half that would
   * otherwise fail unobserved and ship unattributed commits.
   */
  it('asks for the co-author trailer on work an agent produced', async () => {
    await runBatch(config(), [declaring()], stop);

    expect(h.calls.commitMsgs.at(-1)![4]).toBe(true);
  });

  it('says none of it about a task that declares nothing', async () => {
    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.committed).toBe(1);
    expect(sum.breakingShipped).toEqual([]);
    expect(h.calls.remembered.filter((r) => r.kind === 'breaking_ship')).toEqual([]);
    expect(h.calls.commitMsgs.at(-1)![3]).toBeUndefined();
  });

  /*
   * The declaration describes what SHIPPING it would change. A task that never
   * shipped changed nothing, and reporting it would put a contract change in
   * front of the operator that no caller can possibly have noticed.
   */
  it('stays quiet when the declared change never shipped', async () => {
    h.state.gate = NO_CHANGES;

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.committed).toBe(0);
    expect(sum.breakingShipped).toEqual([]);
    expect(h.calls.remembered.filter((r) => r.kind === 'breaking_ship')).toEqual([]);
  });
});

/*
 * Finding AO, run 24, task `Tz0vvq7dfn5`.
 *
 * The junior read the code, audited the three functions the brief named,
 * correctly found none of the arithmetic the brief told it to remove, and said
 * ALREADY_DONE. On the way it had read past the live bug - a hard
 * `retrieval_count >= 5` filter sitting in one of those same functions - and
 * set it aside as "filtering logic, not scoring math". True of the brief. Not
 * true of the complaint, which had said "stop deciding by popularity at all".
 *
 * Nobody had shown it the complaint. Four model paraphrases stand between the
 * operator's sentence and the brief - idea to epic, epic to milestone,
 * milestone to task, task to brief - and until this run the brief was the only
 * statement of the job any agent ever saw.
 *
 * These assert on the execute ARGUMENT rather than on the prompt, because the
 * prompt is taskprompt's to build and is proven there. What is proven here is
 * the plumbing: that the executor looks the idea up and that it survives every
 * path a dispatch can take.
 */
describe('the complaint a task came from', () => {
  const IDEA = {
    title: "Unpopular complaints do not count against a document",
    body: "I want it to stop deciding by popularity at all.",
  };

  const briefing = () =>
    ({
      ...config(),
      drivers: { routing: { brief_for: ['agy'], qa_for: [] } },
    }) as unknown as AppConfig;

  it('reaches the agent that has to judge whether the work is already done', async () => {
    h.state.gate = GATE_OK;
    h.state.idea = IDEA;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.agentIdeas).toEqual([IDEA]);
  });

  /*
   * The senior is the reader that can still widen a brief. Giving the intern
   * the complaint and not the person writing its instructions would fix the
   * verdict and leave the plan that caused it exactly as narrow.
   */
  it('reaches the senior writing the brief, in the words the operator used', async () => {
    h.state.gate = GATE_OK;
    h.state.idea = IDEA;

    await runBatch(briefing(), [task(1)], stop);

    const prompt = h.calls.briefPrompts[0] ?? '';
    expect(prompt).toContain(IDEA.body);
    expect(prompt).toContain(IDEA.title);
  });

  /*
   * A stalled dispatch is asked again without charging the attempt. It is the
   * same job, so it has to be told the same thing about it - and the second
   * call is a separate call site, which is exactly where a plumbed argument
   * gets dropped.
   */
  it('carries the same complaint into a redispatch, not just the first try', async () => {
    h.state.gate = GATE_OK;
    h.state.idea = IDEA;
    h.state.execQueue = [
      {
        ok: false,
        reason: 'INCOMPLETE',
        stalled: true,
        stdout: 'the session stopped after a step that finished with reason "unknown"',
        durationMs: 90_000,
        costUnits: 0,
      },
      { ok: true, stdout: 'all done', durationMs: 1000, costUnits: 3 },
    ];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T1']);
    expect(h.calls.agentIdeas).toEqual([IDEA, IDEA]);
  });

  /*
   * Not a degraded state. A repo whose work did not begin with an idea has no
   * operator sentence to show, and inventing one would put a paraphrase in the
   * one slot that exists to hold something that is not a paraphrase.
   */
  it('passes nothing through when the work did not start from an idea', async () => {
    h.state.gate = GATE_OK;
    h.state.idea = null;

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1']);
    expect(h.calls.agentIdeas).toEqual([null]);
  });
});

/*
 * Run 22, task `Txmndc7k0hx`. The plan aimed it at a function that already did
 * what the plan wanted doing, so the junior proved it with a test and committed
 * one test file. The commit went out with `refactor!:` and a BREAKING CHANGE
 * footer, and the report opened a section headed "2 change(s) to existing
 * behaviour shipped" — while the senior's review of that same task said "because
 * no production code was modified, nothing in the repo behaves differently now".
 *
 * `breaking` is a prediction the planner makes from a file tree and a list of
 * names, before the code that would break anyone exists. Nothing compared it to
 * the diff.
 */
describe('a predicted contract change that the diff does not contain', () => {
  const BREAKS = 'callers that index the response break';
  const testsOnlyGate = {
    ok: true,
    detail: '1 file(s), +39/-0',
    diff: { files: ['tests/services/test_feedback_service.py'], insertions: 39, deletions: 0 },
  };

  const declaring = (what: string | null = BREAKS): TaskRow =>
    ({ ...task(1), breaking: what }) as TaskRow;

  it('still ships — this is not a rejection', async () => {
    /*
     * The junior did the best thing available to it. Throwing the test away
     * costs an attempt and the next one hits the same wall, which is the
     * lesson of the TEST_TAMPER rollback. What changes is what gets SAID.
     */
    h.state.gate = testsOnlyGate;

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.committed).toBe(1);
    expect(sum.failed).toBe(0);
  });

  it('withholds the BREAKING CHANGE footer from the commit that leaves the machine', async () => {
    h.state.gate = testsOnlyGate;

    await runBatch(config(), [declaring()], stop);

    expect(h.calls.commitMsgs.at(-1)![3]).toBeUndefined();
  });

  it('does not announce a behaviour change on the report or in the ledger', async () => {
    h.state.gate = testsOnlyGate;

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.breakingShipped).toEqual([]);
    expect(h.calls.remembered.filter((r) => r.kind === 'breaking_ship')).toEqual([]);
  });

  it('says instead that tests shipped and nothing else, naming what was predicted', async () => {
    h.state.gate = testsOnlyGate;

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.testsOnlyShipped).toEqual([
      { id: 'T1', title: 'task 1', predicted: BREAKS },
    ]);
  });

  it('lists a tests-only commit that predicted nothing, with nothing to withdraw', async () => {
    // The milestone closes and the backlog empties either way, which is the
    // thing worth a look. The prediction is a detail on top of that.
    h.state.gate = testsOnlyGate;

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.testsOnlyShipped).toEqual([{ id: 'T1', title: 'task 1', predicted: null }]);
  });

  /*
   * The discriminator. "Touched a test" is the wrong question and would strip
   * the footer off almost every honest breaking change, since changing
   * behaviour that already worked means changing the tests that proved it.
   */
  it('keeps the declaration when one production file moved alongside the tests', async () => {
    h.state.gate = {
      ok: true,
      detail: '2 file(s), +40/-8',
      diff: {
        files: ['app/services/staleness_scoring.py', 'tests/services/test_staleness_scoring.py'],
        insertions: 40,
        deletions: 8,
      },
    };

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.breakingShipped).toEqual([{ id: 'T1', title: 'task 1', what: BREAKS }]);
    expect(sum.testsOnlyShipped).toEqual([]);
    expect(h.calls.commitMsgs.at(-1)![3]).toBe(BREAKS);
  });

  /*
   * Unreachable through the gate — NO_CHANGES catches it first — and asserted
   * anyway, because "every file was a test" is vacuously true of no files and
   * the sentence this produces would be "tests shipped and nothing else" over a
   * commit that shipped nothing. Those are different reports.
   */
  it('does not call an empty diff a tests-only commit', async () => {
    h.state.gate = { ok: true, detail: '0 file(s)', diff: { files: [], insertions: 0, deletions: 0 } };

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.testsOnlyShipped).toEqual([]);
  });

  it('says nothing about a commit that touched no test at all', async () => {
    h.state.gate = GATE_OK;

    const sum = await runBatch(config(), [declaring()], stop);

    expect(sum.testsOnlyShipped).toEqual([]);
    expect(sum.breakingShipped).toEqual([{ id: 'T1', title: 'task 1', what: BREAKS }]);
  });
});

/*
 * Finding AE, run 19. Two tasks planned in one batch both claimed
 * app/api/search.py. The first shipped `search_documents_paginated` and wired
 * the endpoint to it; the second, briefed an hour later, wired the endpoint
 * back off it and left the new function with one caller - a compatibility shim
 * passing limit=1000. Both gates were green, the suite was at 197, and the
 * first task's acceptance was false by the time the run finished.
 *
 * The drift verdict fired at exactly the right moment and was logged and
 * dropped. These guard the sentence that now reaches the senior instead.
 */
describe('what this run already landed in a file the next task claims', () => {
  const drifted = (over: Record<string, unknown> = {}) =>
    ({
      verdict: 'DRIFTED' as const,
      evidence: 'app/api/search.py changed in 8bcbd743 since this task was planned',
      driftedBy: { sha: '8bcbd743735f', path: 'app/api/search.py', taskId: 'Tcl85f6dpe9' },
      ...over,
    }) as never;

  const prior = {
    id: 'Tcl85f6dpe9',
    title: 'Paginate core document search API',
    acceptance: 'the endpoint accepts limit and offset and returns total and items',
  } as never;

  it('hands over the prior task title, its acceptance, and where it landed', () => {
    const note = priorWorkNote(drifted(), () => prior);

    expect(note).toContain('app/api/search.py');
    expect(note).toContain('8bcbd743');
    expect(note).toContain('Paginate core document search API');
    expect(note).toContain('accepts limit and offset');
  });

  /*
   * The acceptance is the whole payload. A senior told only that a file changed
   * learns nothing the symbol list has not already shown it - the tree is read
   * fresh at dispatch and already contains the commit. What it cannot see is
   * that the change was ours and what it was accepted for.
   */
  it('says the prior acceptance still has to hold', () => {
    expect(priorWorkNote(drifted(), () => prior)).toMatch(/still has to be true/i);
  });

  it('gives a way out rather than a prohibition', () => {
    // Two tasks touching one file is ordinary and usually right. Refusing the
    // second outright would park live work over a path match; the guard here
    // is against doing it blind, not against doing it.
    const note = priorWorkNote(drifted(), () => prior);
    expect(note).toMatch(/cannot be done without undoing it/i);
    expect(note).toMatch(/objective/i);
  });

  it('says nothing when the commit came from outside this system', () => {
    // The repo owner editing by hand drifts a task the same way. There is no
    // acceptance behind that commit, and the tree is the best evidence for it.
    const note = priorWorkNote(drifted({ driftedBy: { sha: 'deadbeef', path: 'a.py', taskId: null } }), () => prior);
    expect(note).toBe('');
  });

  it('says nothing when the task is FRESH', () => {
    expect(priorWorkNote({ verdict: 'FRESH', evidence: '' } as never, () => prior)).toBe('');
  });

  /*
   * A ledger that has lost the row - a fresh database replaying an old claim,
   * or a task deleted between commit and dispatch - must degrade to the
   * behaviour that shipped every run before this one, not to a sentence with a
   * hole in it. The senior reads this literally.
   */
  it('says nothing when the prior task cannot be looked up', () => {
    expect(priorWorkNote(drifted(), () => null)).toBe('');
    expect(priorWorkNote(drifted(), () => ({ id: 'x', title: 't', acceptance: '' }) as never)).toBe('');
  });
});

/*
 * Finding AE end to end: a task dispatched into a file this run already
 * committed to must be briefed knowing that.
 *
 * The unit tests above prove priorWorkNote builds the right sentence and that
 * authorBrief will carry one. Run 19 proves that is not enough - every piece of
 * that chain existed and worked, and the verdict still reached nothing but a
 * log line. This drives the whole path.
 */
describe('a task planned into a file this run has since committed', () => {
  const briefed = () =>
    ({
      ...config(),
      drivers: { routing: { brief_for: ['agy'], qa_for: [] } },
    }) as unknown as AppConfig;

  /** HEAD has moved, and the commit that moved it touched this task's file. */
  const afterOurOwnCommit = (taskId: string | null) => {
    h.state.claim = {
      task_id: 'T1',
      plan_head: 'head0',
      planned_at: '2026-08-23T04:55:00Z',
      paths: ['app/api/search.py'],
      symbols: [],
      claim_key: 'k',
    };
    h.state.head = 'head9';
    h.state.commits = [{ sha: '8bcbd743735f' }];
    h.state.resolutions = [
      {
        id: 'R1',
        repo: 'r1',
        resolved_at: '2026-08-23T05:07:00Z',
        kind: 'external_commit',
        commit_sha: '8bcbd743735f',
        paths: ['app/api/search.py'],
        symbols: [],
        reason: null,
        task_id: taskId,
        claim_key: null,
        occurred_at: null,
      },
    ];
    h.state.priorTask = {
      id: 'Tcl85f6dpe9',
      title: 'Paginate core document search API',
      acceptance: 'the endpoint accepts limit and offset and returns total and items',
    };
  };

  it('tells the senior what landed there and what it was accepted for', async () => {
    h.state.gate = GATE_OK;
    afterOurOwnCommit('Tcl85f6dpe9');

    await runBatch(briefed(), [task(1)], stop);

    const prompt = h.calls.briefPrompts[0] ?? '';
    expect(prompt).toContain('ALREADY CHANGED BY THIS RUN: app/api/search.py');
    expect(prompt).toContain('Paginate core document search API');
    expect(prompt).toContain('accepts limit and offset');
  });

  it('dispatches it anyway', async () => {
    // Two tasks touching one file is ordinary. The verdict is information for
    // the senior, never a reason to park work over a path match - and a guard
    // that quietly stopped dispatching would be far worse than the fault.
    h.state.gate = GATE_OK;
    afterOurOwnCommit('Tcl85f6dpe9');

    const sum = await runBatch(briefed(), [task(1)], stop);

    expect(sum.committed).toBe(1);
  });

  it('says nothing when the commit was not ours', async () => {
    // The repo owner editing by hand drifts a task identically. There is no
    // acceptance sentence behind that, and inventing one would be a lie the
    // senior plans against.
    h.state.gate = GATE_OK;
    afterOurOwnCommit(null);

    await runBatch(briefed(), [task(1)], stop);

    expect(h.calls.briefPrompts[0] ?? '').not.toContain('ALREADY CHANGED BY THIS RUN:');
  });

  it('says nothing when nothing has landed since the task was planned', async () => {
    // The overwhelmingly common case, and the one every other test in this
    // file runs: HEAD where it was, so the verdict is FRESH before it looks.
    h.state.gate = GATE_OK;

    await runBatch(briefed(), [task(1)], stop);

    expect(h.calls.briefPrompts[0] ?? '').not.toContain('ALREADY CHANGED BY THIS RUN:');
  });
});

/*
 * Finding AU, run 31. `opencode` hung on four dispatches in a row - two tasks,
 * two attempts each - and every one ran the full 900s budget before being
 * killed. An hour of wall clock, both tasks left `failed` with no attempts
 * left, and one of them was "use argparse so --help works". The same binary
 * answered a trivial prompt correctly minutes later.
 *
 * Run 23 taught this about a provider returning NOTHING and the fix has held
 * since. A provider that HANGS is the same event with a different reason
 * string, and was not covered: TIMEOUT fell through to the ordinary retry path,
 * which charges the task for the outage and moves on to do it again.
 */
describe('a provider that hangs', () => {
  const TIMED_OUT = {
    ok: false,
    reason: 'TIMEOUT',
    stdout: '',
    durationMs: 900_000,
    costUnits: 0,
  };
  const WORKED = { ok: true, stdout: 'all done', durationMs: 1000, costUnits: 3 };

  beforeEach(() => {
    h.state.gate = GATE_OK;
  });

  it('charges the first timeout to the task, which may simply be too big', () => {
    // One task running long is a fact about that task. Pulling an agent on a
    // single timeout would take a working provider out over one large job.
    h.state.execQueue = [TIMED_OUT, WORKED];

    return runBatch(config(), [task(1)], stop).then((sum) => {
      expect(h.calls.bumps).toContain('T1');
      expect(sum.agentsOut).toEqual([]);
    });
  });

  it('takes the agent out on the second, and hands the attempt back', async () => {
    /*
     * The same agent timing out on a DIFFERENT task straight afterwards is a
     * fact about the agent. Refunded for the same reason the stalled branch
     * refunds: the agent never got far enough to be judged.
     */
    h.state.execQueue = [TIMED_OUT, TIMED_OUT];

    const sum = await runBatch(config(), [task(1), task(2)], stop);

    expect(sum.agentsOut.map((a) => a.agent)).toEqual(['agy']);
    // The budget comes from config, so the message must quote config rather
    // than a number someone typed twice.
    expect(sum.agentsOut[0]?.why).toMatch(/ran the full \d+s budget/);
    expect(h.calls.refunds).toContain('T2');
  });

  it('says nothing was wrong with the task, because nothing was', () => {
    h.state.execQueue = [TIMED_OUT, TIMED_OUT];

    return runBatch(config(), [task(1), task(2)], stop).then((sum) => {
      expect(sum.agentsOut[0]?.why).toMatch(/Nothing was wrong with the task/);
    });
  });

  it('leaves the second task ready rather than failed', async () => {
    // A task marked `failed` over an outage is one the operator has to notice
    // and retry by hand - which is the whole cost of run 31.
    h.state.execQueue = [TIMED_OUT, TIMED_OUT];

    await runBatch(config(), [task(1), task(2)], stop);

    const t2 = h.calls.status.filter((s) => s.id === 'T2');
    expect(t2.at(-1)?.status).toBe('ready');
  });

  it('forgets the run of timeouts as soon as the agent answers', async () => {
    /*
     * Consecutive, not cumulative. An agent that times out, recovers, and later
     * times out once more has not failed twice in a row, and pulling it on the
     * second would take out a provider that is working.
     */
    h.state.execQueue = [TIMED_OUT, WORKED, TIMED_OUT];

    const sum = await runBatch(config(), [task(1), task(2), task(3)], stop);

    expect(sum.agentsOut).toEqual([]);
  });

  it('forgets them when the agent fails some other way', async () => {
    // A gate rejection means the provider ran. Whatever is wrong, it is not
    // that the provider has stopped answering.
    h.state.execQueue = [
      TIMED_OUT,
      { ok: false, reason: 'VERIFY_FAIL', stdout: 'tests failed', durationMs: 100, costUnits: 2 },
      TIMED_OUT,
    ];

    const sum = await runBatch(config(), [task(1), task(2), task(3)], stop);

    expect(sum.agentsOut).toEqual([]);
  });

  it('starts each run with a clean slate', async () => {
    // An agent that hung yesterday is not out today before it has been asked.
    h.state.execQueue = [TIMED_OUT];
    await runBatch(config(), [task(1)], stop);

    h.state.execQueue = [TIMED_OUT, WORKED];
    const sum = await runBatch(config(), [task(2), task(3)], stop);

    expect(sum.agentsOut).toEqual([]);
  });
});

/*
 * Finding AZ, 2026-08-28. The operator: "shanauto should complete its work no
 * matter how much quota is needed", and rework caught by the senior counts as
 * the system working, not as a failure.
 *
 * Every cap in this file was justified by protecting quota — `max_attempts: 2`,
 * one milestone re-plan, "a second is how quota disappears overnight". That
 * justification is withdrawn. What replaces it is not "no limit" but a limit on
 * REPETITION: keep going while each attempt fails in a new way, stop when it
 * starts repeating itself.
 *
 * Two drafts of this hung the suite rather than failing it, and both made the
 * same mistake: termination that depended on somebody else updating something.
 * The first asked `attempt < maxAttempts` before checking repetition, and the
 * harness pins `attempt` to 1. The second read the previous reason off the
 * TaskRow, which the caller never refreshes between attempts. The state that
 * decides this is now written and read in one place.
 */
describe('when it is worth another go', () => {
  it('always gives a first failure another attempt', () => {
    expect(keepTrying('T1', 1, 4, 'VERIFY_FAIL: two tests red')).toBe(true);
  });

  it('stops the moment a failure repeats itself', () => {
    // Failing the same way twice has taught nothing, and maxAttempts cannot
    // buy a third identical try.
    keepTrying('T2', 1, 4, 'VERIFY_FAIL: two tests red');
    expect(keepTrying('T2', 2, 4, 'VERIFY_FAIL: two tests red')).toBe(false);
  });

  it('keeps going while the failure keeps changing', () => {
    keepTrying('T3', 1, 4, 'VERIFY_FAIL: two tests red');
    expect(keepTrying('T3', 2, 4, 'VERIFY_FAIL: one test red')).toBe(true);
    expect(keepTrying('T3', 3, 4, 'DEAD_EXPORT: main is unreferenced')).toBe(true);
    expect(keepTrying('T3', 4, 4, 'QA_REWORK: the test cannot fail')).toBe(true);
  });

  it('goes past maxAttempts while it is still moving', () => {
    /*
     * The whole point. Under the old rule this task was dead at attempt 2 with
     * the work undelivered; the operator asked for it to finish the job.
     */
    keepTrying('T4', 1, 2, 'first');
    expect(keepTrying('T4', 2, 2, 'second')).toBe(true);
    expect(keepTrying('T4', 5, 2, 'fifth')).toBe(true);
  });

  it('stops at a ceiling however much it is still moving', () => {
    // Not a budget — a guarantee of termination. A run that never ends
    // delivers nothing, which fails the same goal as one that gives up early.
    keepTrying('T5', 1, 4, 'a');
    expect(keepTrying('T5', 12, 4, 'something new every time')).toBe(false);
  });

  it('treats line numbers and timings as noise, not as progress', () => {
    /*
     * Otherwise a test that fails identically but reports a different duration
     * looks like movement every time, and nothing ever stops.
     */
    keepTrying('T6', 1, 4, 'VERIFY_FAIL: 3 tests red in 12.4s at line 118');
    expect(keepTrying('T6', 2, 4, 'VERIFY_FAIL: 9 tests red in 30.1s at line 274')).toBe(false);
  });

  it('treats a different path as noise too', () => {
    keepTrying('T7', 1, 4, String.raw`wrote C:\Users\a\tmp\x.py`);
    expect(keepTrying('T7', 2, 4, String.raw`wrote C:\Users\b\tmp\y.py`)).toBe(false);
  });

  it("keeps each task's history to itself", () => {
    // One task repeating must never end a different task that is progressing.
    keepTrying('T8', 1, 4, 'same reason');
    expect(keepTrying('T9', 1, 4, 'same reason')).toBe(true);
  });
});


/**
 * O27 — the one outcome nobody checked.
 *
 * `ALREADY_DONE` closed a task on the strength of a sentence from the agent
 * that made the claim. Both guards on the path asked whether it was ASSERTED;
 * nothing asked whether it was TRUE. It is also the most expensive outcome to
 * get wrong, because a drop writes `already_done` into the planner's dedupe and
 * the proposal that would have built the thing never comes back.
 *
 * What `checkDropClaim` reads off the tree is covered in dropcheck.test.ts.
 * What is covered here is the half that lived in the executor and that deleting
 * would leave those tests green: whether the verdict changes what happens.
 */
describe('a task that says the work was already there', () => {
  const ALREADY = {
    ok: true,
    stdout: 'Everything the brief asks for is present.\nALREADY_DONE',
    durationMs: 1000,
  };

  beforeEach(() => {
    h.state.exec = ALREADY;
  });

  it('is dropped when the plan\'s own record confirms it', async () => {
    h.state.dropCheck = { verdict: 'confirmed', evidence: 'add_expense is present in cli.py' };

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.dropped).toBe(1);
    expect(netFailed(sum)).toBe(0);
    // The evidence travels with it, because this row is what the planner's
    // dedupe reads later and "it said so" is not the same as "it was checked".
    const status = h.calls.status.find((s) => s.status === 'dropped');
    expect(status?.reason).toContain('add_expense is present');
  });

  it('is still dropped when nothing could check it, and says so', async () => {
    // 27 of 77 claims in the ledger declare no symbols. Refusing to drop those
    // would turn an honest absence of evidence into a rejection.
    h.state.dropCheck = { verdict: 'unchecked', evidence: 'it declared no symbols' };

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.dropped).toBe(1);
    const status = h.calls.status.find((s) => s.status === 'dropped');
    expect(status?.reason).toContain('not verified');
  });

  it('is NOT dropped when the plan says the work is missing', async () => {
    h.state.dropCheck = {
      verdict: 'contradicted',
      missing: ['summarise'],
      evidence: 'summarise appears nowhere in cli.py',
    };
    h.state.refillWith = [task(1)];

    const sum = await runBatch(config(), [task(1)], stop);

    expect(sum.dropped).toBe(0);
    expect(netFailed(sum)).toBe(1);
  });

  it('never teaches the dedupe that contradicted work exists', async () => {
    /*
     * The whole cost of O27. A wrong `already_done` suppresses the proposal
     * that would have built the feature, permanently, and nothing retracts it —
     * so this is the assertion that matters most in the file.
     */
    h.state.dropCheck = {
      verdict: 'contradicted',
      missing: ['summarise'],
      evidence: 'summarise appears nowhere in cli.py',
    };
    h.state.refillWith = [task(1)];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.remembered.some((r) => r.kind === 'already_done')).toBe(false);
  });

  it('tells the retry exactly what was missing', async () => {
    h.state.dropCheck = {
      verdict: 'contradicted',
      missing: ['summarise'],
      evidence: 'summarise appears nowhere in cli.py',
    };
    h.state.refillWith = [task(1)];

    await runBatch(config(), [task(1)], stop);

    const note = h.calls.journal.find((e) => e.stage === 'note');
    expect(note?.detail).toContain('summarise');
    expect(note?.detail).toContain('ALREADY_DONE');
  });

  it('gives up on a second identical contradiction rather than arguing forever', async () => {
    // An agent that insists twice is not going to be talked round, and the
    // ordinary repetition rule is what ends it.
    h.state.dropCheck = {
      verdict: 'contradicted',
      missing: ['summarise'],
      evidence: 'summarise appears nowhere in cli.py',
    };
    h.state.refillWith = [task(1)];

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.dispatched).toEqual(['agy:T1', 'agy:T1']);
    expect(h.calls.status.some((s) => s.status === 'failed')).toBe(true);
  });
});


/**
 * O24 — a rejected task's work survives only as a stash, and every stash was
 * called the same thing.
 *
 * example-api held 38 of them, each `shanauto-rollback <timestamp>` with no task
 * id and no reason, so "restore the newest" was a coin toss over which rejected
 * task you got back. One of those entries was run 21's real fix for the
 * global-slice bug, found again only by reading diffs.
 *
 * `git.ts` builds the label and is tested there. What is tested here is that
 * anything is handed to it at all — removing the argument left all 199 of the
 * other tests green.
 */
describe('what a rollback is told to call the work it sets aside', () => {
  it('names the task when the gate rejects it', async () => {
    h.state.gate = {
      ok: false,
      failure: 'VERIFY_FAIL',
      detail: 'two tests red',
      diff: { files: ['src/a.ts'], insertions: 5, deletions: 0 },
    };

    await runBatch(config(), [task(1)], stop);

    expect(h.calls.rollbacks.join(' ')).toContain('T1');
    expect(h.calls.rollbacks.join(' ')).toContain('task 1');
  });

  it('names the task and how it failed when it never reached the gate', async () => {
    h.state.exec = { ok: false, reason: 'INCOMPLETE', stdout: 'stopped', durationMs: 1000 };

    await runBatch(config(), [task(1)], stop);

    const said = h.calls.rollbacks.join(' ');
    expect(said).toContain('T1');
    expect(said).toContain('INCOMPLETE');
  });
});
