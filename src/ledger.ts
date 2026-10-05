import { DatabaseSync } from 'node:sqlite';
import type { OriginatingIdea } from './drivers/contracts.js';
import { createHash } from 'node:crypto';
import { p, reportsDir } from './config.js';
import { join } from 'node:path';
import { ensureDir, nowIso, shortId, today, writeFileSafe } from './util.js';
import { log } from './logger.js';
import type { NormalizedTask, TaskRow, TaskStatus, DailyCommitCount } from './schemas.js';

export const CSV_HEADER = [
  'ID',
  'milestone_id',
  'repo',
  'title',
  'kind',
  'instruction',
  'acceptance',
  'files_hint',
  'verify_cmd',
  'depends_on',
  'est_lines',
  'executor_hint',
  'breaking',
  'status',
  'attempts',
  'last_error',
  'commit_sha',
  'ord',
  'created_at',
  'updated_at',
];

export type TaskRowToCsv = TaskRow;

let db: DatabaseSync | null = null;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY, title TEXT, body TEXT, repo TEXT,
  status TEXT DEFAULT 'new', created_at TEXT
);
CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY, idea_id TEXT, title TEXT, summary TEXT,
  repo TEXT, status TEXT DEFAULT 'open', ord INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, epic_id TEXT, title TEXT, detail TEXT,
  repo TEXT, status TEXT DEFAULT 'unplanned', ord INTEGER, created_at TEXT,
  -- Why planning it produced nothing. A milestone can fail the same way a task
  -- can, and used to do it silently; see setMilestoneStatus.
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  milestone_id TEXT,
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  files_hint TEXT NOT NULL DEFAULT '[]',
  verify_cmd TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  est_lines INTEGER DEFAULT 20,
  executor_hint TEXT DEFAULT 'cli',
  -- What the plan declared this task changes about behaviour that already
  -- works. NULL for a task that declares nothing, and for every task planned
  -- before this column existed - which read the same way to every reader.
  breaking TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  commit_sha TEXT,
  brief TEXT,
  ord INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, day TEXT, started_at TEXT, ended_at TEXT,
  attempted INTEGER DEFAULT 0, committed INTEGER DEFAULT 0, notes TEXT,
  -- What the run cost against a provider's allowance. REAL because copilot bills
  -- fractional premium requests — 0.33 and 1 are both real observed values — and
  -- rounding each dispatch to a whole number would drift the monthly figure the
  -- allowance is actually measured against.
  --
  -- NULL is meaningful: it says no agent reported a figure, which is NOT the same
  -- as a run that cost nothing. Only copilot reports one at all.
  agent_cost REAL,
  -- Dispatches that reported no figure. agy and opencode never do, so without a
  -- count of them agent_cost reads as the whole spend when it is only a floor.
  -- NULL marks a run from before any of this was recorded.
  agent_cost_unknown INTEGER
);

-- Resolution memory (2026-08-07). Both tables are new, so CREATE TABLE IF NOT
-- EXISTS is the whole migration: existing rows are untouched and an old database
-- simply gains two empty tables on next open. There is no migration framework
-- here and this feature did not warrant inventing one.

-- What a task said it would do, captured when it was planned. Compared against
-- what actually happened in the repo since, to spot work that got done by other
-- means while the task sat queued.
CREATE TABLE IF NOT EXISTS task_claims (
  task_id    TEXT PRIMARY KEY,
  plan_head  TEXT,              -- repo HEAD when the task was planned
  planned_at TEXT,
  paths      TEXT NOT NULL DEFAULT '[]',
  symbols    TEXT NOT NULL DEFAULT '[]',
  claim_key  TEXT               -- stable hash of sorted paths+symbols, for dedup
);

-- Append-only. Never updated, never deleted: this is the record of what was
-- resolved and why, including work ShanAuto did not do itself.
CREATE TABLE IF NOT EXISTS resolutions (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  -- When the row was written. NOT when the thing happened: ingesting three years
  -- of history in one pass stamps every memory with the minute ingestion ran,
  -- which collapses all of it into a single day. Bucket by occurred_at instead.
  resolved_at TEXT NOT NULL,
  kind        TEXT NOT NULL,    -- shanauto_commit|external_commit|gate_rejection|qa_rework|manual_park|already_done
  commit_sha  TEXT,
  paths       TEXT NOT NULL DEFAULT '[]',
  symbols     TEXT NOT NULL DEFAULT '[]',
  reason      TEXT,
  task_id     TEXT,
  claim_key   TEXT,
  -- When the event actually occurred: a commit's author date, a decision's
  -- heading date. Defaults to resolved_at when genuinely unknown.
  occurred_at TEXT
);

-- Compression layer. Raw memories are never deleted; a rollup summarises a
-- closed period so a question about last March costs one row rather than 900.
CREATE TABLE IF NOT EXISTS memory_rollups (
  id           TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  period       TEXT NOT NULL,   -- day | week | month
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  stats        TEXT NOT NULL DEFAULT '{}',
  narrative    TEXT,            -- filled later by one model call per closed period
  source_count INTEGER NOT NULL DEFAULT 0,
  built_at     TEXT NOT NULL,
  UNIQUE(repo, period, starts_at)
);

-- One row per agent dispatch, stamped when the dispatch happened.
--
-- Spend used to be accumulated onto runs.agent_cost and attributed to runs.day,
-- which is stamped when the run STARTS. A run crossing local midnight therefore
-- billed a whole night to the day it began, while its commits counted towards
-- the next one -- two meanings of "today" in a single report, which is how a
-- real discrepancy later gets waved away as a rounding artefact.
--
-- A table rather than a column, because the fact is per dispatch and a run has
-- only one day field to hang it on. runs.agent_cost and runs.agent_cost_unknown
-- are superseded and no longer read; SQLite makes dropping a column awkward and
-- neither was ever populated on this machine.
CREATE TABLE IF NOT EXISTS agent_costs (
  id      TEXT PRIMARY KEY,
  run_id  TEXT,
  task_id TEXT,
  -- UTC, like every other timestamp here. Bucketed with date(at,'localtime') so
  -- it lands on the same local day as the commit it paid for.
  at      TEXT NOT NULL,
  -- NULL means no figure was reported, which is not the same as free. Only
  -- copilot reports one; agy and opencode report nothing.
  units   REAL
);

CREATE INDEX IF NOT EXISTS idx_costs_at    ON agent_costs(at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo   ON tasks(repo);
CREATE INDEX IF NOT EXISTS idx_runs_day     ON runs(day);
CREATE INDEX IF NOT EXISTS idx_res_repo     ON resolutions(repo, resolved_at);
CREATE INDEX IF NOT EXISTS idx_res_sha      ON resolutions(commit_sha);
CREATE INDEX IF NOT EXISTS idx_res_key      ON resolutions(claim_key);
`;

/** Override the ledger location. Set by tests so they never touch real data. */
export function dbPath(): string {
  return process.env.SHANAUTO_DB ?? p('data', 'shanauto.db');
}

export function open(): DatabaseSync {
  if (db) return db;
  const file = dbPath();
  if (file !== ':memory:') ensureDir(p('data'));
  /*
   * The handle is only cached once it is fully usable.
   *
   * `db` was assigned before the schema ran, so a failure in SCHEMA or migrate()
   * — a locked file, a disk full, a half-applied migration — left a half-built
   * handle cached. Every later open() returned it happily, and the errors that
   * followed named a missing table rather than the failure that caused it. The
   * next process to open the same file would have migrated it correctly, so
   * this was self-inflicting and self-hiding at the same time.
   */
  const fresh = new DatabaseSync(file);
  fresh.exec('PRAGMA journal_mode = WAL;');
  /*
   * Wait for a busy writer instead of failing instantly.
   *
   * WAL allows one writer at a time and, with no timeout, a concurrent write
   * throws "database is locked" immediately. Measured: four processes writing
   * 300 rows each landed 343 of 1200 — 857 silently lost. The file was never
   * corrupted; the writes just vanished. `remember()` and `recordAgentCost()`
   * swallow errors by design, so a run losing its own memory produced a log
   * line and nothing else. Only `sa run` takes the lock; the TUI, ingest, triage
   * and retry all write with no coordination at all.
   */
  fresh.exec('PRAGMA busy_timeout = 10000;');
  try {
    fresh.exec(SCHEMA);
    migrate(fresh);
  } catch (e) {
    // Leave nothing cached, so the next call retries rather than inheriting a
    // database missing tables nobody can explain.
    try {
      fresh.close();
    } catch {
      /* already unusable */
    }
    throw e;
  }
  db = fresh;
  return db;
}

/**
 * Additive column migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` covers new tables but does nothing for a new
 * column on an existing one, so a database created before a column existed would
 * silently lack it. Each step is idempotent and additive; nothing is ever
 * dropped or rewritten.
 */
function migrate(d: DatabaseSync): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
        (c) => c.name,
      ),
    );

  const steps: [string, string, string][] = [
    // [table, column, DDL]
    ['resolutions', 'occurred_at', 'ALTER TABLE resolutions ADD COLUMN occurred_at TEXT'],
    ['milestones', 'last_error', 'ALTER TABLE milestones ADD COLUMN last_error TEXT'],
    // Deliberately no DEFAULT on either: a run that predates cost tracking gets
    // NULL, which reads as "never measured". A default of 0 would claim those
    // nights were free.
    ['runs', 'agent_cost', 'ALTER TABLE runs ADD COLUMN agent_cost REAL'],
    ['runs', 'agent_cost_unknown', 'ALTER TABLE runs ADD COLUMN agent_cost_unknown INTEGER'],
    // The local day a task was committed. The "today" family and the report
    // queries used to compute date(updated_at,'localtime') over every committed
    // row on every call; this column turns that scan into a lookup. Only set by
    // markCommitted; NULL means "not committed" and is never read.
    ['tasks', 'committed_day', 'ALTER TABLE tasks ADD COLUMN committed_day TEXT'],
    // The senior's brief, added with the senior/intern split. No DEFAULT: a
    // task planned before briefs existed reads as NULL, which is exactly what
    // it was - nobody briefed it - and taskPrompt falls back to the freeform
    // instruction for those rows.
    ['tasks', 'brief', 'ALTER TABLE tasks ADD COLUMN brief TEXT'],
    ['tasks', 'breaking', 'ALTER TABLE tasks ADD COLUMN breaking TEXT'],
    // How many times this milestone has been put back in the planning queue by
    // the run itself. NULL means never, which is what every milestone planned
    // before settleMilestones existed truly was. The bound lives here rather
    // than in config because it is a safety limit, not a preference: it exists
    // so an unattended run cannot re-plan the same milestone forever.
    ['milestones', 'replans', 'ALTER TABLE milestones ADD COLUMN replans INTEGER'],
  ];

  for (const [table, column, ddl] of steps) {
    try {
      if (!columns(table).has(column)) {
        d.exec(ddl);
        log.debug(`migrated: ${table}.${column} added`);
      }
    } catch (e) {
      log.warn(`migration ${table}.${column} failed: ${(e as Error).message}`);
    }
  }

  // Backfill: rows written before occurred_at existed only know when they were
  // recorded, which is the best available answer for them.
  try {
    d.exec('UPDATE resolutions SET occurred_at = resolved_at WHERE occurred_at IS NULL');
  } catch {
    /* pre-migration database, or column absent — nothing to backfill */
  }

  // Backfill committed_day for rows committed before the column existed, and
  // index it. The index is partial to status='committed', which is the only
  // population the "today" queries ever read.
  try {
    d.exec(
      "UPDATE tasks SET committed_day = date(updated_at,'localtime') WHERE committed_day IS NULL AND status='committed'",
    );
    d.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_committed_day ON tasks(committed_day) WHERE status='committed'",
    );
  } catch (e) {
    log.warn(`committed_day backfill failed: ${(e as Error).message}`);
  }
}

