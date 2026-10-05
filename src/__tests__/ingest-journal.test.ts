import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-jdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { condenseDay, ingestJournal } = await import('../core/ingest-docs.js');

const dir = mkdtempSync(join(tmpdir(), 'sa-jing-'));
const NOW = new Date(2026, 7, 8, 9, 0); // 8 Aug, so the 7th is a closed day

const DAY = `# Work journal — 2026-08-07

### 09:01 · T-a1 · dispatch → agy · shanauto · add rollup narration
Write narrateRollups() in src/core/rollup.ts and call it from the reporter.
Lots and lots of prompt boilerplate that nobody needs a year from now.

### 09:14 · T-a1 · result → agy · shanauto · add rollup narration
I created the function and wired it up. Verbose agent chatter follows.
More chatter. Even more chatter that is worthless later.

### 09:15 · T-a1 · gate → agy · shanauto · add rollup narration
REJECTED DEAD_EXPORT: narrateRollups is exported but nothing imports it.
(will retry)

### 09:40 · T-a2 · commit → agy · shanauto · wire narration into the reporter
committed 9f2a1c3d — 2 files, +61/-3
files: src/core/rollup.ts, src/core/reporter.ts
`;

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  ledger.open().exec('DELETE FROM resolutions;');
  writeFileSync(join(dir, '2026-08-07.md'), DAY, 'utf8');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

describe('condenseDay', () => {
  it('keeps the reason a task was rejected — the point of the exercise', () => {
    const out = condenseDay(DAY);
    expect(out).toContain('DEAD_EXPORT');
    expect(out).toContain('nothing imports it');
  });

  it('keeps commit outcomes', () => {
    expect(condenseDay(DAY)).toContain('9f2a1c3d');
  });

  it('keeps the prompts and the chatter — the whole exchange is the record', () => {
    // This used to drop both. The owner asked for everything kept.
    const out = condenseDay(DAY);
    expect(out).toContain('prompt boilerplate');
    expect(out).toContain('Verbose agent chatter');
  });

  it('keeps every heading, so the sequence stays legible', () => {
    const out = condenseDay(DAY);
    for (const stage of ['dispatch', 'result', 'gate', 'commit']) {
      expect(out).toContain(stage);
    }
  });

  it('keeps essentially all of the day', () => {
    // Only the day title is removed; the caller re-adds it as the headline.
    expect(condenseDay(DAY).length).toBeGreaterThan(DAY.length * 0.9);
  });

  it('does not cap a huge day by default', () => {
    const huge = `# Work journal — 2026-08-07\n\n### 09:00 · T-x · gate · r · t\n${'x'.repeat(50_000)}`;
    expect(condenseDay(huge).length).toBeGreaterThan(50_000);
  });

  it('still honours an explicit limit when one is asked for', () => {
    const huge = `# Work journal — 2026-08-07\n\n### 09:00 · T-x · gate · r · t\n${'x'.repeat(50_000)}`;
    expect(condenseDay(huge, 1000).length).toBeLessThan(1100);
  });
});

describe('ingestJournal', () => {
  it('stores a closed day as one searchable memory', () => {
    const r = ingestJournal('r1', dir, NOW);
    expect(r.ingested).toBe(1);
    const rows = ledger.resolutionsByKind('r1', ['journal'], 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toContain('DEAD_EXPORT');
  });

  it('dates the memory to the day it happened, not the day it was ingested', () => {
    ingestJournal('r1', dir, NOW);
    const row = ledger.resolutionsByKind('r1', ['journal'], 100)[0]!;
    expect(row.occurred_at?.slice(0, 10)).toBe('2026-08-07');
  });

  it('is idempotent — re-running adds nothing', () => {
    expect(ingestJournal('r1', dir, NOW).ingested).toBe(1);
    expect(ingestJournal('r1', dir, NOW).ingested).toBe(0);
    expect(ledger.resolutionsByKind('r1', ['journal'], 100)).toHaveLength(1);
  });

  it('leaves today alone — it is still being written', () => {
    // Same file, but "now" is the 7th, so the 7th is the open day.
    const r = ingestJournal('r1', dir, new Date(2026, 7, 7, 14, 0));
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('does nothing when there is no journal', () => {
    expect(ingestJournal('r1', join(dir, 'nope'), NOW)).toEqual({ ingested: 0, skipped: 0 });
  });

  it('skips a day with nothing worth keeping', () => {
    writeFileSync(join(dir, '2026-08-05.md'), '# Work journal — 2026-08-05\n', 'utf8');
    ingestJournal('r1', dir, NOW);
    const days = ledger.resolutionsByKind('r1', ['journal'], 100).map((r) => r.occurred_at?.slice(0, 10));
    expect(days).not.toContain('2026-08-05');
  });
});
