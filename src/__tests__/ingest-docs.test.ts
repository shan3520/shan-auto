import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-docsdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { parseDecisionSections, ingestDecisions, ingestRunLogs } = await import('../core/ingest-docs.js');

const workDir = mkdtempSync(join(tmpdir(), 'sa-docs-'));

const DECISIONS = `# Decision record

Decisions, why they were made, and how to undo them.

---

## 2026-08-07 — Grant agy shell access

The owner explicitly authorised shell access for the agy agent, after the risks
were documented. Protection is a default-deny allow-list. The only genuine
containment boundary, a restricted Windows account, was declined.

## 2026-08-07 — Gate on tests, not just typecheck

verify_cmd changed after typecheck passed two changes that should not have
landed: an interface declaring non-existent DB columns, and an uncalled helper.

## Too short
x
`;

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('parseDecisionSections', () => {
  it('splits on headings and keeps the reasoning', () => {
    const s = parseDecisionSections(DECISIONS);
    expect(s).toHaveLength(2);
    expect(s[0]!.title).toBe('Grant agy shell access');
    expect(s[0]!.date).toBe('2026-08-07');
    expect(s[0]!.body).toContain('default-deny allow-list');
  });

  it('drops stubs with no substance', () => {
    expect(parseDecisionSections(DECISIONS).map((x) => x.title)).not.toContain('Too short');
  });

  it('handles a heading with no date', () => {
    const s = parseDecisionSections('## Some choice\n' + 'why '.repeat(20));
    expect(s[0]!.date).toBeNull();
    expect(s[0]!.title).toBe('Some choice');
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(parseDecisionSections('')).toEqual([]);
  });
});

/**
 * The reasoning was already written down — it simply was not retrievable. This
 * is the cheapest large gain in the whole memory feature.
 */
describe('ingestDecisions', () => {
  const file = join(workDir, 'DECISIONS.md');
  writeFileSync(file, DECISIONS);

  it('makes a written decision answerable by search', () => {
    ingestDecisions('r1', file);
    const hits = ledger.searchResolutions('r1', 'agy shell access');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('decision');
    expect(hits[0]!.reason).toContain('default-deny');
  });

  it('is idempotent — re-running adds nothing', () => {
    ingestDecisions('r1', file);
    const second = ingestDecisions('r1', file);
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('picks up only the new section when the file grows', () => {
    ingestDecisions('r1', file);
    writeFileSync(file, DECISIONS + '\n## 2026-09-01 — A later choice\n' + 'reasoning '.repeat(20));
    expect(ingestDecisions('r1', file).ingested).toBe(1);
    writeFileSync(file, DECISIONS); // restore
  });

  it('does nothing when the file is absent', () => {
    expect(ingestDecisions('r1', join(workDir, 'nope.md'))).toEqual({ ingested: 0, skipped: 0 });
  });
});

describe('ingestRunLogs', () => {
  const runs = join(workDir, 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(
    join(runs, '2026-08-06.jsonl'),
    [
      JSON.stringify({ ts: '2026-08-06T21:00:00Z', level: 'info', msg: '[T1] committed abc12345' }),
      JSON.stringify({ ts: '2026-08-06T22:00:00Z', level: 'warn', msg: 'Outside work hours (07:00-22:00) - stopping.' }),
      JSON.stringify({ ts: '2026-08-06T22:00:01Z', level: 'info', msg: 'Run complete: 5 committed, 0 failed' }),
      'not json at all',
    ].join('\n'),
  );

  it('keeps terminal outcomes and discards routine noise', () => {
    ingestRunLogs('r1', runs);
    const all = ledger.recentResolutions('r1');
    expect(all.some((r) => r.reason?.includes('Run complete'))).toBe(true);
    expect(all.some((r) => r.reason?.includes('committed abc12345'))).toBe(false);
  });

  it('survives malformed lines', () => {
    expect(() => ingestRunLogs('r1', runs)).not.toThrow();
  });

  it('is idempotent', () => {
    ingestRunLogs('r1', runs);
    const before = ledger.recentResolutions('r1').length;
    ingestRunLogs('r1', runs);
    expect(ledger.recentResolutions('r1')).toHaveLength(before);
  });

  it('does nothing when the directory is absent', () => {
    expect(ingestRunLogs('r1', join(workDir, 'no-such-dir'))).toEqual({ ingested: 0, skipped: 0 });
  });
});
