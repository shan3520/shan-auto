import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_ROW_COLUMNS, type NormalizedTask } from '../schemas.js';

const dir = mkdtempSync(join(tmpdir(), 'sa-ledger-'));
process.env.SHANAUTO_DB = join(dir, 'test.db');

const ledger = await import('../ledger.js');

function task(over: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    title: 'a task',
    kind: 'feature',
    instruction: 'do the thing',
    acceptance: 'the thing is done',
    files_hint: [],
    verify_cmd: 'echo ok',
    depends_on: [],
    est_lines: 10,
    executor_hint: 'cli',
    ...over,
  };
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM tasks; DELETE FROM milestones; DELETE FROM epics; DELETE FROM ideas;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('schema / interface consistency', () => {
  /**
   * The regression that motivated this suite: an agent added `resets` and
   * `last_reset_at` to TaskRow with no matching columns. It typechecked and
   * passed the old typecheck-only gate, leaving the interface lying about the
   * database. This test makes that impossible to land again.
   */
  it('every TaskRow field exists as a real column on tasks', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(ledger.SCHEMA);
    const cols = new Set(
      (db.prepare('PRAGMA table_info(tasks)').all() as unknown as { name: string }[]).map((c) => c.name),
    );
    db.close();

    const missing = TASK_ROW_COLUMNS.filter((c) => !cols.has(c));
    expect(missing, `TaskRow declares columns the tasks table does not have: ${missing.join(', ')}`).toEqual([]);
  });

  it('reading a row back yields every declared field', () => {
    ledger.insertTasks(null, 'r1', [task()]);
    const row = ledger.readyTasks('r1')[0]!;
    for (const col of TASK_ROW_COLUMNS) {
      expect(row, `row is missing "${col}"`).toHaveProperty(col);
    }
  });
});

describe('insertTasks', () => {
  it('marks dependency-free tasks ready and dependent ones pending', () => {
    ledger.insertTasks(null, 'r1', [task({ title: 'first' }), task({ title: 'second', depends_on: [0] })]);
    expect(ledger.countByStatus()).toMatchObject({ ready: 1, pending: 1 });
  });

  it('converts dependency indexes into real task ids', () => {
    const ids = ledger.insertTasks(null, 'r1', [task({ title: 'base' }), task({ title: 'dep', depends_on: [0] })]);
    const dep = ledger.getTask(ids[1]!)!;
    expect(JSON.parse(dep.depends_on)).toEqual([ids[0]]);
  });

  it('ignores forward references, which would deadlock the queue', () => {
    const ids = ledger.insertTasks(null, 'r1', [task({ title: 'points forward', depends_on: [1] }), task()]);
    expect(JSON.parse(ledger.getTask(ids[0]!)!.depends_on)).toEqual([]);
  });
});

describe('unblockDependents', () => {
  it('frees a task only once every dependency is committed', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b' }),
      task({ title: 'c', depends_on: [0, 1] }),
    ]);
    ledger.markCommitted(ids[0]!, 'sha1');
    expect(ledger.getTask(ids[2]!)!.status).toBe('pending');

    ledger.markCommitted(ids[1]!, 'sha2');
    expect(ledger.getTask(ids[2]!)!.status).toBe('ready');
  });

  it('handles malformed JSON in depends_on gracefully', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
    ]);
    // Manually corrupt the depends_on column with invalid JSON
    const db = ledger.open();
    db.prepare("UPDATE tasks SET depends_on='not json' WHERE id=?").run(ids[1]!);

    // Should not crash, should treat as no dependencies and free the task
    const freed = ledger.unblockDependents(ids[0]!);
    expect(freed).toBe(1);
    expect(ledger.getTask(ids[1]!)!.status).toBe('ready');
  });

  it('handles empty string in depends_on gracefully', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
    ]);
    const db = ledger.open();
    db.prepare("UPDATE tasks SET depends_on='' WHERE id=?").run(ids[1]!);

    const freed = ledger.unblockDependents(ids[0]!);
    expect(freed).toBe(1);
    expect(ledger.getTask(ids[1]!)!.status).toBe('ready');
  });

  it('handles null/undefined depends_on gracefully', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
    ]);
    // depends_on has NOT NULL constraint, so test with empty string instead
    const db = ledger.open();
    db.prepare("UPDATE tasks SET depends_on='' WHERE id=?").run(ids[1]!);

    const freed = ledger.unblockDependents(ids[0]!);
    expect(freed).toBe(1);
    expect(ledger.getTask(ids[1]!)!.status).toBe('ready');
  });
});

describe('deadlockedTaskIds', () => {
  it('marks tasks as deadlocked when an upstream task fails', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
      task({ title: 'c', depends_on: [1] }),
    ]);
    ledger.setStatus(ids[0]!, 'failed');
    const deadlocked = ledger.deadlockedTaskIds();
    expect(deadlocked.has(ids[1]!)).toBe(true);
    expect(deadlocked.has(ids[2]!)).toBe(true);
  });

  it('does not deadlock tasks with missing dependency IDs (treats missing as hard deadlock cause)', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
    ]);
    // Manually add a dependency on a non-existent task
    const db = ledger.open();
    db.prepare("UPDATE tasks SET depends_on='[\"missing-id\"]' WHERE id=?").run(ids[1]!);

    const deadlocked = ledger.deadlockedTaskIds();
    // Missing dependency should cause deadlock
    expect(deadlocked.has(ids[1]!)).toBe(true);
  });

  it('does not deadlock tasks depending on committed/dropped tasks', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
      task({ title: 'c', depends_on: [1] }),
    ]);
    ledger.markCommitted(ids[0]!, 'sha1');
    ledger.setStatus(ids[1]!, 'dropped');
    const deadlocked = ledger.deadlockedTaskIds();
    expect(deadlocked.has(ids[2]!)).toBe(false);
  });

  it('does not deadlock tasks depending on running/handoff tasks', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
      task({ title: 'c', depends_on: [1] }),
    ]);
    ledger.setStatus(ids[0]!, 'running');
    ledger.setStatus(ids[1]!, 'handoff');
    const deadlocked = ledger.deadlockedTaskIds();
    expect(deadlocked.has(ids[2]!)).toBe(false);
  });
});

