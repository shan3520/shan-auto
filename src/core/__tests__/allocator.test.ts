import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { selectBatch } from '../allocator.js';
import { runwayDays } from '../planner.js';
import * as ledger from '../../ledger.js';
import type { AppConfig } from '../../config.js';
import type { TaskRow } from '../../schemas.js';

describe('allocator', () => {
  beforeEach(() => {
    process.env.SHANAUTO_DB = ':memory:';
  });

  afterEach(() => {
    ledger.closeForTest();
    vi.restoreAllMocks();
  });

  it('imports selectBatch', () => {
    expect(typeof selectBatch).toBe('function');
  });

  it('imports runwayDays', () => {
    expect(typeof runwayDays).toBe('function');
  });

  it('handles empty repository list gracefully', () => {
    const config = {
      repos: [],
      system: {
        max_daily_commits: 5,
        daily_target: 2,
        overselect: 1,
      },
    } as unknown as AppConfig;
    const batch = selectBatch(config);
    expect(batch).toEqual([]);
  });

  it('rejects assignments exceeding daily ceilings', () => {
    const config = {
      repos: [{ id: 'repo1', weight: 1 }],
      system: {
        max_daily_commits: 5,
        daily_target: 2,
        overselect: 1,
      },
    } as unknown as AppConfig;

    // Mock ledger to simulate having already reached the max_daily_commits ceiling
    vi.spyOn(ledger, 'committedToday').mockReturnValue(5);
    // Mock ready tasks to ensure we have pending tasks to potentially select
    vi.spyOn(ledger, 'readyTasks').mockReturnValue([{ id: 'mock-task' }] as any);

    const batch = selectBatch(config);
    expect(batch).toEqual([]);
  });

  it('hits exactly the daily limit', () => {
    const config = {
      repos: [{ id: 'repo1', weight: 1 }],
      system: {
        max_daily_commits: 5,
        daily_target: 2,
        overselect: 1,
      },
    } as unknown as AppConfig;

    // Mock ledger to simulate having 4 commits already, leaving room for exactly 1 more before hitting the limit of 5
    vi.spyOn(ledger, 'committedToday').mockReturnValue(4);
    // Provide two ready tasks, but only one should be selected due to the ceiling limit
    vi.spyOn(ledger, 'readyTasks').mockReturnValue([{ id: 'task1' }, { id: 'task2' }] as any);

    const batch = selectBatch(config);
    expect(batch.length).toBe(1);
    expect(batch[0]!.id).toBe('task1');
  });
});

/**
 * The 2026-08-08 incident: shanauto (weight 1) and example-api (weight 3) were both
 * ready, and example-api took all 16 of the day's commits. Weight only shuffled the
 * draw order, so a repo with a deep backlog was simply asked again every time
 * runBatch's refill drained the queue.
 */
