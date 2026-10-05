import { describe, it, expect } from 'vitest';
import { normaliseClaim } from '../core/planner.js';
import { resolutionDigest } from '../core/context.js';
import type { Resolution } from '../ledger.js';

function res(over: Partial<Resolution> = {}): Resolution {
  return {
    id: 'X',
    repo: 'r',
    resolved_at: '2026-08-07T00:00:00Z',
    kind: 'external_commit',
    commit_sha: 'abc123',
    paths: [],
    symbols: [],
    reason: null,
    task_id: null,
    claim_key: null,
    occurred_at: null,
    ...over,
  };
}

/**
 * The prompt asks the planner for a claim, but a prompt is a request rather than
 * a constraint — every shape below has to survive without breaking planning.
 */
describe('normaliseClaim', () => {
  it('keeps a well-formed claim', () => {
    expect(normaliseClaim({ claim: { paths: ['src/a.ts'], symbols: ['foo'] } })).toEqual({
      paths: ['src/a.ts'],
      symbols: ['foo'],
    });
  });

  it('falls back to files_hint when no claim was given', () => {
    // Paths alone can only yield DRIFTED, which dispatches anyway — free upside.
    expect(normaliseClaim({ files_hint: ['src/b.ts'] })).toEqual({
      paths: ['src/b.ts'],
      symbols: [],
    });
  });

  it('yields empty arrays when the model gave nothing at all', () => {
    expect(normaliseClaim({})).toEqual({ paths: [], symbols: [] });
  });

  it('drops non-strings rather than throwing', () => {
    const c = normaliseClaim({
      claim: { paths: [null, 42, 'src/ok.ts'] as unknown as string[], symbols: [] },
    });
    expect(c.paths).toEqual(['src/ok.ts']);
  });

  it('drops blanks and de-duplicates', () => {
    const c = normaliseClaim({ claim: { paths: ['a.ts', 'a.ts', '  ', ''], symbols: ['x', 'x'] } });
    expect(c.paths).toEqual(['a.ts']);
    expect(c.symbols).toEqual(['x']);
  });

  it('caps a runaway list', () => {
    const many = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(normaliseClaim({ claim: { paths: [], symbols: many } }).symbols.length).toBeLessThanOrEqual(12);
  });

  it('survives a claim that is not an object', () => {
    expect(() => normaliseClaim({ claim: 'nonsense' as unknown as { paths: string[] } })).not.toThrow();
  });
});

describe('resolutionDigest', () => {
  it('summarises what landed, newest first', () => {
    const d = resolutionDigest([
      res({ symbols: ['newest'], claim_key: 'a' }),
      res({ symbols: ['older'], claim_key: 'b' }),
    ]);
    expect(d.indexOf('newest')).toBeLessThan(d.indexOf('older'));
  });

  it('collapses the same work described more than once', () => {
    const d = resolutionDigest([
      res({ symbols: ['sleep'], claim_key: 'same', reason: 'add sleep' }),
      res({ symbols: ['sleep'], claim_key: 'same', reason: 'add sleep again' }),
    ]);
    expect(d.split('\n').filter((l) => l.includes('sleep'))).toHaveLength(1);
  });

  /** Injected into a prompt ~7 times a day; an uncapped digest grows forever. */
  it('never exceeds the character cap', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      res({ symbols: [`symbol_number_${i}`], claim_key: `k${i}`, reason: 'x'.repeat(60) }),
    );
    const d = resolutionDigest(many, 2000);
    expect(d.length).toBeLessThanOrEqual(2000);
  });

  it('says so when it had to truncate', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      res({ symbols: [`sym${i}`], claim_key: `k${i}` }),
    );
    expect(resolutionDigest(many, 400)).toContain('omitted');
  });

  it('reports emptiness plainly rather than returning a blank string', () => {
    expect(resolutionDigest([])).toBe('(nothing resolved yet)');
  });

  it('skips rows carrying neither symbols nor paths', () => {
    expect(resolutionDigest([res({ reason: 'no detail' })])).toBe('(nothing resolved yet)');
  });

  it('does not throw when fields are missing entirely', () => {
    const broken = { ...res(), paths: undefined, symbols: undefined } as unknown as Resolution;
    expect(() => resolutionDigest([broken])).not.toThrow();
  });
});