describe('markDeadlocked', () => {
  it('moves deadlocked tasks to blocked with error message for failed upstream', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
      task({ title: 'c', depends_on: [1] }),
    ]);
    ledger.setStatus(ids[0]!, 'failed');
    const count = ledger.markDeadlocked();
    expect(count).toBe(2);
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');
    expect(ledger.getTask(ids[1]!)!.last_error).toContain('upstream task failed');
    expect(ledger.getTask(ids[2]!)!.status).toBe('blocked');
    expect(ledger.getTask(ids[2]!)!.last_error).toContain('upstream task failed');
  });

  it('provides specific error message for missing dependency IDs', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b', depends_on: [0] }),
    ]);
    const db = ledger.open();
    db.prepare("UPDATE tasks SET depends_on='[\"missing-id\"]' WHERE id=?").run(ids[1]!);

    const count = ledger.markDeadlocked();
    expect(count).toBe(1);
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');
    expect(ledger.getTask(ids[1]!)!.last_error).toContain('missing upstream dependency');
    expect(ledger.getTask(ids[1]!)!.last_error).toContain('missing-id');
  });

  it('returns 0 when no tasks are deadlocked', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'a' }),
      task({ title: 'b' }),
    ]);
    const count = ledger.markDeadlocked();
    expect(count).toBe(0);
  });
});

describe('knownTitles', () => {
  it('includes queued and dropped work but not failed work', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task({ title: 'committed one' }),
      task({ title: 'dropped one' }),
      task({ title: 'failed one' }),
      task({ title: 'ready one' }),
    ]);
    ledger.markCommitted(ids[0]!, 'sha');
    ledger.setStatus(ids[1]!, 'dropped');
    ledger.setStatus(ids[2]!, 'failed');

    const titles = ledger.knownTitles('r1');
    expect(titles).toContain('committed one');
    expect(titles).toContain('dropped one');
    expect(titles).toContain('ready one');
    // failed tasks stay proposable, because they may deserve a retry
    expect(titles).not.toContain('failed one');
  });
});

/**
 * updated_at is stored as UTC; the day boundary people care about is local.
 * Comparing a UTC date against a local date meant that in any timezone ahead of
 * UTC, every commit between local midnight and the UTC rollover was invisible.
 * Nine real commits landed and committedToday() returned 0.
 *
 * committedToday enforces max_daily_commits, so under-counting does not just
 * mis-report — it disables the hard ceiling.
 */
describe('the daily counter uses local days', () => {
  beforeEach(() => {
    ledger.open().exec("DELETE FROM tasks;");
  });

  it('counts a commit stamped in UTC on the local day it happened', () => {
    const db = ledger.open();
    // Local "now", expressed as the UTC instant SQLite would have stored.
    const utcNow = db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t")
      .get() as { t: string };
    // markCommitted now records the local day in committed_day; a raw row must
    // carry it to be counted, exactly as the backfill gives legacy rows.
    db.prepare(
      "INSERT INTO tasks (id,repo,title,instruction,acceptance,verify_cmd,files_hint,kind,status,updated_at,committed_day) " +
        "VALUES ('T-utc','r','t','i','a','echo ok','[]','feature','committed',?,date(?,'localtime'))",
    ).run(utcNow.t, utcNow.t);

    expect(ledger.committedToday()).toBe(1);
    expect(ledger.todaysCommits().map((t) => t.id)).toContain('T-utc');
  });

  it('does not count a commit from a week ago', () => {
    ledger
      .open()
      .prepare(
        "INSERT INTO tasks (id,repo,title,instruction,acceptance,verify_cmd,files_hint,kind,status,updated_at,committed_day) " +
          "VALUES ('T-old','r','t','i','a','echo ok','[]','feature','committed'," +
          "strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')," +
          "date(strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'),'localtime'))",
      )
      .run();
    expect(ledger.committedToday()).toBe(0);
  });

  it('counts committed tasks grouped by their local commit day', () => {
    const db = ledger.open();
    const insert = (
      id: string,
      status: string,
      utc: string,
    ) =>
      db
        .prepare(
          "INSERT INTO tasks (id,repo,title,instruction,acceptance,verify_cmd,files_hint,kind,status,updated_at,committed_day) " +
            "VALUES (?, 'repo', 'title', 'inst', 'acc', 'echo ok', '[]', 'feature', ?, ?, date(?,'localtime'))",
        )
        .run(id, status, utc, utc);

    // Two commits on the same local day, one pending (ignored), one commit on
    // another day, one failed (ignored).
    insert('1', 'committed', '2026-08-01T10:00:00Z');
    insert('2', 'committed', '2026-08-01T15:00:00Z');
    insert('3', 'pending', '2026-08-01T16:00:00Z');
    insert('4', 'committed', '2026-08-03T09:00:00Z');
    insert('5', 'failed', '2026-08-03T11:00:00Z');

    expect(ledger.getDailyCommitCounts()).toEqual([
      { date: '2026-08-01', count: 2 },
      { date: '2026-08-03', count: 1 },
    ]);
  });
});

/**
 * A milestone in a status no query names is unreachable in every direction at
 * once: the planner will not pick it up, `sa status` will not list it, and
 * `sa retry --failed` will not requeue it. The work is neither done nor
 * queued nor visible, and nothing anywhere says so.
 *
 * This is not hypothetical. `planNextMilestone` writes 'failed' when the
 * decomposer proposes no tasks, and the old queries only ever asked for
 * 'rejected'. M9b7oj3cz9u sat in 'pending' — a *task* status, on a milestone —
 * for eight days, invisible, until it was found by hand.
 */
