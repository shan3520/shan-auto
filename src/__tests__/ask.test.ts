import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainDriver } from '../drivers/contracts.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-askdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { askMemory } = await import('../core/ask.js');

/** Captures the prompt so we can assert what the model was actually given. */
function fakeBrain(calls: { n: number; prompts: string[] }, answer = 'an answer'): BrainDriver {
  return {
    id: 'fake',
    init: async () => undefined,
    ask: (async (text: string) => {
      calls.n++;
      calls.prompts.push(text);
      return { answer };
    }) as BrainDriver['ask'],
    dispose: async () => undefined,
  };
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('askMemory', () => {
  it('spends exactly one provider call', async () => {
    ledger.remember({ repo: 'r1', kind: 'decision', reason: 'Grant agy shell access\nauthorised after risks' });
    const calls = { n: 0, prompts: [] as string[] };

    await askMemory('r1', 'why does agy have shell access?', fakeBrain(calls));
    expect(calls.n).toBe(1);
  });

  it('puts the relevant memory in front of the model', async () => {
    ledger.remember({ repo: 'r1', kind: 'decision', reason: 'Grant agy shell access\nauthorised after risks' });
    ledger.remember({ repo: 'r1', kind: 'external_commit', reason: 'chore: bump lockfile' });
    const calls = { n: 0, prompts: [] as string[] };

    await askMemory('r1', 'why does agy have shell access?', fakeBrain(calls));

    expect(calls.prompts[0]).toContain('Grant agy shell access');
    expect(calls.prompts[0]).not.toContain('bump lockfile');
  });

  /** Spending a request to be told "no idea" is the one waste worth avoiding. */
  it('answers without a provider call when nothing matches', async () => {
    ledger.remember({ repo: 'r1', kind: 'external_commit', reason: 'chore: bump' });
    const calls = { n: 0, prompts: [] as string[] };

    const r = await askMemory('r1', 'quantum entanglement in the scheduler', fakeBrain(calls));

    expect(calls.n).toBe(0);
    expect(r.answer).toContain('Nothing recorded');
  });

  it('rejects a question with nothing searchable in it, without calling out', async () => {
    const calls = { n: 0, prompts: [] as string[] };
    const r = await askMemory('r1', 'what is it about?', fakeBrain(calls));

    expect(calls.n).toBe(0);
    expect(r.answer).toContain('nothing specific');
  });

  it('reports how much evidence backed the answer', async () => {
    ledger.remember({ repo: 'r1', kind: 'decision', reason: 'staleness check added' });
    const r = await askMemory('r1', 'staleness check', fakeBrain({ n: 0, prompts: [] }));

    expect(r.candidates).toBeGreaterThan(0);
    expect(r.contextChars).toBeGreaterThan(0);
  });

  it('draws on a period summary when the question is about a whole month', async () => {
    ledger.saveRollup({
      repo: 'r1',
      period: 'month',
      starts_at: '2026-03-01T00:00:00.000Z',
      ends_at: '2026-04-01T00:00:00.000Z',
      stats: { total: 90, byKind: {}, topPaths: [], topSymbols: [], highlights: [] },
      source_count: 90,
      narrative: 'that month the sparkline was added to the daily report',
    });
    const calls = { n: 0, prompts: [] as string[] };

    await askMemory('r1', 'sparkline', fakeBrain(calls));
    expect(calls.prompts[0]).toContain('sparkline was added');
  });

  it('scopes to the repo asked about', async () => {
    ledger.remember({ repo: 'other', kind: 'decision', reason: 'agy shell access elsewhere' });
    const calls = { n: 0, prompts: [] as string[] };

    const r = await askMemory('r1', 'agy shell access', fakeBrain(calls));
    expect(calls.n).toBe(0);
    expect(r.answer).toContain('Nothing recorded');
  });
});
