import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-exportdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { exportMemory, importMemory } = await import('../core/memory-export.js');

const outDir = mkdtempSync(join(tmpdir(), 'sa-exportout-'));

function seed() {
  ledger.remember({
    repo: 'r1',
    kind: 'decision',
    reason: 'Grant agy shell access\nauthorised after risks documented',
    occurred_at: '2026-08-06T12:00:00.000Z',
  });
  ledger.remember({
    repo: 'r1',
    kind: 'external_commit',
    commit_sha: 'abc12345',
    paths: ['src/util.ts'],
    symbols: ['sleep'],
    reason: 'add sleep helper',
    occurred_at: '2025-11-02T09:00:00.000Z',
  });
  ledger.saveRollup({
    repo: 'r1',
    period: 'month',
    starts_at: '2026-08-01T00:00:00.000Z',
    ends_at: '2026-09-01T00:00:00.000Z',
    stats: { total: 2, byKind: {}, topPaths: [], topSymbols: [], highlights: [] },
    source_count: 2,
    narrative: 'that month the gate was tightened',
  });
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
  for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { force: true });
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * "Infinite memory" living only in one binary file is a corruption away from
 * zero. These prove it can leave and come back intact.
 */
describe('exportMemory', () => {
  it('writes one file per year of history, not per export', () => {
    seed();
    const r = exportMemory('r1', outDir);
    const names = readdirSync(outDir).sort();
    expect(names).toContain('r1-2025.jsonl');
    expect(names).toContain('r1-2026.jsonl');
    expect(r.records).toBe(3);
  });

  it('files by when the event happened, not when it was exported', () => {
    seed();
    exportMemory('r1', outDir);
    expect(readFileSync(join(outDir, 'r1-2025.jsonl'), 'utf8')).toContain('add sleep helper');
  });

  it('writes one self-describing record per line', () => {
    seed();
    exportMemory('r1', outDir);
    const lines = readFileSync(join(outDir, 'r1-2026.jsonl'), 'utf8').trim().split('\n');
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.some((l) => (JSON.parse(l) as { type: string }).type === 'rollup')).toBe(true);
  });

  it('replaces rather than appends, so exporting twice does not duplicate', () => {
    seed();
    exportMemory('r1', outDir);
    exportMemory('r1', outDir);
    const lines = readFileSync(join(outDir, 'r1-2026.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // one decision + one rollup
  });
});

describe('eachResolution / eachRollup (PERF-6 chunked iteration)', () => {
  it('visits every resolution exactly once across chunk boundaries', () => {
    for (let i = 0; i < 5; i++) {
      ledger.remember({
        repo: 'r1',
        kind: 'decision',
        reason: `decision ${i}`,
        occurred_at: `2026-08-0${i + 1}T12:00:00.000Z`,
      });
    }
    const seen: string[] = [];
    ledger.eachResolution('r1', (r) => seen.push(String(r.reason)), 2);
    // Keyset pagination must neither drop a row nor repeat one — chunk 2 forces
    // three pages over five rows. Order is by insertion time, not occurred_at,
    // so only the set is asserted.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual(['decision 0', 'decision 1', 'decision 2', 'decision 3', 'decision 4']);
  });

  it('visits every rollup exactly once across chunk boundaries', () => {
    for (let i = 0; i < 5; i++) {
      ledger.saveRollup({
        repo: 'r1',
        period: 'week',
        starts_at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        ends_at: '2026-08-07T00:00:00.000Z',
        stats: {},
        source_count: 1,
      });
    }
    const seen: string[] = [];
    ledger.eachRollup('r1', (r) => seen.push(r.starts_at), 2);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // no duplicates across pages
  });
});

describe('importMemory', () => {
  it('restores everything after the store is lost', () => {
    seed();
    exportMemory('r1', outDir);

    ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
    expect(ledger.recentResolutions('r1')).toHaveLength(0);

    const r = importMemory('r1', outDir);
    expect(r.imported).toBe(3);
    expect(ledger.recentResolutions('r1')).toHaveLength(2);
    expect(ledger.getRollups('r1')).toHaveLength(1);
  });

  it('round-trips the reasoning intact, not just the row count', () => {
    seed();
    exportMemory('r1', outDir);
    ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
    importMemory('r1', outDir);

    const hit = ledger.searchResolutions('r1', 'authorised risks')[0]!;
    expect(hit.reason).toContain('Grant agy shell access');
    expect(ledger.getRollups('r1')[0]!.narrative).toBe('that month the gate was tightened');
  });

  it('preserves when things happened', () => {
    seed();
    exportMemory('r1', outDir);
    ledger.open().exec('DELETE FROM resolutions;');
    importMemory('r1', outDir);

    const sleep = ledger.searchResolutions('r1', 'sleep helper')[0]!;
    expect(sleep.occurred_at).toBe('2025-11-02T09:00:00.000Z');
  });

  it('is idempotent — importing over a live store adds nothing', () => {
    seed();
    exportMemory('r1', outDir);
    const second = importMemory('r1', outDir);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
  });

  /** A half-written file must still give back everything that survived. */
  it('recovers what it can from a truncated file', () => {
    seed();
    exportMemory('r1', outDir);
    const f = join(outDir, 'r1-2026.jsonl');
    writeFileSync(f, `${readFileSync(f, 'utf8').split('\n')[0]}\n{"type":"resolution","kind":`);

    ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
    const r = importMemory('r1', outDir);

    expect(r.imported).toBeGreaterThan(0);
    expect(r.malformed).toBe(1);
  });

  it('does nothing when there is nothing to import', () => {
    expect(importMemory('r1', join(outDir, 'nope'))).toEqual({ imported: 0, skipped: 0, malformed: 0 });
  });
});