describe('a milestone stranded in an unrecognised status', () => {
  const put = (id: string, status: string | null, ord: number, lastError: string | null = null) =>
    ledger
      .open()
      .prepare(
        "INSERT INTO milestones (id,epic_id,title,detail,repo,status,ord,created_at,last_error) " +
          "VALUES (?,'E1','a milestone','detail','r1',?,?,'2026-08-08T04:24:06.546Z',?)",
      )
      .run(id, status, ord, lastError);

  it('is listed as stuck even though nothing ever wrote that status on purpose', () => {
    put('M-pending', 'pending', 0);
    expect(ledger.stuckMilestones().map((m) => m.id)).toEqual(['M-pending']);
  });

  it('is listed as stuck when the decomposer proposed nothing at all', () => {
    // planner.ts writes exactly this; the old query asked only for 'rejected'.
    put('M-failed', 'failed', 0);
    expect(ledger.stuckMilestones().map((m) => m.id)).toEqual(['M-failed']);
  });

  it('is listed as stuck when the status is missing entirely', () => {
    // `NOT (x IN (...))` is NULL, not true, for a NULL x — so a null status
    // silently escapes the obvious spelling of this predicate.
    put('M-null', null, 0);
    expect(ledger.stuckMilestones().map((m) => m.id)).toEqual(['M-null']);
  });

  it('still recognises the rejected milestone the list was written for', () => {
    put('M-rejected', 'rejected', 0);
    expect(ledger.stuckMilestones().map((m) => m.id)).toEqual(['M-rejected']);
  });

  it('leaves the two live statuses alone', () => {
    put('M-unplanned', 'unplanned', 0);
    put('M-planned', 'planned', 1);
    expect(ledger.stuckMilestones()).toEqual([]);
  });

  it('is requeued by the same command that recovers a rejected one', () => {
    put('M-pending', 'pending', 0);
    put('M-failed', 'failed', 1, 'the decomposer proposed no tasks at all');
    put('M-rejected', 'rejected', 2, 'all 3 proposal(s) rejected');
    put('M-planned', 'planned', 3);

    expect(ledger.replanStuckMilestones()).toBe(3);

    const rows = ledger
      .open()
      .prepare('SELECT id,status,last_error FROM milestones ORDER BY ord')
      .all() as unknown as { id: string; status: string; last_error: string | null }[];
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['M-pending', 'unplanned'],
      ['M-failed', 'unplanned'],
      ['M-rejected', 'unplanned'],
      ['M-planned', 'planned'],
    ]);
    // The stale reason must go with the status, or `sa status` keeps quoting a
    // rejection for a milestone that is now queued.
    expect(rows.every((r) => r.last_error === null)).toBe(true);
  });

  it('becomes reachable by the planner once requeued', () => {
    put('M-pending', 'pending', 0);
    expect(ledger.nextUnplannedMilestone()).toBeNull();

    ledger.replanStuckMilestones();
    expect(ledger.nextUnplannedMilestone()?.id).toBe('M-pending');
  });

  it('does not requeue anything when every milestone is live', () => {
    put('M-planned', 'planned', 0);
    expect(ledger.replanStuckMilestones()).toBe(0);
  });

  /*
   * The brain answering "already built" is the one stuck status that must not
   * be swept up by the blanket requeue. `sa status` prints "nothing to do" for
   * it and points at a per-id retry; if `retry --failed` moved it anyway, that
   * text would be a lie and the next plan run would spend a model call
   * re-asking a question with an answer already on file.
   */
  describe('a milestone the brain answered as already built', () => {
    it('is still listed, because an unconfirmed claim must stay visible', () => {
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0, 'the brain found no work left: Document exists');
      expect(ledger.stuckMilestones().map((m) => m.id)).toEqual(['M-built']);
    });

    it('carries its status, so the screen can tell it from a failure', () => {
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0);
      put('M-rejected', 'rejected', 1);
      expect(ledger.stuckMilestones().map((m) => [m.id, m.status])).toEqual([
        ['M-built', ledger.ALREADY_BUILT_STATUS],
        ['M-rejected', 'rejected'],
      ]);
    });

    it('is left alone by the blanket requeue', () => {
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0, 'the brain found no work left: Document exists');
      expect(ledger.replanStuckMilestones()).toBe(0);
      const row = ledger
        .open()
        .prepare('SELECT status,last_error FROM milestones WHERE id=?')
        .get('M-built') as { status: string; last_error: string | null };
      expect(row.status).toBe(ledger.ALREADY_BUILT_STATUS);
      // The reasoning is the only evidence the operator has to judge the claim
      // by. Clearing it would leave the milestone listed with nothing to read.
      expect(row.last_error).toContain('Document exists');
    });

    it('is not counted in what the requeue reports moving', () => {
      // The count and the update must see the same rows, or the operator is
      // told two milestones went back and finds one.
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0);
      put('M-rejected', 'rejected', 1);
      expect(ledger.replanStuckMilestones()).toBe(1);
      expect(ledger.nextUnplannedMilestone()?.id).toBe('M-rejected');
    });

    it('does not shield the other stuck milestones from the requeue', () => {
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0);
      put('M-failed', 'failed', 1);
      put('M-null', null, 2);
      put('M-pending', 'pending', 3);
      expect(ledger.replanStuckMilestones()).toBe(3);
      const rows = ledger
        .open()
        .prepare('SELECT id,status FROM milestones ORDER BY ord')
        .all() as unknown as { id: string; status: string | null }[];
      expect(rows.map((r) => [r.id, r.status])).toEqual([
        ['M-built', ledger.ALREADY_BUILT_STATUS],
        ['M-failed', 'unplanned'],
        ['M-null', 'unplanned'],
        ['M-pending', 'unplanned'],
      ]);
    });

    it('does not strand a null status on the way past', () => {
      // `status <> 'x'` is NULL for a NULL status, not true, so the obvious
      // spelling of the exclusion would silently drop M-null from the requeue -
      // re-opening the exact hole this whole list was written to close.
      put('M-null', null, 0);
      expect(ledger.replanStuckMilestones()).toBe(1);
      expect(ledger.nextUnplannedMilestone()?.id).toBe('M-null');
    });

    it('is separated from the milestones nobody has an answer for', () => {
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0);
      put('M-rejected', 'rejected', 1);
      put('M-null', null, 2);
      const { unplanned, alreadyBuilt } = ledger.partitionStuck(ledger.stuckMilestones());
      expect(alreadyBuilt.map((m) => m.id)).toEqual(['M-built']);
      // Everything else stays on the side that warns and offers a requeue -
      // including the null status, which belongs to neither name.
      expect(unplanned.map((m) => m.id)).toEqual(['M-rejected', 'M-null']);
    });

    it('loses nothing in the split', () => {
      // Both screens read one side each. A milestone in neither is invisible,
      // which is the failure this whole list exists to prevent.
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0);
      put('M-failed', 'failed', 1);
      put('M-pending', 'pending', 2);
      const rows = ledger.stuckMilestones();
      const { unplanned, alreadyBuilt } = ledger.partitionStuck(rows);
      expect([...unplanned, ...alreadyBuilt].map((m) => m.id).sort()).toEqual(
        rows.map((m) => m.id).sort(),
      );
      expect(unplanned.some((m) => alreadyBuilt.includes(m))).toBe(false);
    });

    it('is what doctor leaves out of its outstanding-work warning', () => {
      // doctor warns "work outstanding, run retry --failed". For a milestone
      // that requeue no longer touches, that warning is unactionable noise.
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0);
      expect(ledger.partitionStuck(ledger.stuckMilestones()).unplanned).toEqual([]);
      expect(ledger.replanStuckMilestones()).toBe(0);
    });

    it('can still be requeued by id when the operator disagrees', () => {
      // The escape hatch `sa status` prints. Without it the exclusion above
      // would make the answer unappealable.
      put('M-built', ledger.ALREADY_BUILT_STATUS, 0, 'the brain found no work left');
      expect(ledger.replanMilestone('M-built')).toBe(true);
      expect(ledger.nextUnplannedMilestone()?.id).toBe('M-built');
    });
  });
});