/** Drop the cached handle so a test can point at a fresh database. */
export function closeForTest(): void {
  db?.close();
  db = null;
}

/* ---------- ideas / epics / milestones ---------- */

export function addIdea(title: string, body: string, repo: string): string {
  const id = shortId('I');
  open()
    .prepare('INSERT INTO ideas (id,title,body,repo,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, title, body, repo, 'new', nowIso());
  return id;
}

export function setIdeaStatus(id: string, status: string): void {
  open().prepare('UPDATE ideas SET status=? WHERE id=?').run(status, id);
}

export function addEpic(ideaId: string, repo: string, title: string, summary: string, ord: number): string {
  const id = shortId('E');
  open()
    .prepare('INSERT INTO epics (id,idea_id,title,summary,repo,ord,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, ideaId, title, summary, repo, ord, nowIso());
  return id;
}

export function addMilestone(epicId: string, repo: string, title: string, detail: string, ord: number): string {
  const id = shortId('M');
  open()
    .prepare('INSERT INTO milestones (id,epic_id,title,detail,repo,ord,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, epicId, title, detail, repo, ord, nowIso());
  return id;
}

export function nextUnplannedMilestone(): { id: string; title: string; detail: string; repo: string } | null {
  const row = open()
    .prepare(
      `SELECT id,title,detail,repo FROM milestones
       WHERE status='unplanned' ORDER BY ord ASC, created_at ASC LIMIT 1`,
    )
    .get() as { id: string; title: string; detail: string; repo: string } | undefined;
  return row ?? null;
}

/**
 * `error` is the operator-facing reason the milestone ended up in this state —
 * the milestone equivalent of a task's `last_error`, and read by the same eyes.
 * Omitting it clears the previous reason, as setStatus does for tasks.
 */
export function setMilestoneStatus(id: string, status: string, error?: string): void {
  open()
    .prepare('UPDATE milestones SET status=?, last_error=? WHERE id=?')
    .run(status, error ?? null, id);
}

export interface StuckMilestone {
  id: string;
  title: string;
  repo: string;
  last_error: string | null;
  /** Carried so callers can tell an already-built answer from a real failure. */
  status: string | null;
  /**
   * How many times this has already been planned again automatically.
   *
   * Carried so the status screen can say what is TRUE of each milestone rather
   * than reciting the rule. It recited it wrong: "planned again automatically
   * once. These have used that up", printed against a milestone whose `replans`
   * was NULL — it had used none, and the automatic recovery the operator was
   * told to stop waiting for had not started. NULL for every milestone from
   * before the column existed, which reads as zero, which is what it means.
   */
  replans: number | null;
}

/**
 * Milestones the planner gave up on: no task was queued and nothing about the
 * backlog shows the work is outstanding. Without this list they are invisible —
 * which is precisely how one was lost.
 *
 * Defined by what is NOT live rather than by naming the dead statuses, because
 * naming them is what let one through. This asked for `status='rejected'` only,
 * while planNextMilestone also writes 'failed' when the decomposer proposes
 * nothing at all — so a 'failed' milestone matched no query anywhere: not the
 * planner's queue, not this list, not the requeue below. It was lost in exactly
 * the way this list exists to prevent. M9b7oj3cz9u then sat in 'pending', a
 * third value, unreachable for eight days for the same reason.
 *
 * 'unplanned' is queued and 'planned' is done with. Everything else is stuck,
 * including a status no code has written yet.
 */
export const LIVE_MILESTONE_STATUS = "status IS NOT NULL AND status IN ('unplanned','planned')";

/**
 * The brain's answer that a milestone needs no work: everything it asks for is
 * already built. Not live, so the planner never asks again, and not a failure —
 * nothing went wrong, the question was answered.
 *
 * Named rather than spelled inline because three places have to agree on it:
 * the planner that writes it, the screen that reports it, and the requeue below
 * that must skip it. When they disagree the screen tells the operator to leave
 * a milestone alone and the next requeue picks it up anyway.
 */
export const ALREADY_BUILT_STATUS = 'nothing-to-do';

/**
 * The operator's own answer: do not build this, and stop asking. Written only
 * by `sa drop <milestoneId>`, never by the planner - the two frontend
 * milestones planned against a `frontend/` directory that does not exist in a
 * Python backend are the case it was added for. Re-planning those proposes the
 * same unbuildable work against the same missing directory.
 */
export const DROPPED_MILESTONE_STATUS = 'dropped';

/**
 * The work under this milestone finished.
 *
 * There was no such status until 2026-08-26, and that is the whole of finding
 * AP. `setMilestoneStatus` was reachable with exactly three values - 'planned',
 * 'rejected' and 'nothing-to-do' - all three written by the planner, so a
 * milestone recorded whether it had been DECOMPOSED and never whether it had
 * been BUILT. Measured across seven from-zero runs: 18 milestones planned,
 * 20 tasks attempted, 7 committed, and not one milestone ever left 'planned'.
 *
 * Answered, so no requeue picks it up again.
 */
export const MILESTONE_DONE_STATUS = 'done';

/**
 * Every task under this milestone has settled and at least one of them failed
 * with no attempts left.
 *
 * Deliberately NOT in ANSWERED_MILESTONE_STATUSES. 'done' and 'nothing-to-do'
 * are answers; this is a question - the milestone was asked for, the work was
 * attempted, and it is not built. Being unanswered is what puts it on `sa
 * status` and inside `sa retry --failed`.
 *
 * This is the state that did not exist and could not be reached. A milestone
 * whose tasks all failed stayed 'planned', which counts as LIVE, and live is
 * excluded from stuckMilestones, from partitionStuck and from
 * replanStuckMilestones alike - so it was invisible to the planner, to the
 * status screen and to the operator's own retry, all three at once. Run 25
 * ended with three of them and reported "backlog 0, runway ~0 days", which an
 * unattended operator reads as finished rather than as stopped.
 */
export const MILESTONE_BLOCKED_STATUS = 'blocked';

/**
 * How many times a run may put a blocked milestone back in the planning queue
 * on its own.
 *
 * Six, raised from one on 2026-08-28.
 *
 * The old value was justified entirely on cost — "a second is how quota
 * disappears overnight" — and the operator has withdrawn that justification:
 * the system is to finish the work however much it takes. One re-plan was also
 * measurably not enough. It is the point at which a milestone stops and waits
 * for a person, and waiting for a person is the failure this whole mechanism
 * exists to prevent.
 *
 * Still bounded, and not for cost. A milestone that has been decomposed six
 * different ways and failed every time is telling us the idea cannot be built
 * here, and a run that never stops delivers nothing either.
 */
export const MILESTONE_AUTO_REPLANS = 6;

/**
 * Statuses that mean the question has an answer. Not live, so the planner never
 * asks again, and kept out of the blanket requeue so nothing re-asks by accident.
 *
 * A set rather than a second `AND` clause: every place that excludes one has to
 * exclude the other, and the way that breaks is by adding a third status here
 * and updating only the predicate someone remembered.
 */
export const ANSWERED_MILESTONE_STATUSES = [
  ALREADY_BUILT_STATUS,
  DROPPED_MILESTONE_STATUS,
  MILESTONE_DONE_STATUS,
];

export function stuckMilestones(): StuckMilestone[] {
  return open()
    .prepare(
      `SELECT id,title,repo,last_error,status,replans FROM milestones
       WHERE NOT (${LIVE_MILESTONE_STATUS}) ORDER BY ord ASC, created_at ASC`,
    )
    .all() as unknown as StuckMilestone[];
}

/**
 * Split that list into the two things it actually holds: milestones nobody has
 * an answer for, and milestones the brain answered with "already built".
 *
 * One rule, because two screens read this and they must not disagree. `doctor`
 * counts `unplanned` as outstanding work and warns; `status` prints them under
 * different headings and offers different recovery. When each applied its own
 * filter, the way to break it was to fix one and forget the other — and the
 * operator would be told there is nothing to do and warned about it on the
 * same screen.
 */
export function partitionStuck(rows: StuckMilestone[]): {
  unplanned: StuckMilestone[];
  alreadyBuilt: StuckMilestone[];
  dropped: StuckMilestone[];
  blocked: StuckMilestone[];
  done: StuckMilestone[];
} {
  const answered = (m: StuckMilestone) =>
    ANSWERED_MILESTONE_STATUSES.includes(m.status ?? '');
  return {
    /*
     * Only the unanswered side is outstanding work. Everything else is still
     * listed - answered is not the same as hidden - but nothing warns about it.
     *
     * `blocked` is subtracted by name rather than left to fall through. It is
     * unanswered on purpose, so `answered()` alone would file it here, and the
     * heading here reads "planned to nothing - no task was ever queued for
     * them", which is the opposite of what happened to it. Anything with a
     * status nobody has written yet still lands in this bucket, which is the
     * property that must not be lost.
     */
    unplanned: rows.filter((m) => !answered(m) && m.status !== MILESTONE_BLOCKED_STATUS),
    alreadyBuilt: rows.filter((m) => m.status === ALREADY_BUILT_STATUS),
    dropped: rows.filter((m) => m.status === DROPPED_MILESTONE_STATUS),
    blocked: rows.filter((m) => m.status === MILESTONE_BLOCKED_STATUS),
    done: rows.filter((m) => m.status === MILESTONE_DONE_STATUS),
  };
}

export interface HollowMilestone {
  id: string;
  title: string;
  repo: string;
  reasons: string | null;
}

/**
 * Milestones that are `planned` but have nothing left under them: every task
 * was dropped, or none was ever inserted.
 *
 * `planned` is terminal to the planner, so these are invisible in the same way
 * the stranded statuses above were - one status over, and inside the live set,
 * which is why the fix above does not reach them. Mkiw11dh9jx sat here: its
 * only task was dropped for being a placeholder that named `npm test` in a
 * Python repo, so the PLAN was defective and the work is still outstanding,
 * but the milestone read as done.
 *
 * Deliberately not folded into replanStuckMilestones. A dropped task means
 * "gone", not "gone wrong": three of the six found on 2026-08-18 were dropped
 * because the work already existed in the repo, and requeueing those would
 * spend quota re-proposing finished work - the exact outcome that started this
 * investigation. The drop reasons come back with the row so the operator can
 * tell the cases apart and requeue the ones that deserve it by id.
 *
 * Hollowness is defined by the absence of a live task rather than by listing
 * dead task statuses, so a task status no code has written yet still counts as
 * live and cannot silently hollow out a milestone. A NULL status resolves the
 * other way and surfaces the milestone, which is the safe direction for a list
 * whose whole purpose is visibility.
 */
export function hollowMilestones(): HollowMilestone[] {
  return open()
    .prepare(
      `SELECT m.id, m.title, m.repo,
              (SELECT group_concat(t.last_error, ' | ') FROM tasks t
                WHERE t.milestone_id = m.id AND t.last_error IS NOT NULL) AS reasons
         FROM milestones m
        WHERE m.status = 'planned'
          AND NOT EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.milestone_id = m.id AND t.status <> 'dropped')
        ORDER BY m.ord ASC, m.created_at ASC`,
    )
    .all() as unknown as HollowMilestone[];
}

/**
 * Retire a milestone the operator does not want built.
 *
 * The milestone counterpart to dropTask, and the same idea: "gone", not "gone
 * wrong". Until this existed the only dispositions were requeue or leave it
 * sitting on the screen forever, so a milestone that is simply not buildable
 * here kept asking for a decision that had already been made.
 *
 * Refuses while live tasks hang off it. Dropping the milestone would not stop
 * them being built, and the screen would then show a dropped milestone whose
 * work is still going through - so the tasks are named and the operator decides
 * about them first, rather than this quietly retiring work on their behalf.
 */
export function dropMilestone(
  id: string,
  reason = 'not building this',
): 'dropped' | 'not-found' | { live: string[] } {
  const d = open();
  const m = d.prepare('SELECT id,title,repo FROM milestones WHERE id=?').get(id) as
    | { id: string; title: string; repo: string }
    | undefined;
  if (!m) return 'not-found';

  // Live by absence, as hollowMilestones counts it: a task status no code has
  // written yet still blocks the drop, which is the safe direction.
  const live = (
    d
      .prepare("SELECT id FROM tasks WHERE milestone_id=? AND status NOT IN ('dropped','committed')")
      .all(id) as unknown as { id: string }[]
  ).map((t) => t.id);
  if (live.length) return { live };

  d.prepare('UPDATE milestones SET status=?, last_error=? WHERE id=?').run(
    DROPPED_MILESTONE_STATUS,
    reason,
    id,
  );
  // Why a milestone was retired is exactly the sort of thing nobody remembers
  // later - the same reason dropTask records one.
  remember({ repo: m.repo, kind: 'milestone_dropped', reason: `${m.title} — ${reason}` });
  return 'dropped';
}

/**
 * Put one milestone back in the planning queue by id.
 *
 * The targeted counterpart to replanStuckMilestones: a hollow milestone needs a
 * per-milestone decision, and until this existed there was no route to make one
 * - `sa retry --failed` requeues only what stuckMilestones finds, and nothing
 * at all could move a milestone out of `planned`.
 *
 * The guard rejects only a milestone already waiting in the queue, where there
 * is nothing to requeue and `sa retry` should say so. COALESCE is what makes it
 * mean that: `status <> 'unplanned'` is NULL for a milestone with no status at
 * all, and SQL takes NULL as no-match - so the id an operator read off `sa
 * status` reported "nothing to do" for the one milestone most in need of a
 * requeue. Same trap as REQUEUEABLE_MILESTONE above, one screen further on.
 */
export function replanMilestone(id: string): boolean {
  const r = open()
    .prepare(
      "UPDATE milestones SET status='unplanned', last_error=NULL " +
        "WHERE id=? AND COALESCE(status,'') <> 'unplanned'",
    )
    .run(id);
  return Number(r.changes) > 0;
}

/**
 * Stuck milestones worth asking about again: everything not live, minus the
 * ones already answered.
 *
 * The exclusion is not cosmetic. `sa status` tells the operator an answered
 * milestone needs no action; sweeping it up here would make that a lie, and
 * would spend a model call re-asking a question that has an answer on file — the
 * same reason hollow milestones are kept out of the blanket requeue. Disagreeing
 * with the answer is a per-id `sa retry <id>`, which means someone read the
 * reason first.
 *
 * COALESCE, not `status NOT IN (...)`: SQL compares NULL to nothing, so the bare
 * form would silently drop the no-status milestones this list exists to catch.
 */
export const REQUEUEABLE_MILESTONE =
  `NOT (${LIVE_MILESTONE_STATUS}) AND COALESCE(status,'') NOT IN (` +
  ANSWERED_MILESTONE_STATUSES.map((s) => `'${s}'`).join(',') +
  `)`;

/**
 * Put every requeueable milestone back in the planning queue.
 *
 * Operator-triggered, not automatic: re-planning immediately would just ask the
 * brain the same question and collect the same rejections. Same shape as
 * retryAllFailed, and reached by the same `sa retry --failed`.
 *
 * Counts through the same predicate it updates through, so the number reported
 * and the rows moved can never disagree — the split is what stranded 'failed'
 * and 'pending'.
 */
export function replanStuckMilestones(): number {
  const d = open();
  const n = Number(
    (d.prepare(`SELECT COUNT(*) AS n FROM milestones WHERE ${REQUEUEABLE_MILESTONE}`).get() as { n: number }).n,
  );
  if (n > 0) {
    d.prepare(`UPDATE milestones SET status='unplanned', last_error=NULL WHERE ${REQUEUEABLE_MILESTONE}`).run();
  }
  return n;
}

export interface SettledMilestones {
  /** Ids that finished: every task settled, at least one committed, none failed. */
  done: string[];
  /** Ids that stopped: every task settled, at least one failed. */
  blocked: string[];
}

/**
 * Give every milestone whose work has finished a state that says so.
 *
 * The missing half of the lifecycle. `unplanned` means the planner has not
 * looked at it and `planned` means the planner has - and until this ran,
 * nothing after the planner ever wrote to a milestone again. A milestone whose
 * three tasks all committed and a milestone whose three tasks all failed were
 * the same row.
 *
 * Settled is defined by the ABSENCE of a live task, the same way hollowness is
 * and for the same reason: a task status nobody has written yet counts as live
 * and holds its milestone open, which is the safe direction. 'handoff' is
 * deliberately NOT settled - a task waiting on the operator is work still
 * outstanding, and handoffTasks() already asks about it.
 *
 * 'blocked' is settled, and counts as a failure. It is written in exactly one
 * place - markDeadlocked - and means "parked behind a dependency that failed",
 * which nothing but `sa retry --failed` can undo. Left as live it reproduced
 * the whole finding one status over: run 29 built example-ledger's parser, left two
 * tasks deadlocked behind the one that failed, and the milestone holding the
 * operator's own complaint about date formats sat at `planned` with nothing
 * able to see it - not the planner, not the status screen, not the requeue.
 *
 * A milestone whose every task was DROPPED is left alone on purpose. That is
 * hollowMilestones' case, it has been since 2026-08-18, and it prints the drop
 * reasons - which matter, because "dropped because the work already existed"
 * and "dropped because the plan was defective" want opposite decisions and
 * neither is a failure.
 *
 * Idempotent: it reads only `planned` rows and moves them out of `planned`.
 */
export function settleMilestones(): SettledMilestones {
  const d = open();
  const rows = d
    .prepare(
      `SELECT m.id AS id,
              SUM(CASE WHEN t.status NOT IN ('committed','failed','dropped','blocked') THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN t.status IN ('failed','blocked') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN t.status = 'committed' THEN 1 ELSE 0 END) AS shipped,
              group_concat(CASE WHEN t.status IN ('failed','blocked') THEN t.title || ': ' ||
                           COALESCE(t.last_error,'no reason recorded') END, '\n') AS why
         FROM milestones m
         JOIN tasks t ON t.milestone_id = m.id
        WHERE m.status = 'planned'
        GROUP BY m.id
       HAVING live = 0`,
    )
    .all() as unknown as { id: string; failed: number; shipped: number; why: string | null }[];

  const out: SettledMilestones = { done: [], blocked: [] };
  for (const r of rows) {
    if (r.failed > 0) {
      // The reasons travel with the milestone because the status screen shows
      // the milestone, not its tasks, and "blocked" with no reason attached is
      // the same dead end this whole finding is about.
      setMilestoneStatus(r.id, MILESTONE_BLOCKED_STATUS, r.why ?? undefined);
      out.blocked.push(r.id);
    } else if (r.shipped > 0) {
      setMilestoneStatus(r.id, MILESTONE_DONE_STATUS);
      out.done.push(r.id);
    }
    // else: every task dropped. hollowMilestones() owns that case.
  }
  return out;
}

/**
 * Put blocked milestones back in the planning queue, at most
 * MILESTONE_AUTO_REPLANS times each.
 *
 * The only automatic requeue in the system, and it is narrower than the
 * operator's. `replanStuckMilestones` is documented as operator-triggered
 * because re-asking the brain a question it just rejected collects the same
 * rejection - true of a milestone the planner refused to decompose, and not
 * true of this one. Here the plan WAS accepted, tasks were written, and they
 * were attempted and failed; the decomposition is the most likely thing to be
 * wrong, and it is the thing a re-plan changes.
 *
 * The failed tasks are superseded rather than left in place. A re-planned
 * milestone gets fresh tasks, and the old failures would otherwise settle it
 * straight back to blocked the moment the new ones finish - a milestone that
 * can never reach `done` again, which is the bug one layer up. `dropTask`
 * keeps the row and the reason, so nothing is lost from the record.
 */
export function autoReplanBlocked(limit = MILESTONE_AUTO_REPLANS): string[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT id FROM milestones
        WHERE status = ? AND COALESCE(replans,0) < ?
        ORDER BY ord ASC, created_at ASC`,
    )
    .all(MILESTONE_BLOCKED_STATUS, limit) as unknown as { id: string }[];

  for (const m of rows) {
    const failed = d
      .prepare("SELECT id FROM tasks WHERE milestone_id=? AND status IN ('failed','blocked')")
      .all(m.id) as unknown as { id: string }[];
    for (const t of failed) dropTask(t.id, 'superseded — its milestone is being planned again');

    d.prepare(
      "UPDATE milestones SET status='unplanned', last_error=NULL, replans=COALESCE(replans,0)+1 WHERE id=?",
    ).run(m.id);
  }
  return rows.map((m) => m.id);
}

/* ---------- tasks ---------- */

export function insertTasks(milestoneId: string | null, repo: string, planned: NormalizedTask[]): string[] {
  const d = open();
  const stmt = d.prepare(
    `INSERT INTO tasks
     (id,milestone_id,repo,title,kind,instruction,acceptance,files_hint,verify_cmd,
      depends_on,est_lines,executor_hint,breaking,status,ord,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ids: string[] = [];
  const base = (d.prepare('SELECT COALESCE(MAX(ord),0) AS m FROM tasks').get() as { m: number }).m;

  d.exec('BEGIN');
  try {
    // depends_on arrives as indexes into `planned`; convert to real task ids.
    planned.forEach((_, i) => ids.push(shortId('T')));
    planned.forEach((t, i) => {
      const deps = t.depends_on.filter((n) => n < i).map((n) => ids[n]!);
      stmt.run(
        ids[i]!,
        milestoneId,
        repo,
        t.title,
        t.kind,
        t.instruction,
        t.acceptance,
        JSON.stringify(t.files_hint),
        t.verify_cmd,
        JSON.stringify(deps),
        t.est_lines,
        t.executor_hint,
        t.breaking ?? null,
        deps.length === 0 ? 'ready' : 'pending',
        base + i + 1,
        nowIso(),
        nowIso(),
      );
    });
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return ids;
}

/**
 * Every task for a repo that is still live — not committed, not dropped.
 *
 * Used to keep the repair task idempotent by title: a broken project must not
 * accumulate one fresh repair job per run, which would turn a single failure
 * into an unbounded queue.
 */
export function openTasksByRepo(repo: string): TaskRow[] {
  return open()
    .prepare(
      `SELECT * FROM tasks WHERE repo=? AND status NOT IN ('committed','dropped')
       ORDER BY ord ASC`,
    )
    .all(repo) as unknown as TaskRow[];
}

export function readyTasks(repo?: string): TaskRow[] {
  const sql = repo
    ? `SELECT * FROM tasks WHERE status='ready' AND repo=? ORDER BY ord ASC`
    : `SELECT * FROM tasks WHERE status='ready' ORDER BY ord ASC`;
  const stmt = open().prepare(sql);
  return (repo ? stmt.all(repo) : stmt.all()) as unknown as TaskRow[];
}

export function countByStatus(): Record<string, number> {
  const rows = open()
    .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    .all() as unknown as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function getTask(id: string): TaskRow | null {
  return (open().prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as TaskRow) ?? null;
}

export function setStatus(id: string, status: TaskStatus, error?: string): void {
  open()
    .prepare('UPDATE tasks SET status=?, last_error=?, updated_at=? WHERE id=?')
    .run(status, error ?? null, nowIso(), id);
}

/**
 * Store the senior's brief for a task.
 *
 * Kept on the row rather than only in the journal because it is read back on a
 * retry — the second attempt at a task implements the same plan, not a freshly
 * imagined one — and because when a commit turns out wrong, what the intern was
 * told is the first thing worth reading.
 */
export function setTaskBrief(id: string, brief: string): void {
  open().prepare('UPDATE tasks SET brief=?, updated_at=? WHERE id=?').run(brief, nowIso(), id);
}

/**
 * The idea a task came from, in the words the operator actually wrote.
 *
 * Everything between an idea and a task is a model paraphrasing a paraphrase:
 * shape writes the epic from the idea, decompose writes the milestone from the
 * epic and the task from the milestone, and the senior writes the brief from
 * the task. Each hop is faithful to the one above it and each hop is narrower,
 * so what reaches the junior is a specific checkable instruction that no longer
 * contains the general thing that was wanted.
 *
 * Measured on 2026-08-23. The idea said "I want it to stop deciding by
 * popularity at all". The brief said "remove any math that multiplies or
 * weights the feedback score by search volume". The junior audited the three
 * functions it was pointed at, correctly found no multiplier in any of them,
 * and reported ALREADY_DONE - past a hard `retrieval_count >= 5` filter, in one
 * of those same functions, which it saw and set aside as "filtering logic, not
 * scoring math". True of the brief. Not true of the complaint.
 *
 * So the complaint travels with the task now. Returns null for a task with no
 * milestone, an orphaned milestone, or a repo whose work did not begin with an
 * idea - all ordinary, and all meaning there is no operator sentence to show.
 */
export function ideaForTask(id: string): OriginatingIdea | null {
  const row = open()
    .prepare(
      `SELECT i.title AS title, i.body AS body
         FROM tasks t
         JOIN milestones m ON m.id = t.milestone_id
         JOIN epics e ON e.id = m.epic_id
         JOIN ideas i ON i.id = e.idea_id
        WHERE t.id = ?`,
    )
    .get(id) as { title: string; body: string } | undefined;
  if (!row?.body?.trim()) return null;
  return { title: row.title ?? '', body: row.body };
}

/**
 * The request a MILESTONE came from, as opposed to a task.
 *
 * `ideaForTask` walks the same joins one level lower. Both exist because both
 * readers exist: the agent is measured against the request per task, and the
 * acceptance check (O25) is measured against it per milestone, at the moment
 * the milestone would otherwise close over it.
 */
export function ideaForMilestone(id: string): OriginatingIdea | null {
  const row = open()
    .prepare(
      `SELECT i.title AS title, i.body AS body
         FROM milestones m
         JOIN epics e ON e.id = m.epic_id
         JOIN ideas i ON i.id = e.idea_id
        WHERE m.id = ?`,
    )
    .get(id) as { title: string; body: string } | undefined;
  if (!row?.body?.trim()) return null;
  return { title: row.title ?? '', body: row.body };
}

/**
 * Fold what is still missing into the milestone's own description.
 *
 * The shortfall cannot live in `last_error`: a milestone marked `blocked` is
 * re-planned by `autoReplanBlocked`, which clears `last_error` on its way past,
 * so the one piece of information the next decomposition needs would be gone
 * before the planner ever read it. `detail` is what the planner decomposes
 * from, and it survives.
 *
 * Appended rather than replaced. The original detail is still what the
 * milestone is FOR, and a decomposition that saw only the shortfall would plan
 * the missing part with no idea what it belongs to.
 */
export function noteShortfall(id: string, missing: string[]): void {
  const items = missing.map((m) => m.trim()).filter(Boolean);
  if (!items.length) return;
  const m = getMilestone(id);
  if (!m) return;
  const bullets = items.map((i) => `- ${i}`).join('\n');
  const note =
    `\n\nSTILL MISSING after the first attempt at this — the jobs finished ` +
    `and the request did not:\n${bullets}`;
  // Written once. A milestone re-planned six times must not accumulate six
  // copies of the same paragraph and crowd out its own description.
  if ((m.detail ?? '').includes(note.trim())) return;
  open()
    .prepare('UPDATE milestones SET detail=? WHERE id=?')
    .run(`${m.detail ?? ''}${note}`, id);
}

/** One milestone, by id. */
export function getMilestone(
  id: string,
): { id: string; title: string; detail: string | null; repo: string; status: string } | null {
  return (
    (open()
      .prepare('SELECT id,title,detail,repo,status FROM milestones WHERE id=?')
      .get(id) as { id: string; title: string; detail: string | null; repo: string; status: string }) ??
    null
  );
}

/**
 * What actually landed under a milestone.
 *
 * Committed only. A dropped task shipped nothing and a failed one shipped
 * nothing; including either would let "we decided this was unnecessary" read as
 * evidence that the request was answered, which is the exact substitution O25
 * is about.
 */
export function committedForMilestone(id: string): TaskRow[] {
  return open()
    .prepare("SELECT * FROM tasks WHERE milestone_id=? AND status='committed' ORDER BY ord ASC")
    .all(id) as unknown as TaskRow[];
}

export function bumpAttempt(id: string): number {
  const d = open();
  d.prepare('UPDATE tasks SET attempts=attempts+1, updated_at=? WHERE id=?').run(nowIso(), id);
  return (d.prepare('SELECT attempts AS a FROM tasks WHERE id=?').get(id) as { a: number }).a;
}

/**
 * Give back an attempt the task never got to use.
 *
 * The counter is bumped before dispatch, which is right for anything the agent
 * did or failed to do. It is wrong for a provider that refused to run at all:
 * an exhausted quota reports `premiumRequests: 0` — nothing was spent, the task
 * was never looked at — yet it would still come back tomorrow with one of its
 * two attempts already gone, and be one ordinary failure away from permanent
 * `failed`. Two dead-quota nights would exhaust the budget having never once
 * shown the task to a model.
 *
 * Floored at zero so a double refund cannot mint attempts.
 */
export function refundAttempt(id: string): void {
  open()
    .prepare('UPDATE tasks SET attempts=MAX(attempts-1,0), updated_at=? WHERE id=?')
    .run(nowIso(), id);
}

export function markCommitted(id: string, sha: string): void {
  open()
    .prepare(
      "UPDATE tasks SET status='committed', commit_sha=?, updated_at=?, committed_day=date('now','localtime') WHERE id=?",
    )
    .run(sha, nowIso(), id);
  // Only tasks that depend on THIS one can have just become ready.
  unblockDependents(id);
}

/**
 * Promote any pending task whose dependencies are all satisfied to ready.
 *
 * `committedId`, when supplied, restricts the pass to pending tasks that
 * DIRECTLY depend on it. That is exactly the set a commit can newly free: a
 * task stays pending only while some dependency is unfinished, and the one
 * dependency whose state just changed is the committed task — so a task with a
 * different unmet dependency cannot become ready now. markCommitted passes its
 * own id; the one-time startup rescan (index.ts) passes none and still walks
 * everything.
 */
export function unblockDependents(committedId?: string): number {
  const d = open();
  // Load all pending tasks; filter by committedId in JS to avoid json_each on malformed JSON
  const pending = d
    .prepare("SELECT id, depends_on FROM tasks WHERE status='pending'")
    .all() as unknown as { id: string; depends_on: string }[];

  let freed = 0;
  for (const t of pending) {
    // Parse once; malformed JSON is treated as "no dependencies" so the task is
    // freed rather than left pending forever. That is the point of this branch:
    // before, JSON.parse crashed the whole sweep on a single bad row.
    let deps: string[] = [];
    let parsed = true;
    try {
      deps = JSON.parse(t.depends_on) as string[];
    } catch (e) {
      log.warn(`unblockDependents: malformed depends_on JSON for task ${t.id}: ${(e as Error).message}`);
      parsed = false;
    }
    // If committedId is provided, only process tasks that depend on it. A row we
    // failed to parse can't be checked, so we skip it too — its depends_on is
    // garbage and no commit of ours could be referenced by name inside it.
    if (committedId && parsed && !deps.includes(committedId)) continue;
    if (deps.length === 0) {
      d.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(t.id);
      freed++;
      continue;
    }
    const placeholders = deps.map(() => '?').join(',');
    // 'dropped' counts as satisfied: the agent found that work already in place,
    // so whatever was waiting on it can go ahead. Requiring 'committed' here left
    // whole chains parked behind a prerequisite that was, in fact, met.
    const done = (
      d
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE id IN (${placeholders}) AND status IN ('committed','dropped')`,
        )
        .get(...deps) as { n: number }
    ).n;
    if (done === deps.length) {
      d.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(t.id);
      freed++;
    }
  }
  return freed;
}

export function completedTitles(repo: string, limit = 40): string[] {
  const rows = open()
    .prepare("SELECT title FROM tasks WHERE repo=? AND status='committed' ORDER BY ord DESC LIMIT ?")
    .all(repo, limit) as unknown as { title: string }[];
  return rows.map((r) => r.title);
}

/**
 * Every title that is done or already queued. The planner must see queued work
 * too, otherwise it re-proposes something sitting in the backlog it never got
 * told about.
 */
/**
 * Work that is queued but not yet done, in the order it will be attempted.
 *
 * `status` reported only a count, which answers how many and never which — and
 * "what is it about to do to my project?" is the first question anyone asks.
 */
export function waitingTasks(limit = 12): TaskRow[] {
  return open()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('ready','pending','running')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'ready' THEN 1 ELSE 2 END, ord ASC
       LIMIT ?`,
    )
    .all(limit) as unknown as TaskRow[];
}

/**
 * How today's work actually went, rebuilt from the ledger.
 *
 * `sa report` used to hardcode attempted/failed/dropped to 0 and read only the
 * commit count, so a re-emitted report claimed "attempted 0, committed 10" —
 * arithmetically impossible on its face — and "failed: 0" directly above a list
 * of the day's failures. The figures were in the database the whole time.
 */
export function todaysOutcomes(): { attempted: number; failed: number; dropped: number; handoff: number } {
  const row = open()
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('committed','failed','dropped','handoff') THEN 1 ELSE 0 END) AS attempted,
         SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='dropped' THEN 1 ELSE 0 END) AS dropped,
         SUM(CASE WHEN status='handoff' THEN 1 ELSE 0 END) AS handoff
       FROM tasks
       WHERE date(updated_at,'localtime') = date('now','localtime')`,
    )
    .get() as Record<string, number | null>;
  return {
    attempted: row?.attempted ?? 0,
    failed: row?.failed ?? 0,
    dropped: row?.dropped ?? 0,
    handoff: row?.handoff ?? 0,
  };
}

export function knownTitles(repo: string, limit = 400): string[] {
  const rows = open()
    .prepare(
      // 'dropped' means an agent found the work already implemented, so it is
      // very much a known title. 'failed' is excluded — those may deserve a retry.
      `SELECT title FROM tasks
       WHERE repo=? AND status IN ('committed','ready','pending','running','handoff','dropped')
       ORDER BY ord DESC LIMIT ?`,
    )
    .all(repo, limit) as unknown as { title: string }[];
  return rows.map((r) => r.title);
}

/**
 * Known work, with the files each task touches.
 *
 * Titles alone cannot separate "relocate the logging module" from "relocate the
 * health module" — they share four words of six. The files can.
 */
export function knownWork(repo: string, limit = 400): { title: string; paths: string[] }[] {
  const rows = open()
    .prepare(
      `SELECT title, files_hint FROM tasks
       WHERE repo=? AND status IN ('committed','ready','pending','running','handoff','dropped')
       ORDER BY ord DESC LIMIT ?`,
    )
    .all(repo, limit) as unknown as { title: string; files_hint: string }[];

  return rows.map((r) => {
    let paths: string[] = [];
    try {
      paths = JSON.parse(r.files_hint ?? '[]') as string[];
    } catch {
      paths = []; // a malformed hint just means "files unknown"
    }
    return { title: r.title, paths };
  });
}

/* ---------- runs ---------- */

export function startRun(): string {
  const id = shortId('R');
  open()
    // agent_cost_unknown starts at 0, not NULL: a run that tracks its spend and
    // has not dispatched anything yet must be distinguishable from a run that
    // predates tracking entirely.
    .prepare('INSERT INTO runs (id,day,started_at,agent_cost_unknown) VALUES (?,?,?,0)')
    .run(id, today(), nowIso());
  return id;
}

/**
 * What a stretch of agent work cost against a provider's allowance.
 *
 * `units` is nullable on purpose. Only copilot reports a figure; agy and
 * opencode report nothing at all, and calling an unmeasured dispatch 0 would
 * make a whole night of them look free — which is the opposite of the point.
 */
export interface AgentSpend {
  /** Sum of the figures agents actually reported. null when none did. */
  units: number | null;
  /** Dispatches that reported no figure, so their real cost is unknown. */
  unmeasured: number;
}

/**
 * Bill one agent dispatch to a run. Never throws.
 *
 * By the time this is called the provider request has already been spent and
 * the work may be sitting in the worktree waiting for the gate, so a locked
 * database must cost a log line rather than the commit that was about to land.
 * Same fail-open rule as remember().
 *
 * @param units what the agent reported it cost. Omitted or unusable means
 *   unknown, which is counted separately and never folded in as zero.
 */
export function recordAgentCost(runId: string, units?: number, taskId?: string): void {
  try {
    // One row per dispatch, stamped now. An unreported figure is stored as NULL,
    // never as 0: "nobody said" and "it was free" are different facts, and
    // conflating them understates the one constraint this system is bound by.
    const measured = typeof units === 'number' && Number.isFinite(units) && units >= 0;
    open()
      .prepare('INSERT INTO agent_costs (id, run_id, task_id, at, units) VALUES (?,?,?,?,?)')
      .run(shortId('C'), runId || null, taskId ?? null, nowIso(), measured ? (units as number) : null);
  } catch (e) {
    log.warn(`could not record agent cost: ${(e as Error).message}`);
  }
}

/**
 * Agent spend for a local day.
 *
 * Bucketed by each dispatch's own timestamp converted to local — the same
 * framing `committedToday()` uses. This used to sum `runs.agent_cost` by
 * `runs.day`, which is stamped when a run STARTS, so a run crossing midnight
 * billed the whole night to the day it began while its commits counted towards
 * the next one. Two meanings of "today" in a single report is how a real
 * discrepancy later gets waved away as a rounding artefact.
 */
export function agentSpendForDay(day = today()): AgentSpend {
  const row = open()
    .prepare(
      `SELECT SUM(units) AS units,
              SUM(CASE WHEN units IS NULL THEN 1 ELSE 0 END) AS unmeasured
         FROM agent_costs
        WHERE date(at,'localtime') = date(?)`,
    )
    .get(day) as { units: number | null; unmeasured: number | null } | undefined;
  // SUM over no rows, or over nothing but NULLs, is NULL — which is exactly the
  // honest answer here: nobody reported anything.
  return { units: row?.units ?? null, unmeasured: row?.unmeasured ?? 0 };
}

export function endRun(id: string, attempted: number, committed: number, notes = ''): void {
  open()
    .prepare('UPDATE runs SET ended_at=?, attempted=?, committed=?, notes=? WHERE id=?')
    .run(nowIso(), attempted, committed, notes, id);
}

/**
 * Commits that landed today, local time.
 *
 * Both sides must be converted to the same frame. `updated_at` is stored as UTC
 * ("2026-08-07T20:00:32.798Z"), and this compared its UTC date against the LOCAL
 * date — so in any timezone ahead of UTC, every commit between local midnight
 * and the UTC rollover was invisible. Nine commits landed and this returned 0.
 *
 * That is not cosmetic: this function enforces `max_daily_commits`, the hard
 * ceiling. Under-counting means the ceiling can be sailed straight through.
 * Same root cause as the `today()` UTC bug fixed earlier; these two queries
 * were missed.
 */
export function committedToday(): number {
  return (
    open()
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status='committed' AND committed_day=date('now','localtime')",
      )
      .get() as { n: number }
  ).n;
}

/**
 * Today's commits split by repo, in the same local-time frame as committedToday.
 *
 * Feeds the per-repo share in core/allocator.ts. It has to come from the ledger
 * rather than from counting the batch, because `runBatch` re-selects every time
 * the queue drains: a per-batch tally resets on each refill, and on 2026-08-08
 * that is how example-api took all 16 of the day's commits while shanauto — a
 * weighted sibling with work ready — took none.
 *
 * Repos with nothing committed today are absent, not zero. Callers default.
 */
export function committedTodayByRepo(): Record<string, number> {
  const rows = open()
    .prepare(
      "SELECT repo, COUNT(*) AS n FROM tasks WHERE status='committed' AND committed_day=date('now','localtime') GROUP BY repo",
    )
    .all() as unknown as { repo: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.repo, r.n]));
}

export function todaysCommits(): TaskRow[] {
  return open()
    .prepare(
      // Same local-day frame as committedToday; this feeds the report, which
      // showed an empty day after a night of work.
      "SELECT * FROM tasks WHERE status='committed' AND committed_day=date('now','localtime') ORDER BY updated_at ASC",
    )
    .all() as unknown as TaskRow[];
}

/**
 * Tasks that can never run, because something upstream failed.
 *
 * `unblockDependents` only frees a task once EVERY dependency is committed, so a
 * single failure freezes its whole downstream chain — permanently and silently.
 * On 2026-08-06, 8 failures deadlocked 38 of 59 pending tasks while `runwayDays`
 * still counted all 59 as future work and reported 3 days of runway for 1 day of
 * reachable work.
 */
export function deadlockedTaskIds(): Set<string> {
  /*
   * Load ALL tasks that could appear in a dependency chain.
   * A dependency is satisfied if its task is: committed, dropped, running, or handoff.
   * A dependency is a deadlock cause if its task is: failed, or missing entirely.
   * We load all these statuses so the dependency graph is complete.
   */
  const rows = open()
    .prepare("SELECT id, status, depends_on FROM tasks WHERE status IN ('pending','ready','failed','blocked','committed','dropped','running','handoff')")
    .all() as unknown as { id: string; status: string; depends_on: string }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, boolean>();

  function isDead(id: string, seen: Set<string>): boolean {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return false; // cycle: treat as alive, the cap will catch it
    seen.add(id);

    const t = byId.get(id);
    if (!t) return true;
    // 'dropped' means an agent found the work already present. The prerequisite
    // IS met, just not by a commit of ours, so dependents are free to proceed.
    // Only a genuine failure deadlocks a chain.
    if (t.status === 'failed') {
      memo.set(id, true);
      return true;
    }
    // committed, dropped, running, handoff are all satisfied/alive
    if (t.status === 'committed' || t.status === 'dropped' || t.status === 'running' || t.status === 'handoff') {
      memo.set(id, false);
      return false;
    }
    // t.status is 'pending', 'ready', or 'blocked' - check dependencies
    const deps = JSON.parse(t.depends_on) as string[];
    const dead = deps.some((d) => {
      const dep = byId.get(d);
      // Absent from the live set = genuinely missing (deleted/never created).
      // Missing deps are a hard deadlock cause — we cannot assume they'll ever satisfy.
      if (!dep) return true;
      if (dep.status === 'failed') return true;
      // If dep is satisfied (committed/dropped/running/handoff), it's not a deadlock cause
      if (dep.status === 'committed' || dep.status === 'dropped' || dep.status === 'running' || dep.status === 'handoff') {
        return false;
      }
      // dep is pending/ready/blocked - recurse
      return isDead(d, seen);
    });
    memo.set(id, dead);
    return dead;
  }

  const out = new Set<string>();
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    if (isDead(r.id, new Set())) out.add(r.id);
  }
  return out;
}

/** Move deadlocked tasks to 'blocked' so they stop inflating the runway. */
export function markDeadlocked(): number {
  const ids = deadlockedTaskIds();
  if (ids.size === 0) return 0;
  const d = open();
  const stmt = d.prepare(
    "UPDATE tasks SET status='blocked', last_error=?, updated_at=? WHERE id=? AND status='pending'",
  );
  const liveRows = d
    .prepare("SELECT id, depends_on FROM tasks WHERE status IN ('pending','ready','failed','blocked')")
    .all() as unknown as { id: string; depends_on: string }[];
  const liveIds = new Set(liveRows.map((r) => r.id));
  for (const id of ids) {
    const row = liveRows.find((r) => r.id === id);
    let message = 'deadlocked: an upstream task failed. `sa retry --failed` to revive the chain.';
    if (row) {
      const deps = JSON.parse(row.depends_on) as string[];
      const missing = deps.filter((d) => !liveIds.has(d));
      if (missing.length > 0) {
        message = `deadlocked: missing upstream dependency ${missing.join(', ')}. The task this depends on may have been deleted or never created.`;
      }
    }
    stmt.run(message, nowIso(), id);
  }
  return ids.size;
}

/** Tasks that could still realistically run. Excludes deadlocked chains. */
export function reachableBacklog(): number {
  const counts = countByStatus();
  const usable = (counts.ready ?? 0) + (counts.pending ?? 0);
  return Math.max(0, usable - deadlockedTaskIds().size);
}

/**
 * F12: revive blocked tasks that sit in the dependency closure BEHIND `rootId`,
 * and only those.
 *
 * `blocked` is an overloaded status — it covers deadlock-parked tasks AND
 * manually-parked ones (superseded, git-prep failures). The old blanket
 * `UPDATE ... WHERE status='blocked'` flung every parked chain back into the
 * queue whenever ANY task was retried, including chains that had nothing to do
 * with it. Walk the depends_on graph instead: a task is only revived if `rootId`
 * is in its transitive dependency set, and only if it is currently blocked.
 * `unblockDependents()` (called by the retry/drop callers) promotes the rest.
 */
function reviveBlockedBehind(d: DatabaseSync, rootId: string): number {
  // Reverse adjacency over the tasks that are still in flight. Committed and
  // dropped rows are satisfied — nothing waits on them — so they cannot be the
  // reason a descendant is parked, and they are not walked.
  const rows = d
    .prepare("SELECT id, depends_on FROM tasks WHERE status IN ('blocked','pending','ready')")
    .all() as unknown as { id: string; depends_on: string }[];
  const children = new Map<string, string[]>();
  for (const r of rows) {
    let deps: string[] = [];
    try {
      deps = JSON.parse(r.depends_on) as string[];
    } catch {
      deps = [];
    }
    for (const dep of deps) {
      const list = children.get(dep);
      if (list) list.push(r.id);
      else children.set(dep, [r.id]);
    }
  }

  const revive = d.prepare(
    "UPDATE tasks SET status='pending', last_error=NULL, updated_at=? WHERE id=? AND status='blocked'",
  );
  let revived = 0;
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of children.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const hit = revive.run(nowIso(), child);
      revived += Number(hit.changes ?? 0);
      queue.push(child);
    }
  }
  return revived;
}

/**
 * Put a failed or blocked task back in the queue, and revive anything that was
 * deadlocked behind it. Needed often enough in practice that doing it by hand
 * with SQL — as happened three times on 2026-08-06 — is not acceptable.
 */
export function retryTask(id: string): boolean {
  const d = open();
  const t = getTask(id);
  if (!t || (t.status !== 'failed' && t.status !== 'blocked')) return false;

  const deps = JSON.parse(t.depends_on) as string[];
  const satisfied = (s?: string) => s === 'committed' || s === 'dropped';
  const ready = deps.length === 0 || deps.every((x) => satisfied(getTask(x)?.status));
  d.prepare('UPDATE tasks SET status=?, attempts=0, last_error=NULL, updated_at=? WHERE id=?').run(
    ready ? 'ready' : 'pending',
    nowIso(),
    id,
  );
  // F12: only the chain behind THIS task gets revived, not every parked task.
  reviveBlockedBehind(d, id);
  unblockDependents();
  return true;
}

/**
 * Retire a task as already-satisfied.
 *
 * The right resolution for a failure like "Add test script to package.json" when
 * the script is already there: it is not a defect to retry, the work exists. Marks
 * it `dropped`, which unblocks whatever was waiting on it.
 */
export function dropTask(id: string, reason = 'already satisfied'): boolean {
  const t = getTask(id);
  if (!t || t.status === 'committed') return false;
  const d = open();
  d.prepare("UPDATE tasks SET status='dropped', last_error=?, updated_at=? WHERE id=?")
    .run(reason, nowIso(), id);
  // Why a task was retired is exactly the sort of thing nobody remembers later.
  remember({ repo: t.repo, kind: 'task_dropped', task_id: id, reason: `${t.title} — ${reason}` });
  // F12: same closure revive as retryTask — a dropped prerequisite frees the
  // chain parked behind it, and only that chain.
  reviveBlockedBehind(d, id);
  unblockDependents();
  return true;
}

/** Revive every failed task, and everything deadlocked behind them. */
export function retryAllFailed(): number {
  const failed = open()
    .prepare("SELECT id FROM tasks WHERE status='failed'")
    .all() as unknown as { id: string }[];
  let n = 0;
  for (const f of failed) if (retryTask(f.id)) n++;
  return n;
}

/* ---------- resolution memory ---------- */

/**
 * Stable identity for "this piece of work", independent of how it was worded.
 *
 * Sorted so that the same paths and symbols in a different order hash the same;
 * the planner's ordering is arbitrary and must not produce two distinct keys for
 * one piece of work.
 */
export function claimKey(paths: string[], symbols: string[]): string {
  const norm = (xs: string[]) =>
    [...new Set(xs.map((s) => s.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean))].sort();
  const material = JSON.stringify({ p: norm(paths), s: norm(symbols) });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export interface TaskClaim {
  task_id: string;
  plan_head: string | null;
  planned_at: string;
  paths: string[];
  symbols: string[];
  claim_key: string;
}

export function saveClaim(
  taskId: string,
  planHead: string | null,
  paths: string[],
  symbols: string[],
): void {
  open()
    .prepare(
      `INSERT INTO task_claims (task_id, plan_head, planned_at, paths, symbols, claim_key)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET
         plan_head=excluded.plan_head, planned_at=excluded.planned_at,
         paths=excluded.paths, symbols=excluded.symbols, claim_key=excluded.claim_key`,
    )
    .run(taskId, planHead, nowIso(), JSON.stringify(paths), JSON.stringify(symbols), claimKey(paths, symbols));
}

/** Returns null for an unknown or unparseable claim — callers must fail open. */
export function getClaim(taskId: string): TaskClaim | null {
  const row = open().prepare('SELECT * FROM task_claims WHERE task_id=?').get(taskId) as
    | { task_id: string; plan_head: string | null; planned_at: string; paths: string; symbols: string; claim_key: string }
    | undefined;
  if (!row) return null;
  try {
    return {
      ...row,
      paths: JSON.parse(row.paths) as string[],
      symbols: JSON.parse(row.symbols) as string[],
    };
  } catch {
    // Malformed JSON must not throw mid-dispatch; no claim means always-FRESH.
    return null;
  }
}

/**
 * What kind of thing is being remembered.
 *
 * The first five are code movement and scheduling. The rest exist because the
 * questions worth asking a year from now — "why does agy have shell access",
 * "what went wrong that night" — are about decisions and outcomes, and none of
 * those appear in a commit.
 */
export type ResolutionKind =
  | 'shanauto_commit'
  | 'external_commit'
  | 'manual_park'
  | 'already_done'
  | 'gate_rejection'
  /**
   * The senior reviewed work the gate had passed and refused to ship it.
   *
   * Distinct from `gate_rejection`, which means the project's own check said
   * no. This one means the check said yes and a reader disagreed - usually
   * because the tests that passed could not have failed. A planner reading
   * these back needs to be able to tell those apart.
   */
  | 'qa_rework'
  /**
   * The work shipped on a verdict from a model that was not the configured
   * senior, because the senior could not answer.
   *
   * Recorded because this is the only fallback whose consequence leaves the
   * machine: a commit and a push to the operator's account. Everything else a
   * fallback decides can be re-read and re-judged; this one is already public.
   */
  | 'qa_fallback_ship'
  /**
   * Committed and pushed by an agent that had been refused a tool permission.
   * Not a failure - the gate passed - but the allow-list is missing something,
   * and every other place that says so is on a failure path.
   */
  | 'blocked_ship'
  /**
   * Committed and pushed by a task whose plan declared it changes behaviour
   * that already worked. Not a failure and not a warning - it is the only
   * durable record that a contract moved, and the run report that says so
   * scrolls away.
   */
  | 'breaking_ship'
  | 'task_failed'
  | 'task_dropped'
  | 'milestone_dropped'
  | 'config_change'
  | 'decision'
  | 'incident'
  /** A closed day of the working journal, condensed. See core/ingest-docs.ts. */
  | 'journal';

export interface Resolution {
  id: string;
  repo: string;
  resolved_at: string;
  kind: ResolutionKind;
  commit_sha: string | null;
  paths: string[];
  symbols: string[];
  reason: string | null;
  task_id: string | null;
  claim_key: string | null;
  /** When the event actually happened, as distinct from when it was recorded. */
  occurred_at: string | null;
}

export function addResolution(r: {
  repo: string;
  kind: ResolutionKind;
  commit_sha?: string | null;
  paths?: string[];
  symbols?: string[];
  reason?: string;
  task_id?: string | null;
  /** Author date, heading date, log timestamp. Defaults to now when unknown. */
  occurred_at?: string | null;
}): string {
  const id = shortId('X');
  const paths = r.paths ?? [];
  const symbols = r.symbols ?? [];
  open()
    .prepare(
      `INSERT INTO resolutions (id,repo,resolved_at,kind,commit_sha,paths,symbols,reason,task_id,claim_key,occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      r.repo,
      nowIso(),
      r.kind,
      r.commit_sha ?? null,
      JSON.stringify(paths),
      JSON.stringify(symbols),
      r.reason ?? null,
      r.task_id ?? null,
      paths.length || symbols.length ? claimKey(paths, symbols) : null,
      r.occurred_at ?? nowIso(),
    );
  return id;
}

/**
 * Record a memory, swallowing any failure.
 *
 * Remembering is never worth failing a run over. A locked database or a full
 * disk should cost a log line, not the task that was about to succeed.
 */
export function remember(r: Parameters<typeof addResolution>[0]): void {
  try {
    addResolution(r);
  } catch (e) {
    log.warn(`could not record memory (${r.kind}): ${(e as Error).message}`);
  }
}

function toResolution(row: Record<string, unknown>): Resolution {
  const safe = (s: unknown) => {
    try {
      return JSON.parse(String(s ?? '[]')) as string[];
    } catch {
      return [];
    }
  };
  return { ...(row as unknown as Resolution), paths: safe(row.paths), symbols: safe(row.symbols) };
}

export function recentResolutions(repo: string, limit = 200): Resolution[] {
  const rows = open()
    .prepare('SELECT * FROM resolutions WHERE repo=? ORDER BY resolved_at DESC LIMIT ?')
    .all(repo, limit) as unknown as Record<string, unknown>[];
  return rows.map(toResolution);
}

/**
 * Visit a repo's resolutions in bounded chunks (PERF-6).
 *
 * exportMemory used to pull up to 1,000,000 rows into memory at once. This is
 * the streaming alternative: keyset-paginated on (resolved_at, id) — one probe
 * per chunk, not an OFFSET scan — and the callback is handed the row in the
 * same shape `recentResolutions` returns (paths/symbols parsed to arrays).
 */
export function eachResolution(repo: string, visit: (r: Resolution) => void, chunk = 2000): void {
  const first = open().prepare(
    'SELECT * FROM resolutions WHERE repo=? ORDER BY resolved_at DESC, id DESC LIMIT ?',
  );
  const next = open().prepare(
    `SELECT * FROM resolutions
     WHERE repo=? AND (resolved_at < ? OR (resolved_at = ? AND id < ?))
     ORDER BY resolved_at DESC, id DESC LIMIT ?`,
  );
  let cursor: { resolved_at: string; id: string } | null = null;
  for (;;) {
    const rows = (
      cursor === null
        ? first.all(repo, chunk)
        : next.all(repo, cursor.resolved_at, cursor.resolved_at, cursor.id, chunk)
    ) as unknown as Record<string, unknown>[];
    if (rows.length === 0) return;
    for (const row of rows) visit(toResolution(row));
    if (rows.length < chunk) return;
    const last = rows[rows.length - 1]!;
    cursor = { resolved_at: String(last.resolved_at), id: String(last.id) };
  }
}

/**
 * Was this SHA produced by ShanAuto? Anything else is external work.
 *
 * Note on this repo specifically: history was rewritten on 2026-08-07 to unify
 * commit authorship before the first push, so the SHAs recorded against the 63
 * tasks committed before that point no longer appear in the current history.
 * Those commits therefore ingest as `external_commit`. That is cosmetic — the
 * staleness check reads paths and symbols, not provenance — and every commit
 * made after the rewrite matches exactly.
 */
export function isKnownCommit(sha: string): boolean {
  if (!sha) return false;
  const n = (
    open().prepare('SELECT COUNT(*) AS n FROM tasks WHERE commit_sha=?').get(sha) as { n: number }
  ).n;
  if (n > 0) return true;
  return (
    (
      open()
        .prepare("SELECT COUNT(*) AS n FROM resolutions WHERE commit_sha=? AND kind='shanauto_commit'")
        .get(sha) as { n: number }
    ).n > 0
  );
}

/** Most recent commit already ingested for this repo, so ingestion resumes. */
export function lastIngestedSha(repo: string): string | null {
  const row = open()
    .prepare(
      `SELECT commit_sha FROM resolutions
       WHERE repo=? AND kind='external_commit' AND commit_sha IS NOT NULL
       ORDER BY resolved_at DESC LIMIT 1`,
    )
    .get(repo) as { commit_sha: string } | undefined;
  return row?.commit_sha ?? null;
}

/**
 * Resolutions that landed since a task was planned — the "delta".
 *
 * Scoped by commit SHA rather than by timestamp: ingestion time is not commit
 * time, and a task must never be parked on the strength of when a row happened
 * to be written. `since` additionally picks up commit-less resolutions such as
 * `already_done`, which the agent reports at runtime and which carry no SHA.
 */
export function resolutionsForShas(repo: string, shas: string[], since?: string): Resolution[] {
  const out: Record<string, unknown>[] = [];

  if (shas.length > 0) {
    const chunk = 400; // stay well under SQLite's variable limit
    for (let i = 0; i < shas.length; i += chunk) {
      const slice = shas.slice(i, i + chunk);
      const placeholders = slice.map(() => '?').join(',');
      out.push(
        ...(open()
          .prepare(`SELECT * FROM resolutions WHERE repo=? AND commit_sha IN (${placeholders})`)
          .all(repo, ...slice) as unknown as Record<string, unknown>[]),
      );
    }
  }

  if (since) {
    /*
     * F8: some commit-less kinds write `occurred_at` and leave `resolved_at`
     * NULL, so filtering on `resolved_at` alone silently dropped them from the
     * delta — and a task parked on staleness never saw the resolution that had
     * actually landed. The order the rest of the code reads timestamps by is
     * `COALESCE(occurred_at, resolved_at)`, so filter by the same column.
     */
    out.push(
      ...(open()
        .prepare(
          `SELECT * FROM resolutions
           WHERE repo=? AND commit_sha IS NULL AND COALESCE(occurred_at, resolved_at) > ?`,
        )
        .all(repo, since) as unknown as Record<string, unknown>[]),
    );
  }
  return out.map(toResolution);
}

/**
 * Free-text search over what has been resolved.
 *
 * Uses LIKE, not FTS5 — a tracked deferral, not a habit (docs/DECISIONS.md
 * "Why LIKE instead of FTS5"). FTS5 is available in node:sqlite, but needs a
 * virtual table kept in sync with this append-only one: permanent complexity.
 * The audit's cost model is searchable bytes, not row count: this query
 * lowercases reason||paths||symbols for every row on every search, and journal
 * days are ingested whole, so the revisit trigger is ~10,000 rows OR ~50 MB of
 * searchable text (measured 2026-08-11: 231 rows / 37 KB).
 *
 * The worst case is already bounded: the result set is capped by `limit` (25 by
 * default), and a recency window was deliberately NOT added — `sa recall` exists
 * to search the entire memory, and a window would silently drop old decisions
 * from the answer. The one remaining cost is the LIKE scan itself; when the
 * trigger above is hit, the fix is the FTS5 virtual table, not a window.
 *
 * Every term must appear somewhere in the row (AND, not OR), which is what makes
 * a two-word query useful rather than a flood.
 */
export function searchResolutions(repo: string | null, query: string, limit = 25): Resolution[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (terms.length === 0) return [];

  const haystack = "(lower(ifnull(reason,'')) || ' ' || lower(paths) || ' ' || lower(symbols) || ' ' || lower(ifnull(commit_sha,'')))";
  const where = terms.map(() => `${haystack} LIKE ?`).join(' AND ');
  const params: (string | number)[] = terms.map((t) => `%${t}%`);

  const repoClause = repo ? 'repo=? AND ' : '';
  if (repo) params.unshift(repo);
  params.push(limit);

  /*
   * Ordered by when the thing HAPPENED, not when it was filed.
   *
   * resolved_at is the ingestion minute — the schema comment above says so — and
   * 241 of 263 rows share one ingestion day, so ordering by it sorted the whole
   * history by insertion order. The 25 that survived the limit were arbitrary.
   */
  const rows = open()
    .prepare(
      `SELECT * FROM resolutions WHERE ${repoClause}${where}
       ORDER BY COALESCE(occurred_at, resolved_at) DESC LIMIT ?`,
    )
    .all(...params) as unknown as Record<string, unknown>[];
  return rows.map(toResolution);
}

/**
 * How many memories match, ignoring the page size.
 *
 * `searchResolutions` defaults to 25 and the caller printed `hits.length` as if
 * it were the answer: "25 result(s)" for a query that matched 107. The owner
 * reads that as the complete record and stops looking.
 */
export function countResolutions(repo: string | null, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  if (terms.length === 0) return 0;

  const haystack =
    "(lower(ifnull(reason,'')) || ' ' || lower(paths) || ' ' || lower(symbols) || ' ' || lower(ifnull(commit_sha,'')))";
  const where = terms.map(() => `${haystack} LIKE ?`).join(' AND ');
  const params: string[] = terms.map((t) => `%${t}%`);
  const repoClause = repo ? 'repo=? AND ' : '';
  if (repo) params.unshift(repo);

  return (
    open()
      .prepare(`SELECT COUNT(*) AS n FROM resolutions WHERE ${repoClause}${where}`)
      .get(...params) as { n: number }
  ).n;
}

/**
 * Memories of particular kinds, newest first by when they HAPPENED.
 *
 * Retrieval cannot read every row once history is years deep, so something has
 * to be dropped — and dropping by `resolved_at` drops arbitrarily, because bulk
 * ingestion stamps thousands of rows with nearly the same value. Reasoning is
 * rare (a few dozen decisions across three years) and is usually what a question
 * is actually about, so it is fetched unconditionally and never competes with
 * commits for room.
 */
/**
 * Which journal days are already in memory, as `YYYY-MM-DD`.
 *
 * Ingestion used to establish this by loading every stored day IN FULL and
 * reading line one of each — tens of KB per row, growing forever, to answer a
 * question the `occurred_at` column already holds. `ingestJournal` stamps each
 * day at noon on the day itself, so the date is the key.
 *
 * SQLite does the projection, so a three-year store costs a few hundred short
 * strings instead of tens of megabytes on a path that must fail open.
 */
export function ingestedJournalDays(repo: string): Set<string> {
  const rows = open()
    .prepare(
      "SELECT DISTINCT date(occurred_at) AS day FROM resolutions WHERE repo=? AND kind='journal' AND occurred_at IS NOT NULL",
    )
    .all(repo) as unknown as { day: string | null }[];
  return new Set(rows.map((r) => r.day).filter((d): d is string => !!d));
}

export function resolutionsByKind(repo: string, kinds: ResolutionKind[], limit = 2000): Resolution[] {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => '?').join(',');
  const rows = open()
    .prepare(
      `SELECT * FROM resolutions
       WHERE repo=? AND kind IN (${placeholders})
       ORDER BY COALESCE(occurred_at, resolved_at) DESC LIMIT ?`,
    )
    .all(repo, ...kinds, limit) as unknown as Record<string, unknown>[];
  return rows.map(toResolution);
}

/** Memories inside a half-open window [from, to). */
export function resolutionsBetween(repo: string, from: string, to: string): Resolution[] {
  const rows = open()
    .prepare(
      // COALESCE, not a bare column: any row inserted without occurred_at would
      // otherwise vanish from every rollup. Falling back here is robust however
      // the row got in, where a one-time backfill is not.
      `SELECT * FROM resolutions WHERE repo=?
         AND COALESCE(occurred_at, resolved_at) >= ?
         AND COALESCE(occurred_at, resolved_at) <  ?
       ORDER BY COALESCE(occurred_at, resolved_at) ASC`,
    )
    .all(repo, from, to) as unknown as Record<string, unknown>[];
  return rows.map(toResolution);
}

/** Oldest memory for a repo, so rollups know where history begins. */
export function earliestResolutionAt(repo: string): string | null {
  const row = open()
    .prepare('SELECT MIN(COALESCE(occurred_at, resolved_at)) AS t FROM resolutions WHERE repo=?')
    .get(repo) as { t: string | null };
  return row?.t ?? null;
}

export interface RollupRow {
  id: string;
  repo: string;
  period: string;
  starts_at: string;
  ends_at: string;
  stats: string;
  narrative: string | null;
  source_count: number;
  built_at: string;
}

/** Upsert by (repo, period, starts_at) so rebuilding a period is safe. */
export function saveRollup(r: {
  repo: string;
  period: string;
  starts_at: string;
  ends_at: string;
  stats: unknown;
  source_count: number;
  narrative?: string | null;
}): void {
  /*
   * A rollup with no period or no start date is not a rollup.
   *
   * The UNIQUE key is (repo, period, starts_at), so a row with either field
   * empty collides with every other malformed row and the upsert quietly
   * OVERWRITES a real summary. importMemory reaches this straight from a JSONL
   * line with String(rec.period) — which is "undefined" for a truncated file —
   * so one damaged line could replace a month's compressed memory with itself.
   * Refusing costs one line of a restore; admitting it costs the period.
   */
  const bad = ['repo', 'period', 'starts_at'].filter(
    (k) => !String((r as Record<string, unknown>)[k] ?? '').trim() ||
      String((r as Record<string, unknown>)[k]) === 'undefined',
  );
  if (bad.length) {
    throw new Error(`Refusing to store a rollup with empty ${bad.join(', ')}`);
  }

  open()
    .prepare(
      `INSERT INTO memory_rollups (id,repo,period,starts_at,ends_at,stats,narrative,source_count,built_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo,period,starts_at) DO UPDATE SET
         ends_at=excluded.ends_at, stats=excluded.stats,
         source_count=excluded.source_count, built_at=excluded.built_at,
         -- a rebuild must not discard a narrative that cost a model call
         narrative=COALESCE(excluded.narrative, memory_rollups.narrative)`,
    )
    .run(
      shortId('R'),
      r.repo,
      r.period,
      r.starts_at,
      r.ends_at,
      JSON.stringify(r.stats),
      r.narrative ?? null,
      r.source_count,
      nowIso(),
    );
}

export function getRollups(repo: string, period?: string, limit = 200): RollupRow[] {
  const sql = period
    ? 'SELECT * FROM memory_rollups WHERE repo=? AND period=? ORDER BY starts_at DESC LIMIT ?'
    : 'SELECT * FROM memory_rollups WHERE repo=? ORDER BY starts_at DESC LIMIT ?';
  const stmt = open().prepare(sql);
  const rows = period ? stmt.all(repo, period, limit) : stmt.all(repo, limit);
  return rows as unknown as RollupRow[];
}

/**
 * Visit a repo's rollups in bounded chunks (PERF-6), the rollup counterpart of
 * `eachResolution` — same keyset pagination on (starts_at, id).
 */
export function eachRollup(repo: string, visit: (r: RollupRow) => void, chunk = 2000): void {
  const first = open().prepare(
    'SELECT * FROM memory_rollups WHERE repo=? ORDER BY starts_at DESC, id DESC LIMIT ?',
  );
  const next = open().prepare(
    `SELECT * FROM memory_rollups
     WHERE repo=? AND (starts_at < ? OR (starts_at = ? AND id < ?))
     ORDER BY starts_at DESC, id DESC LIMIT ?`,
  );
  let cursor: { starts_at: string; id: string } | null = null;
  for (;;) {
    const rows = (
      cursor === null
        ? first.all(repo, chunk)
        : next.all(repo, cursor.starts_at, cursor.starts_at, cursor.id, chunk)
    ) as unknown as Record<string, unknown>[];
    if (rows.length === 0) return;
    for (const row of rows) visit(row as unknown as RollupRow);
    if (rows.length < chunk) return;
    const last = rows[rows.length - 1]!;
    cursor = { starts_at: String(last.starts_at), id: String(last.id) };
  }
}

/** Rollups still missing a narrative, oldest first — the model-call queue. */
export function rollupsNeedingNarrative(repo: string, limit = 20): RollupRow[] {
  return open()
    .prepare(
      `SELECT * FROM memory_rollups
       WHERE repo=? AND (narrative IS NULL OR narrative='') AND source_count > 0
       ORDER BY starts_at ASC LIMIT ?`,
    )
    .all(repo, limit) as unknown as RollupRow[];
}

export function setRollupNarrative(id: string, narrative: string): void {
  open().prepare('UPDATE memory_rollups SET narrative=? WHERE id=?').run(narrative, id);
}

export function hasResolutionForSha(sha: string): boolean {
  return (
    (
      open()
        .prepare('SELECT COUNT(*) AS n FROM resolutions WHERE commit_sha=?')
        .get(sha) as { n: number }
    ).n > 0
  );
}

/*
 * Work that was reverted for somebody else broken test, once that test is fixed.
 *
 * The gate is careful to separate "this task broke it" from "it was already
 * broken". VERIFY_UNRELATED is the second, and it is a positive statement that
 * the task did nothing wrong: the gate reverted it, re-ran the check, and the
 * check still failed. It was nonetheless marked `failed`, which is terminal --
 * only `sa retry --failed` brings those back, and the operator drives a TUI.
 *
 * Found on 2026-08-20 driving run 5. The repair landed, the run logged "its held
 * work is back in play", the work that was HELD resumed and committed, and the
 * one task already reverted as innocent stayed failed. It was the central
 * feature of the idea, and the run reported success without it.
 *
 * Attempts are deliberately NOT reset. Coming back once, bounded by
 * max_attempts, is a second chance. Coming back forever is a loop.
 */
export function reopenUnrelatedFailures(repo: string): string[] {
  const rows = open()
    .prepare(
      "SELECT id FROM tasks WHERE repo=? AND status='failed' AND last_error LIKE '%VERIFY_UNRELATED:%'",
    )
    .all(repo) as unknown as { id: string }[];
  for (const r of rows) {
    setStatus(r.id, 'ready', 'reverted for a failure that has since been repaired');
  }
  return rows.map((r) => r.id);
}

/**
 * Failed work that nothing is going to pick up on its own.
 *
 * `recentFailures` answers "what failed", which is not the same question and
 * was being used for both. The status screen printed NEEDS YOU over every
 * failed task and, four lines lower, "1 of them will be planned again
 * automatically on the next run. Nothing to do." Both from the same ledger,
 * about the same task, on the same screen.
 *
 * A failed task under a milestone with automatic re-plans left is handled:
 * `autoReplanBlocked` supersedes it and re-decomposes the milestone at the
 * start of the next run. It belongs in the record, not in a banner telling the
 * operator to go and type something.
 *
 * What is left over is the real list. A milestone that has been decomposed
 * MILESTONE_AUTO_REPLANS different ways and failed every time has run out of
 * things the machine can try, and that is when asking is honest.
 *
 * Tasks with no milestone at all - repair jobs - come back from here, because
 * this cannot see whether their project is still red. `ensureRepairTask` revives
 * them when it is, so the caller filters them out; see the status screen.
 */
export function strandedFailures(limit = 20, replanLimit = MILESTONE_AUTO_REPLANS): TaskRow[] {
  return open()
    .prepare(
      `SELECT t.* FROM tasks t
         LEFT JOIN milestones m ON m.id = t.milestone_id
        WHERE t.status IN ('failed','blocked')
          AND NOT (m.id IS NOT NULL AND COALESCE(m.replans,0) < ?)
        ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(replanLimit, limit) as unknown as TaskRow[];
}

export function recentFailures(limit = 20): TaskRow[] {
  return open()
    .prepare("SELECT * FROM tasks WHERE status IN ('failed','blocked') ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as unknown as TaskRow[];
}

/** Tasks parked for a human to finish in a GUI agent. Not failures. */
export function handoffTasks(limit = 50): TaskRow[] {
  return open()
    .prepare("SELECT * FROM tasks WHERE status='handoff' ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as unknown as TaskRow[];
}

export function getDailyCommitCounts(): DailyCommitCount[] {
  return open()
    .prepare(
      "SELECT committed_day AS date, COUNT(*) AS count FROM tasks WHERE status='committed' AND committed_day IS NOT NULL GROUP BY committed_day ORDER BY committed_day ASC"
    )
    .all() as unknown as DailyCommitCount[];
}

export function getRecentVelocity(): number {
  const row = open()
    .prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE status='committed' AND committed_day > date('now','-7 days','localtime')"
    )
    .get() as { n: number };
  return row.n / 7;
}

export function serializeLedgerToCsv(rows: TaskRowToCsv[]): string {
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerRow = CSV_HEADER.join(',');
  const dataRows = rows.map((row) =>
    CSV_HEADER.map((col) => escapeCsv(row[(col === 'ID' ? 'id' : col) as keyof TaskRowToCsv])).join(',')
  );

  return [headerRow, ...dataRows].join('\n');
}

export function exportLedgerToCsv(): void {
  // Bounded: the export exists to hand a human a view of the ledger, and a
  // full dump of an unbounded history would string the entire tasks table
  // through memory at once. Newest first so the recent — and therefore most
  // useful — rows are never the ones cut off. Revisit the cap if it ever
  // approaches the real history length.
  const tasks = open()
    .prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 10000')
    .all() as unknown as TaskRowToCsv[];
  const csv = serializeLedgerToCsv(tasks);
  const outPath = join(reportsDir(), 'ledger.csv');
  writeFileSafe(outPath, csv);
}
