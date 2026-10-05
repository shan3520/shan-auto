import { z } from 'zod';

/* ---------- config ---------- */

/**
 * Per-repo routing. Either slot may be omitted, and an omitted slot falls back
 * to the global `routing` block in drivers.yaml.
 *
 * Routing used to be global only, which cost a whole quota. On 2026-08-08 agy
 * turned out to be structurally unable to work on Python: its permission
 * allow-list matches whole command strings with no wildcard support (verified —
 * adding `command(python -m pytest *)` still left `python -m pytest
 * tests/test_health.py` denied), and Python work has to run named test files.
 * Both global slots therefore went to copilot, which also idled agy's separate
 * quota on the TypeScript repo where it works fine.
 */
export const RepoRoutingSchema = z.object({
  complex_agent: z.string().optional(),
  simple_agent: z.string().optional(),
});
export type RepoRouting = z.infer<typeof RepoRoutingSchema>;

export const RepoSchema = z.object({
  id: z.string(),
  path: z.string(),
  branch: z.string().default('main'),
  stack: z.string().default('unknown'),
  verify_cmd: z.string(),
  /**
   * The ONE command an agent may run to check its own work before finishing.
   *
   * Separate from `verify_cmd` because the two have different audiences. The
   * gate runs `verify_cmd` itself, in a real shell, so it can be a compound.
   * This one has to survive agy's allow-list, which matches command strings
   * token-for-token with no prefixes and no globs (agy issue #614) — so a
   * compound, an extra flag or a named test file are all auto-denied, and a
   * denial in headless mode has nobody to prompt.
   *
   * Optional. Without it an agent is told not to run anything, which is safe
   * and blind: measured 2026-08-15, agy tried `pytest tests/services/
   * test_search.py`, was denied, and shipped code that broke three tests it
   * could not see.
   *
   * Must be a single command that is actually on the agent's allow-list. It is
   * a self-check, not the gate — `verify_cmd` still decides the commit.
   */
  agent_check_cmd: z.string().optional(),
  enabled: z.boolean().default(true),
  weight: z.number().int().positive().default(1),
  /**
   * Hard override for this repo's slice of `system.max_daily_commits`. Normally
   * omitted: the slice is derived from `weight`, so there is only one number to
   * keep honest. Set it when a project's share genuinely differs from its
   * scheduling priority. Never lifts the global ceiling — see core/allocator.ts.
   */
  max_daily_commits: z.number().int().positive().optional(),
  routing: RepoRoutingSchema.optional(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const ReposFileSchema = z.object({ repos: z.array(RepoSchema) });

/**
 * How long `sa prune` keeps the gitignored working record. Days; 0 = forever.
 *
 * Every field defaults to 0, and the whole block defaults to absent, so a config
 * that has never heard of retention deletes nothing. That is deliberate: this is
 * the only setting in the file whose failure mode is losing data, so it has to
 * be asked for in writing rather than inherited.
 */
export const RetentionSchema = z.object({
  journal_days: z.number().int().nonnegative().default(0),
  artifact_days: z.number().int().nonnegative().default(0),
  run_log_days: z.number().int().nonnegative().default(0),
  /** `shanauto-rollback` stashes in each allowlisted project. See prune.ts. */
  rollback_stash_days: z.number().int().nonnegative().default(0),
});
export type RetentionConfig = z.infer<typeof RetentionSchema>;

export const SystemSchema = z.object({
  daily_target: z.number().int().positive(),
  max_daily_commits: z.number().int().positive(),
  overselect: z.number().int().nonnegative().default(4),
  work_hours: z.object({ start: z.string(), end: z.string() }),
  timeouts: z.object({
    task_s: z.number(),
    verify_s: z.number(),
    brain_s: z.number(),
  }),
  limits: z.object({
    max_attempts: z.number().int(),
    max_files_per_task: z.number().int(),
    min_insertions: z.number().int(),
    scope_blowout_multiplier: z.number(),
    max_run_hours: z.number(),
    /** Reject commits that add an export no production code references. */
    forbid_dead_exports: z.boolean().default(true),
  }),
  backlog: z.object({
    min_ready: z.number().int(),
    tasks_per_milestone: z.tuple([z.number().int(), z.number().int()]),
  }),
  brain: z.object({
    model: z.string(),
    fallback_model: z.string().optional(),
    max_repair_attempts: z.number().int().default(2),
  }),
  /**
   * Soft ceiling on what agents may spend in a day. Defaulted end to end — both
   * the block and the value inside it — so a system.yaml written before this
   * existed still loads, with the budget off and behaviour unchanged.
   */
  budget: z
    .object({
      /** 0 means unlimited. Exceeding this warns; it never stops a run. */
      daily_agent_units: z.number().nonnegative().default(0),
    })
    .default({}),
  notify: z.object({
    on_run_complete: z.boolean().default(true),
    on_failure: z.boolean().default(true),
  }),
  retention: RetentionSchema.default({}),
});
export type SystemConfig = z.infer<typeof SystemSchema>;

/**
 * Any driver config block from config/drivers.yaml.
 *
 * `module`, plus the security-relevant fields the drivers read, with defaults so
 * an omitted value never reaches a driver as undefined. `passthrough` keeps
 * every driver-specific field. The defaults are the locked, safe ones: omitted
 * `sandbox` means ON, omitted `skip_permissions` means off, omitted `deny`
 * means no extra rules. Production has to write `sandbox: false` *explicitly* to
 * switch enforcement to agy's settings.json allow-list — see agent.agy.ts for
 * what that means.
 */
const DriverEntry = z
  .object({
    module: z.string(),
    /** agy: sandboxed by default — the sandbox is the only thing that contains an unattended shell. */
    sandbox: z.boolean().default(true),
    /** agy: `--dangerously-skip-permissions` is never a safe default. */
    skip_permissions: z.boolean().default(false),
    /** copilot: extra `shell(...)` deny rules, appended to the built-in list. */
    deny: z.array(z.string()).default([]),
  })
  .passthrough();

export const DriversSchema = z.object({
  brain: z.object({ active: z.string(), registry: z.record(DriverEntry) }),
  chat: z.object({
    active: z.string(),
    enabled: z.boolean().default(false),
    registry: z.record(DriverEntry),
  }),
  agents: z.object({ registry: z.record(DriverEntry) }),
  routing: z.object({
    default: z.string(),
    /**
     * Agents eligible for each size of work. Lists, not single ids: complex work
     * is shared across capable agents so the hard jobs draw on more than one
     * provider quota, which is the binding constraint here.
     */
    complex_agents: z.array(z.string()).default([]),
    simple_agents: z.array(z.string()).default([]),
    /** Superseded by the lists above; kept so an old drivers.yaml still loads. */
    complex_agent: z.string().optional(),
    simple_agent: z.string().optional(),
    complexity: z
      .object({
        min_est_lines: z.number().int().default(25),
        min_files: z.number().int().default(2),
        complex_kinds: z.array(z.string()).default(['feature', 'refactor', 'bugfix']),
      })
      .default({}),
    /**
     * Agents that receive a senior-authored brief instead of the planner's
     * freeform instruction. The intern half of the senior/intern split.
     *
     * Empty — the default — is the behaviour that existed before briefs, and is
     * also the correct setting for an agent that IS the senior: briefing agy
     * with agy's own plan would spend a model call to tell it what it just said.
     */
    brief_for: z.array(z.string()).default([]),
    /**
     * Agents whose work the senior reviews after the gate passes and before
     * anything is committed. The other half of the senior/intern split.
     *
     * Separate from `brief_for` on purpose. Reviewing is useful on work
     * that was never briefed, and a shop that briefs but never checks the result
     * has a plan nobody reads. Listing the senior itself here would have it
     * mark its own homework.
     */
    qa_for: z.array(z.string()).default([]),
    /** Explicit kind->agent overrides. These win over the complexity split. */
    rules: z.array(z.object({ kinds: z.array(z.string()), agent: z.string() })).default([]),
  }),
});
export type DriversConfig = z.infer<typeof DriversSchema>;

/* ---------- brain output (untrusted: always validated) ---------- */

export const TaskKind = z.enum([
  'feature',
  'test',
  'refactor',
  'docs',
  'config',
  'bugfix',
]);
export type TaskKindT = z.infer<typeof TaskKind>;

/**
 * Models drift on enum values ("code" instead of "cli", "chore" instead of
 * "config"). Coercing here instead of bouncing the whole response saves a repair
 * round-trip, which matters when the binding constraint is provider quota rather
 * than tokens. Genuinely unmappable values still fail validation.
 */
const KIND_ALIASES: Record<string, TaskKindT> = {
  feat: 'feature',
  feature: 'feature',
  implement: 'feature',
  implementation: 'feature',
  build: 'feature',
  integrate: 'feature',
  verify: 'test',
  validation: 'test',
  chore: 'config',
  config: 'config',
  setup: 'config',
  test: 'test',
  tests: 'test',
  testing: 'test',
  refactor: 'refactor',
  cleanup: 'refactor',
  docs: 'docs',
  doc: 'docs',
  documentation: 'docs',
  fix: 'bugfix',
  bugfix: 'bugfix',
  bug: 'bugfix',
};

const LenientKind = z.preprocess(
  (v) => (typeof v === 'string' ? (KIND_ALIASES[v.trim().toLowerCase()] ?? v) : v),
  TaskKind,
);

const LenientExecutor = z.preprocess(
  (v) => (typeof v === 'string' && /^(ide|gui|desktop|antigravity)$/i.test(v.trim()) ? 'ide' : 'cli'),
  z.enum(['cli', 'ide']),
);

export const PlannedTaskSchema = z.object({
  title: z.string().min(3).max(120),
  kind: LenientKind,
  instruction: z.string().min(10),
  acceptance: z.string().min(3),
  files_hint: z.array(z.string()).default([]),
  verify_cmd: z.string().min(1),
  depends_on: z.array(z.number().int().nonnegative()).default([]),
  est_lines: z.number().int().positive().default(20),
  executor_hint: LenientExecutor.default('cli'),
  /**
   * What already-working behaviour this task changes, when it changes any.
   *
   * Deliberately not a `kind`. It is orthogonal to one - a feature, a refactor
   * and a bugfix can each break a caller - and folding it in would have forced
   * a choice between "this adds something" and "this breaks something" on a
   * task where both are true. Optional, because most tasks break nothing and a
   * required field that is nearly always empty gets filled with noise.
   */
  breaking: z.string().min(3).max(300).optional(),
  /**
   * What this task intends to produce, used to detect before dispatch that
   * something else already produced it. Optional throughout: a task without a
   * claim simply always reads as FRESH, which is the pre-existing behaviour.
   */
  claim: z
    .object({
      paths: z.array(z.string()).default([]),
      symbols: z.array(z.string()).default([]),
    })
    .optional(),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

/*
 * `tasks` may be empty, but only with a reason.
 *
 * decompose.md tells the model to return zero tasks when a milestone is already
 * built, and until 2026-08-18 `.min(1)` made that exact answer a schema
 * violation. On 2026-08-18 both models opened with `{"tasks":[]}` — obeying the
 * prompt — were told their answer was malformed, and were driven by the repair
 * loop into fabricating a placeholder task that the merits gate then rejected.
 * Six model calls and ~140s produced nothing because the schema forbade the
 * correct answer. The prompt and the schema must sanction the same set.
 *
 * Requiring the reason is what stops this becoming a shrug: a bare empty array
 * cannot distinguish "already built" from "I would rather not", and those two
 * must never share an outcome. The refine message is the text the repair prompt
 * shows the model, so it names the way out rather than only the problem.
 */
export const DecomposeSchema = z
  .object({
    tasks: z.array(PlannedTaskSchema),
    nothing_to_do: z.string().optional(),
  })
  .refine((d) => d.tasks.length > 0 || (d.nothing_to_do ?? '').trim().length > 0, {
    message:
      'returned zero tasks with no explanation. Either propose at least one task, or set ' +
      '"nothing_to_do" to the specific reason no work is left in this milestone, naming the ' +
      'symbols or files that already provide it.',
  });

/*
 * The senior engineer's brief to the intern.
 *
 * agy plans; opencode implements. This is the handoff, and it is the whole
 * product of the senior role — everything agy decides has to survive in here,
 * because it is the only thing the intern ever sees of agy's thinking.
 *
 * agy authors every field. ShanAuto renders them to XML (see core/brief.ts) and
 * does not write, template, or infer any of the content. The reason the model
 * fills a schema instead of emitting angle brackets directly is that the brain
 * contract is "ONLY a fenced json block" and the whole repair loop is built on
 * zod: raw XML is unvalidatable, so a malformed brief would land in front of the
 * intern with nothing able to catch it. Measured 2026-08-21, agy returns an
 * unusable answer to a planning prompt often enough that this is not
 * theoretical. Authorship is agy's; typesetting is not worth a defect class.
 */
export const BriefSchema = z.object({
  /** What to build, in prose, as one paragraph. */
  objective: z.string().min(20),
  /*
   * WHY the change is wanted. Not decoration: the intern makes a hundred micro
   * decisions the brief cannot enumerate, and the only thing that makes those
   * come out consistently is knowing what the code is for.
   */
  rationale: z.string().min(20),
  /*
   * What already exists and must be used rather than reinvented. The single
   * most common way an intern task produces a duplicate helper is that nobody
   * told it the helper was there.
   */
  reuse: z
    .array(
      z.object({
        path: z.string().min(1),
        symbol: z.string().optional(),
        why: z.string().min(3),
      }),
    )
    .default([]),
  /** Ordered, per-file steps. This is the plan, and the intern may not alter it. */
  implementation: z
    .array(
      z.object({
        path: z.string().min(1),
        action: z.enum(['create', 'modify']),
        steps: z.array(z.string().min(3)).min(1),
      }),
    )
    .min(1),
  /*
   * What each test must PROVE — never whose style to copy.
   *
   * This field exists because of a measured defect. On 2026-08-21 a hand-written
   * brief said "follow the fixtures and session-handling style already used in
   * this file", the file was one of two mock-shaped files in the repo, and both
   * agy and three of eight intern models faithfully produced tests whose
   * `scalar.side_effect = [2, 10]` returns the same pair no matter what the
   * query filters on. The shipped result: a 30-day window that can be replaced
   * with a 1970 epoch while 157 tests keep passing.
   *
   * A style reference is an instruction the model can satisfy without testing
   * anything. A property — "must fail if the window is widened" — is not.
   * `must_prove` is therefore phrased as the defect the test has to catch, and
   * the authoring prompt refuses anything that names a style instead.
   */
  tests: z
    .array(
      z.object({
        path: z.string().min(1),
        must_prove: z.string().min(10),
      }),
    )
    .min(1),
  /** Hard don'ts specific to this task, on top of the standing constraints. */
  constraints: z.array(z.string().min(3)).default([]),
  /** Done means exactly this. */
  acceptance: z.string().min(10),
});
export type Brief = z.infer<typeof BriefSchema>;

/**
 * What the senior may reject an intern's work for.
 *
 * A closed set, and the whole point of the field. Left open, a review becomes a
 * wishlist — naming, structure, "I would have done it differently" — and every
 * one of those rejections costs a full re-implementation and can repeat forever.
 * These three are the only things that make a green, in-scope change unfit to
 * ship:
 *
 *   defect    the code is wrong; here is the input that breaks it
 *   untested  a test cannot fail — it asserts on a mock, or on nothing
 *   off_brief the design in the brief was not implemented, or was replaced
 *
 * `off_brief` exists because the intern is told the brief is not a suggestion.
 * A rule nothing checks is a rule the intern learns it can ignore.
 */
export const QA_SEVERITIES = ['defect', 'untested', 'off_brief'] as const;

export const QaReviewSchema = z.object({
  verdict: z.enum(['ship', 'rework']),
  /** One or two sentences for the journal, whichever way the verdict went. */
  summary: z.string().min(10),
  /**
   * Why it must not ship. Empty on `ship` — a finding is a reason to reject,
   * not a remark, and a review that ships with objections attached teaches the
   * next reader that objections are optional.
   */
  findings: z
    .array(
      z.object({
        file: z.string().min(1),
        severity: z.enum(QA_SEVERITIES),
        /** The defect itself: what is wrong, concretely enough to disagree with. */
        detail: z.string().min(20),
        /** What the intern should do instead. A rejection without one is a complaint. */
        fix: z.string().min(10),
      }),
    )
    .default([]),
});
export type QaReview = z.infer<typeof QaReviewSchema>;
export type QaFinding = QaReview['findings'][number];


/**
 * A task after defaults have been explicitly applied. Everything downstream of
 * the planner uses this, so no inference quirk in zod can let an `undefined`
 * reach the ledger or an agent prompt.
 */
export interface NormalizedTask {
  title: string;
  kind: TaskKindT;
  instruction: string;
  acceptance: string;
  files_hint: string[];
  verify_cmd: string;
  depends_on: number[];
  est_lines: number;
  executor_hint: 'cli' | 'ide';
  /**
   * Set only when the planner declared a change to behaviour that already
   * works. Absent means nothing was declared - which is also what every task
   * planned before this existed carries, so those read exactly as they did.
   */
  breaking?: string;
  /**
   * Optional by design. Tasks created before this feature, or by anything other
   * than the planner, carry none — and a task with no claim simply always reads
   * as FRESH, which is exactly the pre-existing behaviour.
   */
  claim?: { paths: string[]; symbols: string[] };
}

export const ShapeSchema = z.object({
  epics: z
    .array(
      z.object({
        title: z.string().min(3),
        summary: z.string().default(''),
        milestones: z
          .array(z.object({ title: z.string().min(3), detail: z.string().default('') }))
          .min(1),
      }),
    )
    .min(1),
});

/* ---------- runtime ---------- */

export interface DailyCommitCount {
  date: string;
  count: number;
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'committed'
  | 'failed'
  | 'blocked'
  | 'handoff'
  | 'dropped';

export interface TaskRow {
  id: string;
  milestone_id: string | null;
  repo: string;
  title: string;
  kind: TaskKindT;
  instruction: string;
  acceptance: string;
  files_hint: string;
  verify_cmd: string;
  depends_on: string;
  est_lines: number;
  executor_hint: string;
  /** NULL for every task planned before this column existed, and for every
   *  task that declares no change to existing behaviour. The two are the same
   *  thing to every reader: nothing was declared. */
  breaking: string | null;
  status: TaskStatus;
  attempts: number;
  last_error: string | null;
  commit_sha: string | null;
  /*
   * The senior engineer's XML brief for this task, or null when no senior
   * authored one. Stored rather than rebuilt so that what the intern was
   * actually told survives the run: when a commit turns out wrong, the brief is
   * the first thing worth reading, and re-asking the model would produce a
   * different one.
   */
  brief: string | null;
  ord: number;
  created_at: string;
  updated_at: string;
}

/**
 * Runtime mirror of TaskRow's keys, checked against the real `tasks` columns by
 * `ledger.test.ts`.
 *
 * TaskRow is only an interface, so rows coming out of SQLite are cast to it
 * unchecked — nothing stops the two drifting. An agent already added `resets`
 * and `last_reset_at` here that had no matching columns; it typechecked, passed
 * the gate, and left the interface lying about the database.
 *
 * `satisfies` makes that impossible now: add a field to TaskRow and this object
 * fails to compile until you add it here too, at which point the test fails
 * until the column actually exists.
 */
const TASK_ROW_SHAPE = {
  id: 1,
  milestone_id: 1,
  repo: 1,
  title: 1,
  kind: 1,
  instruction: 1,
  acceptance: 1,
  files_hint: 1,
  verify_cmd: 1,
  depends_on: 1,
  est_lines: 1,
  executor_hint: 1,
  breaking: 1,
  status: 1,
  attempts: 1,
  last_error: 1,
  commit_sha: 1,
  brief: 1,
  ord: 1,
  created_at: 1,
  updated_at: 1,
} satisfies Record<keyof TaskRow, 1>;

export const TASK_ROW_COLUMNS = Object.keys(TASK_ROW_SHAPE) as (keyof TaskRow)[];