/**
 * The hole one status over from the one above: `planned` is inside the live
 * set, so a milestone whose every task was dropped reads as done and no list
 * mentions it. Mkiw11dh9jx sat here - its only task was dropped for being a
 * placeholder naming `npm test` in a Python repo, so the plan was defective and
 * the work is still outstanding.
 */
describe('a milestone marked planned with nothing left under it', () => {
  const milestone = (id: string, status: string | null, ord = 0) =>
    ledger
      .open()
      .prepare(
        'INSERT INTO milestones (id,epic_id,title,detail,repo,status,ord,created_at) ' +
          "VALUES (?,'E1','a milestone','detail','r1',?,?,'2026-08-08T04:24:06.546Z')",
      )
      .run(id, status, ord);

  const task = (id: string, milestoneId: string, status: string, lastError: string | null = null) =>
    ledger
      .open()
      .prepare(
        'INSERT INTO tasks (id,repo,milestone_id,title,instruction,acceptance,verify_cmd,files_hint,kind,status,updated_at,last_error) ' +
          "VALUES (?,'r1',?,'t','i','a','echo ok','[]','feature',?,'2026-08-08T04:24:06.546Z',?)",
      )
      .run(id, milestoneId, status, lastError);

  it('is listed once every one of its tasks is dropped', () => {
    milestone('M-hollow', 'planned');
    task('T1', 'M-hollow', 'dropped', 'placeholder instruction no agent can act on');

    expect(ledger.hollowMilestones().map((m) => m.id)).toEqual(['M-hollow']);
  });

  it('reports why the tasks were dropped, so already-done can be told from still-outstanding', () => {
    milestone('M-hollow', 'planned');
    task('T1', 'M-hollow', 'dropped', 'agent reported the work was already done');

    expect(ledger.hollowMilestones()[0]!.reasons).toContain('already done');
  });

  it('is listed when the planner queued no task for it at all', () => {
    milestone('M-empty', 'planned');
    expect(ledger.hollowMilestones().map((m) => m.id)).toEqual(['M-empty']);
  });

  it('is left alone while any task under it survives', () => {
    milestone('M-live', 'planned');
    task('T1', 'M-live', 'dropped');
    task('T2', 'M-live', 'ready');

    expect(ledger.hollowMilestones()).toEqual([]);
  });

  it('is left alone when its work was actually committed', () => {
    milestone('M-done', 'planned');
    task('T1', 'M-done', 'committed');

    expect(ledger.hollowMilestones()).toEqual([]);
  });

  it('counts a task status no code has written yet as live, rather than as gone', () => {
    // The safe direction: an unrecognised status must not silently hollow out a
    // milestone. Only 'dropped' means the task is gone.
    milestone('M-unknown', 'planned');
    task('T1', 'M-unknown', 'quarantined');

    expect(ledger.hollowMilestones()).toEqual([]);
  });

  it('does not list a milestone that is stuck rather than hollow', () => {
    // stuckMilestones owns those. Two lists reporting the same milestone would
    // offer the operator two different recoveries for one problem.
    milestone('M-rejected', 'rejected');
    expect(ledger.hollowMilestones()).toEqual([]);
    expect(ledger.stuckMilestones().map((m) => m.id)).toEqual(['M-rejected']);
  });

  it('is NOT swept up by the blanket requeue, because some are hollow from finished work', () => {
    /*
     * The dangerous version of this fix. Three of the six found on 2026-08-18
     * were hollow because the work already existed in the repo; requeueing them
     * spends quota re-proposing finished work, which is the outcome that
     * started the investigation.
     */
    milestone('M-hollow', 'planned');
    task('T1', 'M-hollow', 'dropped', 'agent reported the work was already done');

    expect(ledger.replanStuckMilestones()).toBe(0);
    expect(ledger.hollowMilestones().map((m) => m.id)).toEqual(['M-hollow']);
  });

  it('is requeued one at a time by id, and then reaches the planner', () => {
    milestone('M-hollow', 'planned');
    task('T1', 'M-hollow', 'dropped', 'placeholder instruction no agent can act on');

    expect(ledger.replanMilestone('M-hollow')).toBe(true);
    expect(ledger.hollowMilestones()).toEqual([]);
    // The point of requeueing: the planner can now see it.
    expect(ledger.nextUnplannedMilestone()?.id).toBe('M-hollow');
  });

  /*
   * The operator's own answer. Two milestones were planned against a `frontend/`
   * directory that does not exist in a Python backend; every task under them was
   * dropped as unbuildable, and re-planning proposes the same work against the
   * same missing directory. Retiring them has to stick.
   */
  describe('a milestone the operator drops', () => {
    it('stops being a hollow milestone asking for a decision', () => {
      milestone('M-fe', 'planned');
      task('T1', 'M-fe', 'dropped', 'not buildable in this repo - no frontend/ directory');
      expect(ledger.hollowMilestones().map((m) => m.id)).toEqual(['M-fe']);

      expect(ledger.dropMilestone('M-fe', 'no frontend in this repo')).toBe('dropped');
      expect(ledger.hollowMilestones()).toEqual([]);
    });

    it('is not picked up by the blanket requeue', () => {
      // The whole point. `dropped` is not live, so without the exclusion it
      // would land in the stuck list and `retry --failed` would revive it.
      milestone('M-fe', 'planned');
      task('T1', 'M-fe', 'dropped', 'no frontend/ directory');
      ledger.dropMilestone('M-fe', 'no frontend in this repo');

      expect(ledger.replanStuckMilestones()).toBe(0);
      expect(ledger.nextUnplannedMilestone()).toBeNull();
    });

    it('stays visible, and keeps the reason it was dropped for', () => {
      milestone('M-fe', 'planned');
      ledger.dropMilestone('M-fe', 'no frontend in this repo');

      const { unplanned, alreadyBuilt, dropped } = ledger.partitionStuck(ledger.stuckMilestones());
      expect(dropped.map((m) => [m.id, m.last_error])).toEqual([
        ['M-fe', 'no frontend in this repo'],
      ]);
      // Nothing warns about it and nothing else claims it.
      expect(unplanned).toEqual([]);
      expect(alreadyBuilt).toEqual([]);
    });

    it('can be brought back by id when the operator changes their mind', () => {
      milestone('M-fe', 'planned');
      ledger.dropMilestone('M-fe', 'no frontend in this repo');

      expect(ledger.replanMilestone('M-fe')).toBe(true);
      expect(ledger.nextUnplannedMilestone()?.id).toBe('M-fe');
    });

    it('refuses while live work still hangs off it, and names it', () => {
      /*
       * Dropping the milestone does not stop its tasks being built. Retiring
       * it anyway would put a dropped milestone on the screen while an agent
       * works through its tasks underneath.
       */
      milestone('M-fe', 'planned');
      task('T1', 'M-fe', 'dropped');
      task('T2', 'M-fe', 'ready');
      expect(ledger.dropMilestone('M-fe')).toEqual({ live: ['T2'] });

      const row = ledger.open().prepare('SELECT status FROM milestones WHERE id=?').get('M-fe') as {
        status: string;
      };
      expect(row.status).toBe('planned');
    });

    it('counts a status no code has written yet as live work', () => {
      // Live by absence, as hollowMilestones counts it: an unknown task status
      // blocks the drop rather than being assumed dead.
      milestone('M-fe', 'planned');
      task('T1', 'M-fe', 'parked-by-some-future-feature');
      expect(ledger.dropMilestone('M-fe')).toEqual({ live: ['T1'] });
    });

    it('reports an id that is no milestone at all', () => {
      expect(ledger.dropMilestone('M-nope')).toBe('not-found');
    });

    it('records why, because that is the only place the reason survives', () => {
      // Counted as a delta: resolutions are not cleared between tests here, and
      // an absolute count would pass or fail on what ran before it.
      const rows = () =>
        ledger
          .open()
          .prepare("SELECT reason FROM resolutions WHERE kind='milestone_dropped'")
          .all() as unknown as { reason: string }[];
      const before = rows().length;

      milestone('M-fe', 'planned');
      ledger.dropMilestone('M-fe', 'dropped for a reason nothing else records');

      const after = rows();
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)!.reason).toContain('dropped for a reason nothing else records');
    });
  });

  it('reports nothing to do for an id that is neither a task nor a replannable milestone', () => {
    expect(ledger.replanMilestone('M-nope')).toBe(false);
  });

  it('does not re-requeue a milestone already waiting in the queue', () => {
    milestone('M-queued', 'unplanned');
    expect(ledger.replanMilestone('M-queued')).toBe(false);
  });

  it('requeues a milestone whose status is missing entirely', () => {
    /*
     * `status <> 'unplanned'` is NULL, not true, for a NULL status - so this
     * reported "nothing to do" for the one milestone least likely to be fine.
     * The operator reads the id off `sa status`, types the retry they were
     * given, and is told the id is not a milestone to replan.
     */
    milestone('M-null', null);
    expect(ledger.replanMilestone('M-null')).toBe(true);
    expect(ledger.nextUnplannedMilestone()?.id).toBe('M-null');
  });

  it('clears the reason it was requeued over, as the blanket requeue does', () => {
    /*
     * The two recovery routes must leave the same state. A reason left behind
     * is quoted back on the next screen for a milestone that is now queued -
     * and for an already-built one that is the brain's own claim, still being
     * shown after the operator overruled it.
     */
    milestone('M-built', ledger.ALREADY_BUILT_STATUS);
    ledger.setMilestoneStatus('M-built', ledger.ALREADY_BUILT_STATUS, 'the brain found no work left');

    expect(ledger.replanMilestone('M-built')).toBe(true);
    const row = ledger
      .open()
      .prepare('SELECT status,last_error FROM milestones WHERE id=?')
      .get('M-built') as { status: string; last_error: string | null };
    expect(row.status).toBe('unplanned');
    expect(row.last_error).toBeNull();
  });

  it('still recovers a milestone the planner gave up on, by id', () => {
    // The per-id route has to cover everything the blanket one does, or the
    // two disagree about what is recoverable.
    milestone('M-failed', 'failed');
    expect(ledger.replanMilestone('M-failed')).toBe(true);
    expect(ledger.nextUnplannedMilestone()?.id).toBe('M-failed');
  });
});

