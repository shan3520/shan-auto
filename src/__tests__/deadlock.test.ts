import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capDependencyDepth } from '../core/planner.js';
import type { NormalizedTask } from '../schemas.js';

const dir = mkdtempSync(join(tmpdir(), 'sa-deadlock-'));
process.env.SHANAUTO_DB = join(dir, 'test.db');
const ledger = await import('../ledger.js');

function task(title: string, depends_on: number[] = []): NormalizedTask {
  return {
    title,
    kind: 'feature',
    instruction: 'do the thing',
    acceptance: 'done',
    files_hint: [],
    verify_cmd: 'echo ok',
    depends_on,
    est_lines: 10,
    executor_hint: 'cli',
  };
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM tasks;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The 2026-08-06 failure mode: 8 failed tasks froze 38 of 59 queued tasks for
 * good, while runwayDays counted all 59 and reported 3 days of work remaining.
 */
describe('deadlock detection', () => {
  it('finds tasks blocked directly by a failed dependency', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    ledger.setStatus(ids[0]!, 'failed');
    expect([...ledger.deadlockedTaskIds()]).toEqual([ids[1]]);
  });

  it('follows the chain transitively, not just one level', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task('root'),
      task('mid', [0]),
      task('leaf', [1]),
      task('unrelated'),
    ]);
    ledger.setStatus(ids[0]!, 'failed');
    const dead = ledger.deadlockedTaskIds();
    expect(dead.has(ids[1]!)).toBe(true);
    expect(dead.has(ids[2]!)).toBe(true); // two levels down
    expect(dead.has(ids[3]!)).toBe(false);
  });

  /**
   * 'dropped' means an agent found the work already in place. The prerequisite is
   * met, so dependents must be freed — treating it as fatal parked whole chains
   * behind a requirement that was actually satisfied.
   */
  it('treats a DROPPED dependency as satisfied, not fatal', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    ledger.setStatus(ids[0]!, 'dropped');
    expect(ledger.deadlockedTaskIds().has(ids[1]!)).toBe(false);
  });

  it('unblocks a dependent once its dependency is dropped', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    expect(ledger.getTask(ids[1]!)!.status).toBe('pending');
    ledger.dropTask(ids[0]!, 'already there');
    expect(ledger.getTask(ids[1]!)!.status).toBe('ready');
  });

  it('dropTask frees a chain that was deadlocked by a failure', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    ledger.setStatus(ids[0]!, 'failed');
    ledger.markDeadlocked();
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');

    ledger.dropTask(ids[0]!, 'work already exists');
    expect(ledger.getTask(ids[1]!)!.status).toBe('ready');
    expect(ledger.deadlockedTaskIds().size).toBe(0);
  });

  it('will not drop a committed task', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('done')]);
    ledger.markCommitted(ids[0]!, 'sha');
    expect(ledger.dropTask(ids[0]!)).toBe(false);
  });

  it('does not flag a chain that is merely waiting', () => {
    ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    expect(ledger.deadlockedTaskIds().size).toBe(0);
  });

  it('excludes deadlocked work from the reachable backlog', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0]), task('free')]);
    ledger.setStatus(ids[0]!, 'failed');
    // 'child' is dead, 'free' is ready -> 1 reachable
    expect(ledger.reachableBacklog()).toBe(1);
  });

  it('parks deadlocked tasks as blocked', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    ledger.setStatus(ids[0]!, 'failed');
    expect(ledger.markDeadlocked()).toBe(1);
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');
  });
});

