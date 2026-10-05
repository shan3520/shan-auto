import { describe, it, expect } from 'vitest';
import { assessStaleness } from '../core/staleness.js';
import type { Resolution, TaskClaim } from '../ledger.js';

function claim(over: Partial<TaskClaim> = {}): TaskClaim {
  return {
    task_id: 'T1',
    plan_head: 'head0',
    planned_at: '2026-08-07T00:00:00Z',
    paths: ['src/util.ts'],
    symbols: ['sleep'],
    claim_key: 'k',
    ...over,
  };
}

function res(over: Partial<Resolution> = {}): Resolution {
  return {
    id: 'X1',
    repo: 'r',
    resolved_at: '2026-08-07T01:00:00Z',
    kind: 'external_commit',
    commit_sha: 'abc1234567890',
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
 * The exact scenario this feature exists for: a task to "add a sleep utility"
 * sat queued while the owner added `sleep` by hand. It cost a provider request
 * to discover that, and this table is what makes the discovery free.
 */
describe('assessStaleness — verdicts', () => {
  it('SUPERSEDED when a claimed symbol has since been exported by something else', () => {
    const r = assessStaleness(claim(), 'head0', 'head9', [res({ symbols: ['sleep'] })]);
    expect(r.verdict).toBe('SUPERSEDED');
    expect(r.supersededBy).toMatchObject({ symbol: 'sleep' });
  });

  it('names the commit and symbol in its evidence, so the log is actionable', () => {
    const r = assessStaleness(claim(), 'head0', 'head9', [
      res({ symbols: ['sleep'], commit_sha: 'abc1234567890', reason: 'add sleep helper' }),
    ]);
    expect(r.evidence).toContain('sleep');
    expect(r.evidence).toContain('abc12345');
    expect(r.evidence).toContain('add sleep helper');
  });

  it('DRIFTED when the claimed file moved but the symbol is still absent', () => {
    const r = assessStaleness(claim(), 'head0', 'head9', [res({ paths: ['src/util.ts'] })]);
    expect(r.verdict).toBe('DRIFTED');
    expect(r.evidence).toContain('src/util.ts');
  });

  /*
   * The verdict is the only place that knows which resolution matched, and
   * until run 19 it kept that to itself: the caller got a sentence to log and
   * no way to ask who was responsible. Two tasks planned together both claimed
   * app/api/search.py, the second undid the first, and the string "changed in
   * 8bcbd743" was as far as the information ever travelled.
   */
  it('names the task behind the commit, not only the commit', () => {
    const r = assessStaleness(claim(), 'head0', 'head9', [
      res({ paths: ['src/util.ts'], commit_sha: 'abc1234567890', task_id: 'T_prior' }),
    ]);
    expect(r.driftedBy).toEqual({ sha: 'abc1234567890', path: 'src/util.ts', taskId: 'T_prior' });
  });

  it('leaves taskId null for a commit that came from outside this system', () => {
    // A hand edit by the repo owner drifts a task exactly as ours does, and
    // there is no acceptance sentence behind it to protect.
    const r = assessStaleness(claim(), 'head0', 'head9', [res({ paths: ['src/util.ts'] })]);
    expect(r.verdict).toBe('DRIFTED');
    expect(r.driftedBy?.taskId).toBeNull();
  });

  it('FRESH when the delta touches neither the claimed paths nor symbols', () => {
    const r = assessStaleness(claim(), 'head0', 'head9', [
      res({ paths: ['src/other.ts'], symbols: ['unrelated'] }),
    ]);
    expect(r.verdict).toBe('FRESH');
  });

  it('prefers SUPERSEDED over DRIFTED when both would apply', () => {
    // The symbol existing is the stronger signal than the file having changed.
    const r = assessStaleness(claim(), 'head0', 'head9', [
      res({ paths: ['src/util.ts'], symbols: ['sleep'] }),
    ]);
    expect(r.verdict).toBe('SUPERSEDED');
  });
});

describe('assessStaleness — fast path', () => {
  it('is FRESH without inspecting the delta when HEAD has not moved', () => {
    const r = assessStaleness(claim(), 'same', 'same', [res({ symbols: ['sleep'] })]);
    expect(r.verdict).toBe('FRESH');
  });
});

/**
 * A false SUPERSEDED silently parks live work. A false FRESH costs one provider
 * request — the status quo. Every ambiguous input must therefore yield FRESH.
 */
describe('assessStaleness — fails open', () => {
  const supersedingDelta = [res({ symbols: ['sleep'], paths: ['src/util.ts'] })];

  const cases: [string, () => ReturnType<typeof assessStaleness>][] = [
    ['null claim', () => assessStaleness(null, 'head0', 'head9', supersedingDelta)],
    ['no plan_head recorded', () => assessStaleness(claim({ plan_head: null }), null, 'head9', supersedingDelta)],
    ['empty claim arrays', () => assessStaleness(claim({ paths: [], symbols: [] }), 'head0', 'head9', supersedingDelta)],
    ['empty delta', () => assessStaleness(claim(), 'head0', 'head9', [])],
    ['unknown current head', () => assessStaleness(claim(), 'head0', null, [])],
    [
      'claim fields missing entirely',
      () =>
        assessStaleness(
          { ...claim(), paths: undefined as unknown as string[], symbols: undefined as unknown as string[] },
          'head0',
          'head9',
          supersedingDelta,
        ),
    ],
    [
      'resolution fields missing entirely',
      () =>
        assessStaleness(claim(), 'head0', 'head9', [
          { ...res(), paths: undefined as unknown as string[], symbols: undefined as unknown as string[] },
        ]),
    ],
    ['whitespace-only claim entries', () => assessStaleness(claim({ paths: ['  '], symbols: ['  '] }), 'head0', 'head9', supersedingDelta)],
  ];

  for (const [name, run] of cases) {
    it(`yields FRESH: ${name}`, () => {
      expect(run().verdict).toBe('FRESH');
    });
  }

  it('never throws on malformed input', () => {
    expect(() =>
      assessStaleness(
        { ...claim(), symbols: [null as unknown as string] },
        'head0',
        'head9',
        [{ ...res(), symbols: [undefined as unknown as string] }],
      ),
    ).not.toThrow();
  });
});

describe('assessStaleness — normalisation', () => {
  it('matches paths across separator styles, so Windows and git agree', () => {
    const r = assessStaleness(
      claim({ symbols: [], paths: ['src\\util.ts'] }),
      'head0',
      'head9',
      [res({ paths: ['src/util.ts'] })],
    );
    expect(r.verdict).toBe('DRIFTED');
  });

  it('treats symbols as case-sensitive, because identifiers are', () => {
    const r = assessStaleness(claim({ symbols: ['Sleep'] }), 'head0', 'head9', [
      res({ symbols: ['sleep'] }),
    ]);
    expect(r.verdict).not.toBe('SUPERSEDED');
  });
});