describe('a declared contract change survives the round trip', () => {
  it('comes back off the row exactly as the planner wrote it', () => {
    const what = 'callers that index the response break';
    const ids = ledger.insertTasks(null, 'r1', [task({ title: 'envelope', breaking: what })]);
    expect(ledger.getTask(ids[0]!)!.breaking).toBe(what);
  });

  /*
   * NULL and not ''. Every task planned before this column existed reads as
   * NULL, and a task that declares nothing has to read the same way - the two
   * are the same fact and nothing downstream should be able to tell them apart.
   */
  it('stores nothing as NULL for a task that declares nothing', () => {
    const ids = ledger.insertTasks(null, 'r1', [task({ title: 'ordinary' })]);
    expect(ledger.getTask(ids[0]!)!.breaking).toBeNull();
  });
});

/*
 * Finding AO. Every other suite that touches this mocks the ledger, so the join
 * itself - four tables deep, and the only place a column name can be wrong -
 * runs here or nowhere. It has been wrong before: `why` for `last_error` cost
 * an afternoon on 2026-08-23.
 */
describe('ideaForTask', () => {
  const seed = (body: string, title = 'popularity should not decide') => {
    const idea = ledger.addIdea(title, body, 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'stop weighting by volume', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'drop the retrieval floor', 'detail', 0);
    return ledger.insertTasks(ms, 'r1', [task({ title: 'remove the floor' })])[0] as string;
  };

  it('walks task to milestone to epic to idea and returns what was written', () => {
    const id = seed('I want it to stop deciding by popularity at all.');

    expect(ledger.ideaForTask(id)).toEqual({
      title: 'popularity should not decide',
      body: 'I want it to stop deciding by popularity at all.',
    });
  });

  it('returns the body verbatim, not a summary of it', () => {
    // The whole point of the field. A paraphrase here would be the fifth one in
    // a chain the fix exists to interrupt.
    const body = 'Line one.\n\n  Line two, indented, with "quotes" and a semicolon;';
    expect(ledger.ideaForTask(seed(body))?.body).toBe(body);
  });

  it('returns null for a task that has no milestone', () => {
    // Which is most of them: anything seeded straight into the backlog. Not a
    // degraded state, and not something to log about.
    const id = ledger.insertTasks(null, 'r1', [task()])[0] as string;

    expect(ledger.ideaForTask(id)).toBeNull();
  });

  it('returns null for a task id that does not exist', () => {
    expect(ledger.ideaForTask('T-nope')).toBeNull();
  });

  it('returns null when the idea was recorded with an empty body', () => {
    /*
     * An empty string would render the heading with nothing under it, which
     * reads to an agent as "the operator asked for nothing in particular" -
     * strictly worse than saying it was not recorded.
     */
    expect(ledger.ideaForTask(seed('   \n  '))).toBeNull();
  });

  it('does not confuse two tasks under different ideas', () => {
    // A single JOIN written against the wrong key still passes every test
    // above, because with one idea in the table any row it finds is right.
    const a = seed('the first complaint', 'first');
    const b = seed('the second complaint', 'second');

    expect(ledger.ideaForTask(a)?.body).toBe('the first complaint');
    expect(ledger.ideaForTask(b)?.body).toBe('the second complaint');
  });
});