describe('retry', () => {
  it('revives a failed task and unblocks the chain behind it', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('root'), task('child', [0])]);
    ledger.setStatus(ids[0]!, 'failed');
    ledger.markDeadlocked();
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');

    expect(ledger.retryTask(ids[0]!)).toBe(true);
    expect(ledger.getTask(ids[0]!)!.status).toBe('ready');
    expect(ledger.getTask(ids[1]!)!.status).toBe('pending'); // waiting again, not dead
    expect(ledger.deadlockedTaskIds().size).toBe(0);
  });

  it('resets the attempt counter so the task gets a real second chance', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('solo')]);
    ledger.bumpAttempt(ids[0]!);
    ledger.bumpAttempt(ids[0]!);
    ledger.setStatus(ids[0]!, 'failed');
    ledger.retryTask(ids[0]!);
    expect(ledger.getTask(ids[0]!)!.attempts).toBe(0);
  });

  it('refuses to touch a committed task', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('done')]);
    ledger.markCommitted(ids[0]!, 'sha');
    expect(ledger.retryTask(ids[0]!)).toBe(false);
    expect(ledger.getTask(ids[0]!)!.status).toBe('committed');
  });

  it('--failed revives every failure at once', () => {
    const ids = ledger.insertTasks(null, 'r1', [task('a'), task('b'), task('c')]);
    ledger.setStatus(ids[0]!, 'failed');
    ledger.setStatus(ids[1]!, 'failed');
    expect(ledger.retryAllFailed()).toBe(2);
    expect(ledger.getTask(ids[0]!)!.status).toBe('ready');
  });

  /**
   * F12 regression: the old blanket revive (`UPDATE ... WHERE status='blocked'`)
   * un-parked EVERY blocked task when one was retried — including chains parked
   * behind a different failed ancestor, which the gate then re-rejected. Only
   * tasks whose dependency closure contains the retried task may be revived.
   */
  it('does not revive a blocked task parked behind a different failure', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task('root'),
      task('child', [0]), // parked behind root
      task('other-fail'),
      task('other-child', [2]), // parked behind other-fail, NOT behind root
    ]);
    ledger.setStatus(ids[0]!, 'failed');
    ledger.setStatus(ids[2]!, 'failed');
    ledger.markDeadlocked();
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');
    expect(ledger.getTask(ids[3]!)!.status).toBe('blocked');

    ledger.retryTask(ids[0]!);
    expect(ledger.getTask(ids[1]!)!.status).toBe('pending'); // freed
    expect(ledger.getTask(ids[3]!)!.status).toBe('blocked'); // still parked
  });

  /**
   * F12, the closure side: reviving the root must free the WHOLE dependency
   * chain behind it — mid AND leaf, two and three levels down — while a chain
   * parked behind a different failure stays parked.
   */
  it('revives the whole dependency closure, not just direct children', () => {
    const ids = ledger.insertTasks(null, 'r1', [
      task('root'),
      task('mid', [0]),
      task('leaf', [1]),
      task('other-fail'),
      task('other-child', [3]),
    ]);
    ledger.setStatus(ids[0]!, 'failed');
    ledger.setStatus(ids[3]!, 'failed');
    ledger.markDeadlocked();
    expect(ledger.getTask(ids[1]!)!.status).toBe('blocked');
    expect(ledger.getTask(ids[2]!)!.status).toBe('blocked');
    expect(ledger.getTask(ids[4]!)!.status).toBe('blocked');

    ledger.retryTask(ids[0]!);
    expect(ledger.getTask(ids[1]!)!.status).toBe('pending'); // two levels down
    expect(ledger.getTask(ids[2]!)!.status).toBe('pending'); // three levels down
    expect(ledger.getTask(ids[4]!)!.status).toBe('blocked'); // still parked elsewhere
    // deadlockedTaskIds only reports tasks still 'pending'; the other chain is
    // already parked as 'blocked' and stays there, so nothing is newly dead.
    expect(ledger.deadlockedTaskIds().size).toBe(0);
  });
});

describe('capDependencyDepth', () => {
  it('keeps shallow chains intact', () => {
    const capped = capDependencyDepth([task('a'), task('b', [0]), task('c', [1])]);
    expect(capped[1]!.depends_on).toEqual([0]);
    expect(capped[2]!.depends_on).toEqual([1]);
  });

  it('cuts a chain deeper than the cap', () => {
    const capped = capDependencyDepth([
      task('a'),
      task('b', [0]),
      task('c', [1]),
      task('d', [2]), // depth 3
    ]);
    expect(capped[3]!.depends_on).toEqual([]);
  });

  it('leaves independent tasks untouched', () => {
    const capped = capDependencyDepth([task('a'), task('b'), task('c')]);
    expect(capped.every((t) => t.depends_on.length === 0)).toBe(true);
  });

  it('survives a self-referential cycle without hanging', () => {
    const weird = [task('a'), task('b', [0])];
    weird[0]!.depends_on = [1]; // forward ref, ignored by depth()
    expect(() => capDependencyDepth(weird)).not.toThrow();
  });
});