describe('allocator: per-repo daily share', () => {
  const task = (id: string, repo: string) => ({ id, repo }) as unknown as TaskRow;

  /** n ready tasks for `repo`, ids prefixed so the owner is readable in a failure. */
  const ready = (repo: string, n: number) =>
    Array.from({ length: n }, (_, i) => task(`${repo}-${i + 1}`, repo));

  /** Each repo gets its OWN array: selectBatch shifts the queues it is handed. */
  function stubLedger(committed: Record<string, number>, available: Record<string, number>) {
    const queues = new Map<string, TaskRow[]>(
      Object.entries(available).map(([repo, n]) => [repo, ready(repo, n)]),
    );
    vi.spyOn(ledger, 'readyTasks').mockImplementation((repo?: string) =>
      repo ? (queues.get(repo) ?? []) : [...queues.values()].flat(),
    );
    vi.spyOn(ledger, 'committedTodayByRepo').mockReturnValue(committed);
    vi.spyOn(ledger, 'committedToday').mockReturnValue(
      Object.values(committed).reduce((a, b) => a + b, 0),
    );
  }

  const count = (batch: TaskRow[], repo: string) => batch.filter((t) => t.repo === repo).length;

  const twoRepos = {
    repos: [
      { id: 'shanauto', weight: 1 },
      { id: 'example-api', weight: 3 },
    ],
    system: { max_daily_commits: 16, daily_target: 10, overselect: 6 },
  } as unknown as AppConfig;

  beforeEach(() => {
    process.env.SHANAUTO_DB = ':memory:';
  });

  afterEach(() => {
    ledger.closeForTest();
    vi.restoreAllMocks();
  });

  it('leaves the rest of the day to the other repo once a repo has spent its share', () => {
    // example-api's share of a 16 ceiling at weight 3 of 4 is 12, and it has taken
    // all 12. The remaining 4 belong to shanauto, which has work ready.
    stubLedger({ 'example-api': 12 }, { shanauto: 20, 'example-api': 40 });

    const batch = selectBatch(twoRepos);

    expect(batch.length).toBe(4);
    expect(count(batch, 'shanauto')).toBe(4);
    expect(count(batch, 'example-api')).toBe(0);
  });

  it('keeps a share for the lighter repo when the heavier one has already eaten half the day', () => {
    stubLedger({ 'example-api': 8 }, { shanauto: 20, 'example-api': 40 });

    const batch = selectBatch(twoRepos);

    // 8 left under the ceiling; example-api has 4 of its 12 unspent, shanauto all 4.
    // A pure draw order would have handed example-api 6 of these 8.
    expect(batch.length).toBe(8);
    expect(count(batch, 'shanauto')).toBe(4);
    expect(count(batch, 'example-api')).toBe(4);
  });

  it('never selects past the global ceiling even though the shares sum above it', () => {
    // Three repos at weight 1 each round up to 4 of a 10 ceiling: 12 in total.
    // The ceiling is the outer bound and no arrangement of shares may lift it.
    const cfg = {
      repos: [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
      ],
      system: { max_daily_commits: 10, daily_target: 30, overselect: 6 },
    } as unknown as AppConfig;
    stubLedger({}, { a: 20, b: 20, c: 20 });

    expect(selectBatch(cfg).length).toBe(10);

    vi.restoreAllMocks();
    stubLedger({ a: 7 }, { a: 20, b: 20, c: 20 });
    expect(selectBatch(cfg).length).toBe(3);

    vi.restoreAllMocks();
    stubLedger({ a: 4, b: 4, c: 2 }, { a: 20, b: 20, c: 20 });
    expect(selectBatch(cfg)).toEqual([]);
  });

  it('spends the remainder on whoever has work when the entitled repo has none', () => {
    // example-api is at its share of 12 and shanauto has nothing ready. The last 4
    // commits of the day go to example-api rather than the run stopping early —
    // an idle queue is how runBatch's refill loop ends the day.
    stubLedger({ 'example-api': 12 }, { 'example-api': 40 });

    const batch = selectBatch(twoRepos);

    expect(batch.length).toBe(4);
    expect(count(batch, 'example-api')).toBe(4);
  });

  it('still returns work when every repo has spent its share but the ceiling has room', () => {
    /*
     * The deadlock guard. runBatch ends the day when a refill yields nothing, so
     * a share that can block selection outright would stop a run with most of the
     * ceiling unspent — the 2026-08-06 freeze reached from a new direction. Shares
     * ration who goes first; only the ceiling may actually stop the day.
     */
    const cfg = {
      repos: [
        { id: 'shanauto', weight: 1, max_daily_commits: 2 },
        { id: 'example-api', weight: 3, max_daily_commits: 2 },
      ],
      system: { max_daily_commits: 16, daily_target: 10, overselect: 6 },
    } as unknown as AppConfig;
    stubLedger({ shanauto: 2, 'example-api': 2 }, { shanauto: 20, 'example-api': 40 });

    const batch = selectBatch(cfg);

    // 4 committed against a 16 ceiling leaves 12, and all 12 get selected.
    expect(batch.length).toBe(12);
  });

  it('gives a single repo the whole ceiling, exactly as before shares existed', () => {
    const cfg = {
      repos: [{ id: 'solo', weight: 1 }],
      system: { max_daily_commits: 12, daily_target: 12, overselect: 6 },
    } as unknown as AppConfig;
    stubLedger({}, { solo: 40 });

    expect(selectBatch(cfg).length).toBe(12);

    // Weight is relative, so the only repo holds all of it whatever the number.
    vi.restoreAllMocks();
    stubLedger({ solo: 5 }, { solo: 40 });
    const heavy = { ...cfg, repos: [{ id: 'solo', weight: 7 }] } as unknown as AppConfig;
    expect(selectBatch(heavy).length).toBe(7);
  });

  it('honours an explicit max_daily_commits over the weight-derived share', () => {
    // Equal weights would split a 16 ceiling 8/8, and an equal draw order would
    // split a 10-task target 5/5. The override pins shanauto to 2 regardless.
    const cfg = {
      repos: [
        { id: 'shanauto', weight: 3, max_daily_commits: 2 },
        { id: 'example-api', weight: 3 },
      ],
      system: { max_daily_commits: 16, daily_target: 10, overselect: 0 },
    } as unknown as AppConfig;
    stubLedger({}, { shanauto: 20, 'example-api': 40 });

    const batch = selectBatch(cfg);

    expect(count(batch, 'shanauto')).toBe(2);
    expect(count(batch, 'example-api')).toBe(8);
  });
});