/*
 * Finding AP, 2026-08-26. `setMilestoneStatus` was reachable with exactly three
 * values - 'planned', 'rejected', 'nothing-to-do' - all three written by the
 * planner. A milestone recorded whether it had been DECOMPOSED and never
 * whether it had been BUILT, so 'planned' was terminal for everything: three
 * tasks committed and three tasks failed left identical rows.
 *
 * Measured over seven from-zero runs before the fix: 18 milestones planned,
 * 20 tasks attempted, 7 committed, 0 milestones ever out of 'planned'.
 *
 * Against a real database on purpose. The whole finding is that four SQL
 * predicates disagreed about what 'live' meant, and a mock cannot disagree.
 */
describe('a milestone reaches an end', () => {
  const build = (n = 1) => {
    const idea = ledger.addIdea('an idea', 'the operator wrote this', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    const ids = ledger.insertTasks(
      ms,
      'r1',
      Array.from({ length: n }, (_, i) => task({ title: `t${i}` })),
    );
    ledger.setMilestoneStatus(ms, 'planned');
    return { ms, ids };
  };

  const statusOf = (id: string) =>
    (
      ledger.open().prepare('SELECT status FROM milestones WHERE id=?').get(id) as {
        status: string | null;
      }
    ).status;

  it('finishes when every task under it committed', () => {
    const { ms, ids } = build(2);
    for (const id of ids) ledger.setStatus(id, 'committed');

    expect(ledger.settleMilestones()).toEqual({ done: [ms], blocked: [] });
    expect(statusOf(ms)).toBe(ledger.MILESTONE_DONE_STATUS);
  });

  it('stops when a task failed, even if another one shipped', () => {
    // Partial delivery is not delivery. Run 22 closed a milestone over a live
    // bug because one of its three tasks committed a test file and the rest
    // never landed; the operator was told the idea was done.
    const { ms, ids } = build(2);
    ledger.setStatus(ids[0]!, 'committed');
    ledger.setStatus(ids[1]!, 'failed', 'gate rejected: DEAD_EXPORT');

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [ms] });
    expect(statusOf(ms)).toBe(ledger.MILESTONE_BLOCKED_STATUS);
  });

  it('carries the failure reasons onto the milestone', () => {
    // The status screen shows milestones, not tasks. "blocked" with no reason
    // attached is the same dead end the finding is about.
    const { ms, ids } = build(1);
    ledger.setStatus(ids[0]!, 'failed', 'gate rejected: TEST_TAMPER');
    ledger.settleMilestones();

    const row = ledger
      .open()
      .prepare('SELECT last_error FROM milestones WHERE id=?')
      .get(ms) as { last_error: string | null };
    expect(row.last_error).toContain('TEST_TAMPER');
  });

  it('leaves a milestone alone while any task is still live', () => {
    const { ms, ids } = build(2);
    ledger.setStatus(ids[0]!, 'committed');

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [] });
    expect(statusOf(ms)).toBe('planned');
  });

  it('counts a task status nobody has written yet as live', () => {
    /*
     * Settled is defined by the absence of a live task rather than by listing
     * dead ones. Listing them is what stranded three milestones in statuses no
     * query matched; holding the milestone open is the safe direction.
     */
    const { ms, ids } = build(1);
    ledger.open().prepare("UPDATE tasks SET status='marinating' WHERE id=?").run(ids[0]!);

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [] });
    expect(statusOf(ms)).toBe('planned');
  });

  it('counts a deadlocked task as settled, and as a failure', () => {
    /*
     * `blocked` is written in one place, markDeadlocked, and means "parked
     * behind a dependency that failed". Nothing but `sa retry --failed` moves
     * it, so treating it as live holds the milestone open for ever - which is
     * this whole finding, one status over. Run 29 hit it: example-ledger's date
     * milestone, the one carrying the operator's actual complaint about banks
     * writing dates the other way round, sat at `planned` behind two parked
     * tasks and no recovery path could see it.
     */
    const { ms, ids } = build(2);
    ledger.setStatus(ids[0]!, 'committed');
    ledger.setStatus(ids[1]!, 'blocked', 'deadlocked behind a failed dependency');

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [ms] });
    expect(statusOf(ms)).toBe(ledger.MILESTONE_BLOCKED_STATUS);
  });

  it('carries the deadlock reason onto the milestone too', () => {
    const { ms, ids } = build(1);
    ledger.setStatus(ids[0]!, 'blocked', 'deadlocked behind a failed dependency');
    ledger.settleMilestones();

    const row = ledger
      .open()
      .prepare('SELECT last_error FROM milestones WHERE id=?')
      .get(ms) as { last_error: string | null };
    expect(row.last_error).toContain('deadlocked');
  });

  it('does not count a handoff as settled', () => {
    /*
     * A task waiting on the operator is outstanding work, not finished work.
     *
     * The sibling has to have COMMITTED for this to test anything. Written with
     * a lone handoff task the milestone has nothing committed and nothing
     * failed, so it lands in the all-dropped branch and is left alone whether
     * handoff counts as settled or not - the assertion passed with handoff
     * moved into the settled set. Found by mutation (N4), not by the suite.
     */
    const { ms, ids } = build(2);
    ledger.setStatus(ids[0]!, 'committed');
    ledger.setStatus(ids[1]!, 'handoff');

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [] });
    expect(statusOf(ms)).toBe('planned');
  });

  it('leaves an all-dropped milestone to hollowMilestones', () => {
    /*
     * Dropped means "gone", not "gone wrong", and the two reasons a task gets
     * dropped - the work already existed, or the plan was defective - want
     * opposite decisions. hollowMilestones prints those reasons; this would
     * flatten them into one status.
     */
    const { ms, ids } = build(1);
    ledger.setStatus(ids[0]!, 'dropped');

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [] });
    expect(statusOf(ms)).toBe('planned');
    expect(ledger.hollowMilestones().map((m) => m.id)).toContain(ms);
  });

  it('leaves a milestone that was never given any tasks', () => {
    // Also hollowMilestones' case, and the one it was written for.
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'empty', 'detail', 0);
    ledger.setMilestoneStatus(ms, 'planned');

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [] });
    expect(statusOf(ms)).toBe('planned');
  });

  it('is idempotent — a second sweep finds nothing left to settle', () => {
    const { ms, ids } = build(1);
    ledger.setStatus(ids[0]!, 'committed');
    ledger.settleMilestones();

    expect(ledger.settleMilestones()).toEqual({ done: [], blocked: [] });
    expect(statusOf(ms)).toBe(ledger.MILESTONE_DONE_STATUS);
  });
});

