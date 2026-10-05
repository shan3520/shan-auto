import { describe, it, expect } from 'vitest';
import { holdBlockedWork, isRepairTask, repairTitle, REPAIR_TITLE_PREFIX } from '../repair.js';
import type { Repo, TaskRow } from '../../schemas.js';

/**
 * The deadlock a strict gate creates on a broken project.
 *
 * Traced end to end on 2026-08-09 against the real example-api repo. The suite was
 * red in three independent places, and the planner did the sensible thing: one
 * task per failing test. No task could ever land.
 *
 *   baseline                     3 failures
 *   after "fix relationships"    1 failure   <- the agent fixed two of them
 *   REJECTED, rolled back
 *   after "add cascade deletes"  1 failure   <- fixed two again
 *   REJECTED, rolled back
 *   final state                  2 failures
 *
 * Each change genuinely reduced the failures. Each was correctly rejected,
 * because the gate wants the WHOLE check green. They blocked one another
 * permanently, and would have spent the same quota every day forever.
 *
 * The fix is not a weaker gate. It is that "fix one of the three failures" is
 * the wrong unit of work when the check is all-or-nothing.
 */

const task = (over: Partial<TaskRow> = {}): TaskRow =>
  ({ id: 'T1', repo: 'example-api', title: 'Add a login page', status: 'ready', ...over }) as TaskRow;

describe('a repair task is recognisable across runs', () => {
  it('names the repo, so two broken projects do not share one job', () => {
    const a = repairTitle({ id: 'example-api' } as Repo);
    const b = repairTitle({ id: 'other' } as Repo);
    expect(a).not.toBe(b);
    expect(a).toContain('example-api');
  });

  it('is identified by its title, which is how a second run avoids stacking copies', () => {
    expect(isRepairTask(task({ title: repairTitle({ id: 'example-api' } as Repo) }))).toBe(true);
    expect(isRepairTask(task())).toBe(false);
  });

  it('the prefix is stable — changing it would orphan every queued repair', () => {
    expect(repairTitle({ id: 'x' } as Repo).startsWith(REPAIR_TITLE_PREFIX)).toBe(true);
  });
});

describe('work that cannot possibly pass is not dispatched', () => {
  /*
   * The damage was not the rejection — that was correct — it was spending an
   * agent request per task to discover something already known. Four dispatches
   * and four brain calls in one run, for nothing.
   */
  const red = new Set(['example-api']);

  it('holds ordinary work on a red project', () => {
    const { runnable, held } = holdBlockedWork([task({ id: 'A' }), task({ id: 'B' })], red);
    expect(runnable).toHaveLength(0);
    expect(held.map((t) => t.id)).toEqual(['A', 'B']);
  });

  it('lets the repair task itself through — it is the way out', () => {
    const repair = task({ id: 'R', title: repairTitle({ id: 'example-api' } as Repo) });
    const { runnable, held } = holdBlockedWork([task({ id: 'A' }), repair], red);
    expect(runnable.map((t) => t.id)).toEqual(['R']);
    expect(held.map((t) => t.id)).toEqual(['A']);
  });

  it('does not hold work on a project that is perfectly healthy', () => {
    const other = task({ id: 'C', repo: 'healthy' });
    const { runnable, held } = holdBlockedWork([other], red);
    expect(runnable).toHaveLength(1);
    expect(held).toHaveLength(0);
  });

  it('holds nothing at all when every project is green', () => {
    const batch = [task({ id: 'A' }), task({ id: 'B', repo: 'other' })];
    const { runnable, held } = holdBlockedWork(batch, new Set());
    expect(runnable).toHaveLength(2);
    expect(held).toHaveLength(0);
  });

  it('keeps the batch order, so priority is not quietly reshuffled', () => {
    const batch = [task({ id: 'A', repo: 'healthy' }), task({ id: 'B', repo: 'healthy' })];
    expect(holdBlockedWork(batch, red).runnable.map((t) => t.id)).toEqual(['A', 'B']);
  });
});
