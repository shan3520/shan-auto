import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../config.js';
import type { Repo } from '../../schemas.js';

/*
 * A repair job that fails takes its whole project down with it, 2026-08-30.
 *
 * The gate is absolute: nothing is committed to a project whose own check is
 * failing. When one goes red, `ensureRepairTask` queues a single job to fix it
 * and `holdBlockedWork` holds everything else until it lands. That is right.
 *
 * What nobody had traced is what happens when the repair job itself fails.
 *
 *   run 1  repo red -> repair job queued -> dispatched -> fails -> 'failed'
 *   run 2  repo still red -> ensureRepairTask finds it -> "already queued"
 *          -> selectBatch only takes 'ready' -> nothing is dispatched
 *          -> every other job in that project is held
 *   run 3  the same
 *   ...
 *
 * The project is parked for ever. `openTasksByRepo` treats 'failed' as open —
 * reasonably, it means "not finished" — so the existence check is satisfied by
 * a task that can never run again. And the usual recovery cannot reach it: a
 * repair task is inserted with a NULL milestone, so `settleMilestones` (which
 * joins milestones) never sees it and `autoReplanBlocked` never revives it.
 *
 * Nothing in the system fixes this. The only way out is a person typing
 * `npm run sa -- retry --failed`, which is the failure mode this whole line of
 * work exists to remove: a real failure the operator has to notice and repair
 * by hand, on a screen that does not even say so.
 */

const cfg = { system: { timeouts: { verify_s: 30 } } } as unknown as AppConfig;

let dir: string;
let ledger: typeof import('../../ledger.js');
let ensureRepairTask: typeof import('../repair.js').ensureRepairTask;
let repairTitle: typeof import('../repair.js').repairTitle;

const repo = (over: Partial<Repo> = {}): Repo =>
  ({ id: 'example-api', path: 'D:/nowhere', branch: 'main', verify_cmd: 'pytest -q', ...over }) as Repo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sa-repair-'));
  process.env.SHANAUTO_DB = join(dir, 'l.db');
  vi.resetModules();
  ledger = await import('../../ledger.js');
  ({ ensureRepairTask, repairTitle } = await import('../repair.js'));
});

afterEach(() => {
  ledger.closeForTest();
  delete process.env.SHANAUTO_DB;
  // Windows will not unlink a file the sqlite handle still holds; the temp
  // directory is the OS's to sweep if this ever loses the race.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** The repair job for this repo, whatever state it is in. */
const repairRow = (r: Repo) =>
  ledger
    .open()
    .prepare('SELECT * FROM tasks WHERE repo=? AND title=?')
    .get(r.id, repairTitle(r)) as unknown as { id: string; status: string; attempts: number };

describe('a repair job that failed last run', () => {
  it('is queued once, not stacked, while it is still runnable', async () => {
    // The existing promise, and the reason the check is there at all.
    const r = repo();
    const first = await ensureRepairTask(cfg, r, 'two tests red');
    const second = await ensureRepairTask(cfg, r, 'two tests red');

    expect(second.taskId).toBe(first.taskId);
    const all = ledger.open().prepare('SELECT id FROM tasks WHERE repo=?').all(r.id);
    expect(all).toHaveLength(1);
  });

  it('is put back in the queue, instead of parking the project for ever', async () => {
    const r = repo();
    const { taskId } = await ensureRepairTask(cfg, r, 'two tests red');

    // It ran and it failed. This is the state every later run inherits.
    ledger.setStatus(taskId, 'failed', 'VERIFY_FAIL: still two tests red');
    expect(repairRow(r).status).toBe('failed');

    // The next run. The project is still red, so it asks for a repair job again.
    const again = await ensureRepairTask(cfg, r, 'two tests red');

    // Same job — stacking a second copy would be the other bug.
    expect(again.taskId).toBe(taskId);
    /*
     * And runnable. Without this the answer is "already queued" about a task
     * that selectBatch cannot pick, so the run dispatches nothing, holds every
     * other job in the project, and does the same tomorrow.
     */
    expect(repairRow(r).status).toBe('ready');
  });

  it('gives it its attempts back, so it is not stopped before it starts', async () => {
    const r = repo();
    const { taskId } = await ensureRepairTask(cfg, r, 'red');
    ledger.open().prepare('UPDATE tasks SET attempts=9 WHERE id=?').run(taskId);
    ledger.setStatus(taskId, 'failed', 'VERIFY_FAIL');

    await ensureRepairTask(cfg, r, 'red');

    expect(repairRow(r).attempts).toBe(0);
  });

  it('revives one parked by a permission refusal too', async () => {
    /*
     * `blocked` is the same dead end by a different route: the agent was
     * refused a tool, wrote nothing, and the project is just as parked.
     */
    const r = repo();
    const { taskId } = await ensureRepairTask(cfg, r, 'red');
    ledger.setStatus(taskId, 'blocked', 'BLOCKED: denied the tool permission `pytest`');

    await ensureRepairTask(cfg, r, 'red');

    expect(repairRow(r).status).toBe('ready');
  });

  it('leaves a repair job that is mid-flight alone', async () => {
    // Reviving a running task would hand the same work to a second agent.
    const r = repo();
    const { taskId } = await ensureRepairTask(cfg, r, 'red');
    ledger.setStatus(taskId, 'running');

    await ensureRepairTask(cfg, r, 'red');

    expect(repairRow(r).status).toBe('running');
  });

  it('keeps each project to its own repair job', async () => {
    // Two red projects must not revive or share one another's.
    const a = repo({ id: 'example-api' });
    const b = repo({ id: 'example-receipts' });
    const ra = await ensureRepairTask(cfg, a, 'red');
    await ensureRepairTask(cfg, b, 'red');
    ledger.setStatus(ra.taskId, 'failed', 'VERIFY_FAIL');

    await ensureRepairTask(cfg, a, 'red');

    expect(repairRow(a).status).toBe('ready');
    expect(repairRow(b).status).toBe('ready');
    expect(repairRow(a).id).not.toBe(repairRow(b).id);
  });
});
