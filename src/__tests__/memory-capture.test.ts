import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedTask } from '../schemas.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-capture-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');

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

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM tasks; DELETE FROM task_claims;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * A commit records what changed. The questions worth asking a year later — why
 * something was abandoned, what broke, what was decided — are not in any commit,
 * so they have to be captured deliberately.
 */
describe('what gets remembered', () => {
  it('records why a task was dropped, not merely that it was', () => {
    const id = ledger.insertTasks(null, 'r1', [task('Add CSS_TEMPLATE constant')])[0]!;
    ledger.dropTask(id, 'declaration-only, no consumer');

    const m = ledger.recentResolutions('r1').find((x) => x.kind === 'task_dropped')!;
    expect(m.reason).toContain('CSS_TEMPLATE');
    expect(m.reason).toContain('no consumer');
    expect(m.task_id).toBe(id);
  });

  it('accepts a hand-written memory for things it could not observe', () => {
    ledger.remember({
      repo: 'r1',
      kind: 'incident',
      reason: 'agy deleted files outside the repo; shell access revoked',
    });
    const hits = ledger.searchResolutions('r1', 'agy shell');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('incident');
  });

  it('supports every declared kind', () => {
    const kinds = [
      'shanauto_commit',
      'external_commit',
      'manual_park',
      'already_done',
      'gate_rejection',
      'task_failed',
      'task_dropped',
      'config_change',
      'decision',
      'incident',
    ] as const;
    for (const kind of kinds) ledger.remember({ repo: 'r1', kind, reason: `a ${kind} happened` });
    expect(new Set(ledger.recentResolutions('r1').map((r) => r.kind)).size).toBe(kinds.length);
  });

  it('makes captured memories findable by their reason', () => {
    ledger.remember({ repo: 'r1', kind: 'gate_rejection', reason: 'rejected DEAD_EXPORT: toCsvRow' });
    expect(ledger.searchResolutions('r1', 'toCsvRow')).toHaveLength(1);
  });
});

/**
 * Remembering must never be the reason a run fails. A locked database or a full
 * disk should cost a log line, not the task that was about to succeed.
 */
describe('remembering fails open', () => {
  it('does not throw when the store is unusable', () => {
    ledger.closeForTest();
    process.env.SHANAUTO_DB = join(dbDir, 'nonexistent-dir', 'x.db');

    expect(() => ledger.remember({ repo: 'r1', kind: 'incident', reason: 'x' })).not.toThrow();

    process.env.SHANAUTO_DB = join(dbDir, 'test.db');
    ledger.closeForTest();
  });

  it('does not throw on absurd input', () => {
    expect(() =>
      ledger.remember({
        repo: 'r1',
        kind: 'incident',
        reason: 'x'.repeat(200_000),
        paths: Array.from({ length: 5000 }, (_, i) => `p${i}`),
      }),
    ).not.toThrow();
  });
});