/*
 * The half of finding AP that made it invisible rather than merely unrecorded.
 * 'planned' is LIVE, and live is excluded from stuckMilestones, partitionStuck
 * and replanStuckMilestones alike - so a milestone whose tasks all failed could
 * not be seen by the planner, by `sa status` or by `sa retry --failed`, all
 * three at once, while the run reported an empty backlog.
 */
describe('a stopped milestone can be seen and asked about again', () => {
  const blocked = () => {
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    const ids = ledger.insertTasks(ms, 'r1', [task({ title: 'only task' })]);
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(ids[0]!, 'failed', 'gate rejected: DEAD_EXPORT');
    ledger.settleMilestones();
    return { ms, taskId: ids[0]! };
  };

  it('shows up on the status screen instead of nowhere', () => {
    const { ms } = blocked();
    expect(ledger.stuckMilestones().map((m) => m.id)).toContain(ms);
  });

  it('is filed as stopped, not as "planned to nothing"', () => {
    // It fell into the unplanned bucket before it had a name, under a heading
    // reading "no task was ever queued for them" - the opposite of what
    // happened to it.
    const { ms } = blocked();
    const p = ledger.partitionStuck(ledger.stuckMilestones());

    expect(p.blocked.map((m) => m.id)).toEqual([ms]);
    expect(p.unplanned.map((m) => m.id)).not.toContain(ms);
  });

  it('is something the operator can requeue', () => {
    const { ms } = blocked();
    expect(ledger.replanStuckMilestones()).toBe(1);
  });

  it('but a finished one is not, so nothing re-asks a settled question', () => {
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    const ids = ledger.insertTasks(ms, 'r1', [task()]);
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(ids[0]!, 'committed');
    ledger.settleMilestones();

    expect(ledger.replanStuckMilestones()).toBe(0);
    const p = ledger.partitionStuck(ledger.stuckMilestones());
    expect(p.done.map((m) => m.id)).toEqual([ms]);
    expect(p.unplanned).toEqual([]);
  });

  it('still files a status nobody has written yet as unplanned', () => {
    // The property that must survive every new bucket: the default catches
    // what nobody named, because naming them is what lost one for eight days.
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    ledger.setMilestoneStatus(ms, 'marinating');

    expect(ledger.partitionStuck(ledger.stuckMilestones()).unplanned.map((m) => m.id)).toEqual([ms]);
  });
});

