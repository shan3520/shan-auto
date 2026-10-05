import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainDriver } from '../drivers/contracts.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-narratedb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { narrateRollups } = await import('../core/rollup.js');

/** Stands in for the driver; the point is counting calls, not calling a model. */
function fakeBrain(answer: unknown, calls: { n: number }): BrainDriver {
  return {
    id: 'fake',
    init: async () => undefined,
    ask: (async () => {
      calls.n++;
      if (answer instanceof Error) throw answer;
      return answer;
    }) as BrainDriver['ask'],
    dispose: async () => undefined,
  };
}

function seedRollup(starts: string, narrative: string | null = null) {
  ledger.saveRollup({
    repo: 'r1',
    period: 'week',
    starts_at: starts,
    ends_at: starts,
    stats: { total: 3, byKind: { decision: 1 }, topPaths: [], topSymbols: [], highlights: ['Grant agy shell access'] },
    source_count: 3,
    narrative,
  });
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM memory_rollups; DELETE FROM resolutions;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('narrateRollups', () => {
  it('writes a sentence onto a period that lacked one', async () => {
    seedRollup('2026-03-09T00:00:00.000Z');
    const calls = { n: 0 };

    const r = await narrateRollups('r1', fakeBrain({ narrative: 'The gate was tightened to run tests.' }, calls));

    expect(r.narrated).toBe(1);
    expect(ledger.getRollups('r1', 'week')[0]!.narrative).toContain('gate was tightened');
  });

  /** One call per closed period is the entire cost model of this feature. */
  it('spends exactly one provider call per period', async () => {
    seedRollup('2026-03-09T00:00:00.000Z');
    seedRollup('2026-03-16T00:00:00.000Z');
    const calls = { n: 0 };

    await narrateRollups('r1', fakeBrain({ narrative: 'x' }, calls));
    expect(calls.n).toBe(2);
  });

  it('does not re-narrate a period that already has one', async () => {
    seedRollup('2026-03-09T00:00:00.000Z', 'already written');
    const calls = { n: 0 };

    const r = await narrateRollups('r1', fakeBrain({ narrative: 'new' }, calls));

    expect(calls.n).toBe(0);
    expect(r.narrated).toBe(0);
    expect(ledger.getRollups('r1', 'week')[0]!.narrative).toBe('already written');
  });

  it('respects the limit, so a first run cannot spend the daily budget', async () => {
    for (let i = 0; i < 8; i++) seedRollup(`2026-0${i + 1}-05T00:00:00.000Z`);
    const calls = { n: 0 };

    await narrateRollups('r1', fakeBrain({ narrative: 'x' }, calls), 3);
    expect(calls.n).toBe(3);
  });

  /** Stats alone are useful; a missing narrative must not fail the command. */
  it('survives the brain being unavailable', async () => {
    seedRollup('2026-03-09T00:00:00.000Z');
    const calls = { n: 0 };

    const r = await narrateRollups('r1', fakeBrain(new Error('QUOTA exhausted'), calls));

    expect(r.failed).toBe(1);
    expect(r.narrated).toBe(0);
    expect(ledger.getRollups('r1', 'week')[0]!.narrative).toBeNull();
  });

  it('ignores an empty answer rather than storing a blank', async () => {
    seedRollup('2026-03-09T00:00:00.000Z');
    const calls = { n: 0 };

    await narrateRollups('r1', fakeBrain({ narrative: '   ' }, calls));
    expect(ledger.getRollups('r1', 'week')[0]!.narrative).toBeNull();
  });

  it('does nothing when every period is already narrated', async () => {
    seedRollup('2026-03-09T00:00:00.000Z', 'done');
    const calls = { n: 0 };
    expect(await narrateRollups('r1', fakeBrain({ narrative: 'x' }, calls))).toEqual({
      narrated: 0,
      failed: 0,
    });
  });
});
