import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStats, periodBounds, renderStats } from '../core/rollup.js';
import type { Resolution } from '../ledger.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-rollupdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { buildRollups } = await import('../core/rollup.js');

function res(over: Partial<Resolution> = {}): Resolution {
  return {
    id: 'X',
    repo: 'r1',
    resolved_at: '2026-03-10T12:00:00.000Z',
    kind: 'external_commit',
    commit_sha: 'abc',
    paths: [],
    symbols: [],
    reason: null,
    task_id: null,
    claim_key: null,
    occurred_at: null,
    ...over,
  };
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('periodBounds', () => {
  it('bounds a day', () => {
    const { starts, ends } = periodBounds('day', new Date('2026-03-10T15:30:00Z'));
    expect(starts.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(ends.toISOString()).toBe('2026-03-11T00:00:00.000Z');
  });

  it('starts a week on Monday, not Sunday', () => {
    // 2026-03-10 is a Tuesday; the week must start on the 9th.
    expect(periodBounds('week', new Date('2026-03-10T15:30:00Z')).starts.toISOString()).toBe(
      '2026-03-09T00:00:00.000Z',
    );
  });

  it('treats Sunday as the end of its week, not the start', () => {
    // 2026-03-15 is a Sunday; its week still starts Monday the 9th.
    expect(periodBounds('week', new Date('2026-03-15T10:00:00Z')).starts.toISOString()).toBe(
      '2026-03-09T00:00:00.000Z',
    );
  });

  it('bounds a month, including across a year boundary', () => {
    const dec = periodBounds('month', new Date('2026-12-20T00:00:00Z'));
    expect(dec.starts.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(dec.ends.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('computeStats', () => {
  it('counts by kind', () => {
    const s = computeStats([res(), res(), res({ kind: 'decision' })]);
    expect(s.byKind).toEqual({ external_commit: 2, decision: 1 });
    expect(s.total).toBe(3);
  });

  it('ranks the most-touched files first', () => {
    const s = computeStats([
      res({ paths: ['a.ts', 'b.ts'] }),
      res({ paths: ['a.ts'] }),
      res({ paths: ['c.ts'] }),
    ]);
    expect(s.topPaths[0]).toEqual(['a.ts', 2]);
  });

  /** Counts say how much happened; highlights say what actually mattered. */
  it('carries decisions and incidents forward verbatim', () => {
    const s = computeStats([
      res({ kind: 'decision', reason: 'Grant agy shell access\nbody' }),
      res({ kind: 'incident', reason: 'killswitch tripped' }),
      res({ kind: 'external_commit', reason: 'chore: bump' }),
    ]);
    expect(s.highlights).toContain('Grant agy shell access');
    expect(s.highlights).toContain('killswitch tripped');
    expect(s.highlights).not.toContain('chore: bump');
  });

  it('handles an empty period', () => {
    const s = computeStats([]);
    expect(s.total).toBe(0);
    expect(renderStats(s)).toBe('nothing recorded');
  });

  it('does not throw on malformed path or symbol entries', () => {
    const bad = res({ paths: [null, 1] as unknown as string[], symbols: [undefined] as unknown as string[] });
    expect(() => computeStats([bad])).not.toThrow();
  });
});

describe('buildRollups', () => {
  function seed(when: string, kind: Resolution['kind'] = 'external_commit') {
    ledger.open()
      .prepare(
        `INSERT INTO resolutions (id,repo,resolved_at,kind,commit_sha,paths,symbols,reason,task_id,claim_key)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(`id${Math.random()}`, 'r1', when, kind, null, '["src/a.ts"]', '[]', 'x', null, null);
  }

  it('builds one rollup per period that has memories', () => {
    seed('2026-03-02T10:00:00.000Z'); // week of Mar 2
    seed('2026-03-03T10:00:00.000Z'); // same week
    seed('2026-03-10T10:00:00.000Z'); // week of Mar 9
    expect(buildRollups('r1', 'week', new Date('2026-04-01T00:00:00Z'))).toBe(2);
  });

  it('skips periods with nothing in them', () => {
    seed('2026-03-02T10:00:00.000Z');
    seed('2026-06-02T10:00:00.000Z'); // months later
    // Only the two occupied weeks, not every week between.
    expect(buildRollups('r1', 'week', new Date('2026-07-01T00:00:00Z'))).toBe(2);
  });

  /** A period still in progress would be wrong an hour later. */
  it('does not roll up the period currently in progress', () => {
    seed('2026-03-10T10:00:00.000Z');
    expect(buildRollups('r1', 'week', new Date('2026-03-11T00:00:00Z'))).toBe(0);
  });

  it('is safe to re-run', () => {
    seed('2026-03-02T10:00:00.000Z');
    buildRollups('r1', 'week', new Date('2026-04-01T00:00:00Z'));
    buildRollups('r1', 'week', new Date('2026-04-01T00:00:00Z'));
    expect(ledger.getRollups('r1', 'week')).toHaveLength(1);
  });

  it('preserves a narrative across a rebuild, since one cost a model call', () => {
    seed('2026-03-02T10:00:00.000Z');
    buildRollups('r1', 'week', new Date('2026-04-01T00:00:00Z'));
    const r = ledger.getRollups('r1', 'week')[0]!;
    ledger.setRollupNarrative(r.id, 'that week the gate was tightened');

    buildRollups('r1', 'week', new Date('2026-04-01T00:00:00Z'));
    expect(ledger.getRollups('r1', 'week')[0]!.narrative).toBe('that week the gate was tightened');
  });

  it('does nothing for a repo with no memories', () => {
    expect(buildRollups('empty-repo', 'week')).toBe(0);
  });
});