/*
 * And the half that decides whether an UNATTENDED run recovers. Without this a
 * blocked milestone waits for a person to read a screen, which is exactly what
 * "runs by itself" cannot mean.
 */
describe('a stopped milestone gets one more chance without being asked', () => {
  const blocked = (n = 1) => {
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    const ids = ledger.insertTasks(
      ms,
      'r1',
      Array.from({ length: n }, (_, i) => task({ title: `t${i}` })),
    );
    ledger.setMilestoneStatus(ms, 'planned');
    for (const id of ids) ledger.setStatus(id, 'failed', 'gate rejected');
    ledger.settleMilestones();
    return { ms, ids };
  };

  const statusOf = (id: string) =>
    (
      ledger.open().prepare('SELECT status FROM milestones WHERE id=?').get(id) as {
        status: string | null;
      }
    ).status;

  it('puts it back in the planning queue', () => {
    const { ms } = blocked();

    expect(ledger.autoReplanBlocked()).toEqual([ms]);
    expect(statusOf(ms)).toBe('unplanned');
    expect(ledger.nextUnplannedMilestone()?.id).toBe(ms);
  });

  it('keeps trying, and still stops eventually', () => {
    /*
     * The bound was one until 2026-08-28, justified as "a second is how quota
     * disappears overnight". The operator withdrew that: the system is to
     * finish the work whatever it costs, and one re-plan was measurably not
     * enough — it is the point at which a milestone stopped and waited for a
     * person, which is the failure this mechanism exists to prevent.
     *
     * It is still bounded, and not for cost. A milestone decomposed this many
     * different ways and failed every time is telling us it cannot be built
     * here, and a run that never stops delivers nothing either.
     *
     * Asserted against the constant rather than a number, so raising the bound
     * cannot quietly leave this test describing the old one.
     */
    const { ms } = blocked();

    for (let i = 0; i < ledger.MILESTONE_AUTO_REPLANS; i++) {
      expect(ledger.autoReplanBlocked(), `replan ${i + 1}`).toEqual([ms]);
      ledger.setMilestoneStatus(ms, 'planned');
      const ids = ledger.insertTasks(ms, 'r1', [task({ title: `try ${i + 2}` })]);
      ledger.setStatus(ids[0]!, 'failed', 'gate rejected again');
      ledger.settleMilestones();
    }

    expect(ledger.autoReplanBlocked()).toEqual([]);
    expect(statusOf(ms)).toBe(ledger.MILESTONE_BLOCKED_STATUS);
  });

  it('supersedes a deadlocked task as well as a failed one', () => {
    // Otherwise the parked task survives the requeue and settles the milestone
    // straight back to blocked the moment the replacement work lands.
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    const ids = ledger.insertTasks(ms, 'r1', [task({ title: 'a' }), task({ title: 'b' })]);
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(ids[0]!, 'failed', 'gate rejected');
    ledger.setStatus(ids[1]!, 'blocked', 'deadlocked behind a failed dependency');
    ledger.settleMilestones();

    ledger.autoReplanBlocked();

    expect(ledger.getTask(ids[0]!)?.status).toBe('dropped');
    expect(ledger.getTask(ids[1]!)?.status).toBe('dropped');
  });

  it('supersedes the failed tasks, so the milestone can finish next time', () => {
    /*
     * Without this the old failures settle it straight back to blocked the
     * moment the new tasks land - a milestone that can never reach `done`
     * again, which is the same bug one layer up.
     */
    const { ms, ids } = blocked();
    ledger.autoReplanBlocked();

    expect(ledger.getTask(ids[0]!)?.status).toBe('dropped');

    ledger.setMilestoneStatus(ms, 'planned');
    const fresh = ledger.insertTasks(ms, 'r1', [task({ title: 'the replan' })]);
    ledger.setStatus(fresh[0]!, 'committed');

    expect(ledger.settleMilestones()).toEqual({ done: [ms], blocked: [] });
  });

  it('says why the old tasks went, rather than deleting them', () => {
    const { ids } = blocked();
    ledger.autoReplanBlocked();

    expect(ledger.getTask(ids[0]!)?.last_error).toContain('superseded');
  });

  it('leaves a finished milestone where it is', () => {
    const idea = ledger.addIdea('an idea', 'body', 'r1');
    const epic = ledger.addEpic(idea, 'r1', 'an epic', 'summary', 0);
    const ms = ledger.addMilestone(epic, 'r1', 'a milestone', 'detail', 0);
    const ids = ledger.insertTasks(ms, 'r1', [task()]);
    ledger.setMilestoneStatus(ms, 'planned');
    ledger.setStatus(ids[0]!, 'committed');
    ledger.settleMilestones();

    expect(ledger.autoReplanBlocked()).toEqual([]);
    expect(statusOf(ms)).toBe(ledger.MILESTONE_DONE_STATUS);
  });
});
