import { describe, it, expect } from 'vitest';
import { buildContext, scoreText, snippet, terms } from '../core/retrieve.js';
import { expandTerms } from '../core/aliases.js';
import type { Resolution, RollupRow } from '../ledger.js';

const NOW = new Date('2027-01-15T00:00:00Z');

function mem(over: Partial<Resolution> = {}): Resolution {
  return {
    id: 'X',
    repo: 'r1',
    resolved_at: '2026-08-07T00:00:00.000Z',
    occurred_at: '2026-08-07T00:00:00.000Z',
    kind: 'external_commit',
    commit_sha: 'abc12345',
    paths: [],
    symbols: [],
    reason: null,
    task_id: null,
    claim_key: null,
    ...over,
  };
}

function rollup(over: Partial<RollupRow> = {}): RollupRow {
  return {
    id: 'R',
    repo: 'r1',
    period: 'month',
    starts_at: '2026-03-01T00:00:00.000Z',
    ends_at: '2026-04-01T00:00:00.000Z',
    stats: '{"total":90,"byKind":{"external_commit":90},"topPaths":[],"topSymbols":[],"highlights":[]}',
    narrative: null,
    source_count: 90,
    built_at: '2026-04-01T00:00:00.000Z',
    ...over,
  };
}

describe('terms', () => {
  it('strips filler that would match everything', () => {
    expect(terms('what do you know about the shanauto project?')).toEqual(['shanauto']);
  });

  it('keeps identifiers and paths intact', () => {
    expect(terms('why was src/core/verifier.ts changed')).toContain('src/core/verifier.ts');
  });

  it('returns nothing for a question made entirely of filler', () => {
    expect(terms('what is it about?')).toEqual([]);
  });
});

describe('scoreText', () => {
  it('scores on how many terms match', () => {
    expect(scoreText('agy shell access granted', ['agy', 'shell'], 0)).toBeGreaterThan(
      scoreText('agy was mentioned', ['agy', 'shell'], 0),
    );
  });

  it('gives nothing when no term matches', () => {
    expect(scoreText('unrelated text', ['agy'], 0)).toBe(0);
  });

  /** Recency must break ties, never dominate — old decisions still matter. */
  it('lets an older stronger match beat a fresher weaker one', () => {
    const oldStrong = scoreText('agy shell access', ['agy', 'shell'], 400);
    const newWeak = scoreText('agy', ['agy', 'shell'], 0);
    expect(oldStrong).toBeGreaterThan(newWeak);
  });
});

describe('buildContext', () => {
  it('surfaces the memory that answers the question', () => {
    const c = buildContext(
      'why does agy have shell access?',
      [
        mem({ kind: 'decision', reason: 'Grant agy shell access\nthe owner authorised it after risks documented' }),
        mem({ reason: 'chore: bump dependency' }),
      ],
      [],
      NOW,
    );
    expect(c.text).toContain('Grant agy shell access');
    expect(c.text).not.toContain('bump dependency');
  });

  /** Reasoning is usually what is being asked for; commits are the mechanics. */
  it('ranks a decision above a commit that matches equally well', () => {
    const c = buildContext(
      'staleness check',
      [
        mem({ kind: 'external_commit', reason: 'staleness check commit' }),
        mem({ kind: 'decision', reason: 'staleness check decision' }),
      ],
      [],
      NOW,
    );
    expect(c.text.indexOf('decision')).toBeLessThan(c.text.indexOf('external_commit'));
  });

  it('prefers a period summary over the raw commits it covers', () => {
    const c = buildContext(
      'sparkline work',
      [mem({ reason: 'sparkline commit one' }), mem({ reason: 'sparkline commit two' })],
      [rollup({ narrative: 'that month the sparkline was added to the report' })],
      NOW,
    );
    expect(c.text.split('\n')[0]).toContain('month summary');
  });

  it('never exceeds the character cap', () => {
    const many = Array.from({ length: 800 }, (_, i) =>
      mem({ reason: `agy shell access discussion number ${i} ` + 'x'.repeat(300) }),
    );
    const c = buildContext('agy shell access', many, [], NOW, 6000);
    expect(c.text.length).toBeLessThanOrEqual(6000);
    expect(c.used).toBeLessThanOrEqual(6000);
  });

  it('returns empty rather than everything when nothing matches and nothing is notable', () => {
    const c = buildContext('quantum entanglement', [mem({ reason: 'chore: bump' })], [], NOW);
    expect(c.text).toBe('');
    expect(c.candidates).toBe(0);
  });

  /**
   * "What do you know about the shanauto project?" scored three hits on real
   * data, because a project's memories rarely contain its own name — and that
   * is exactly the question this feature exists to answer.
   */
  it('falls back to decisions and summaries when a question is too broad to match', () => {
    const c = buildContext(
      'what do you know about the shanauto project?',
      [
        mem({ kind: 'decision', reason: 'Grant agy shell access\nauthorised after risks' }),
        mem({ kind: 'incident', reason: 'killswitch tripped mid-run' }),
        mem({ kind: 'external_commit', reason: 'chore: bump lockfile' }),
      ],
      [rollup({ narrative: 'that month the gate was tightened' })],
      NOW,
    );
    expect(c.text).toContain('Grant agy shell access');
    expect(c.text).toContain('killswitch tripped');
    expect(c.text).toContain('gate was tightened');
  });

  it('keeps precise hits ahead of the fallback material', () => {
    const c = buildContext(
      'killswitch',
      [
        mem({ kind: 'incident', reason: 'killswitch tripped mid-run' }),
        mem({ kind: 'decision', reason: 'unrelated decision about naming' }),
      ],
      [],
      NOW,
    );
    expect(c.text.split('\n')[0]).toContain('killswitch');
  });

  it('does not pad a question that already matched plenty', () => {
    const many = Array.from({ length: 10 }, (_, i) => mem({ reason: `agy shell access note ${i}` }));
    const c = buildContext('agy shell access', [...many, mem({ kind: 'decision', reason: 'irrelevant' })], [], NOW);
    expect(c.text).not.toContain('irrelevant');
  });

  it('returns empty for a question with no usable terms', () => {
    expect(buildContext('what is it?', [mem({ reason: 'anything' })], [], NOW).text).toBe('');
  });

  it('dates every line, so an answer can cite when', () => {
    const c = buildContext('agy', [mem({ kind: 'decision', reason: 'agy decision' })], [], NOW);
    expect(c.text).toMatch(/^\[2026-08-07\]/);
  });

  it('does not throw on malformed rollup stats', () => {
    expect(() =>
      buildContext('agy', [], [rollup({ stats: '{not json', narrative: 'agy things happened' })], NOW),
    ).not.toThrow();
  });

  it('does not throw when timestamps are missing', () => {
    const broken = { ...mem({ reason: 'agy' }), occurred_at: null, resolved_at: null as unknown as string };
    expect(() => buildContext('agy', [broken], [], NOW)).not.toThrow();
  });
});

/**
 * Measured against the real store, scoring ran over the 400-char *display* form,
 * so 7.9% of the longest decision was searchable and its tail scored zero. It
 * looked fine only because the thin-result fallback includes every decision and
 * there were four of them — a store with many long memories would have failed
 * silently.
 */
describe('long memories are searchable past their opening lines', () => {
  const HEAD = 'Grant agy shell access. '.repeat(30); // ~720 chars, no query word
  const TAIL = 'The restricted Windows account was declined by the owner.';
  const long = mem({ kind: 'decision', reason: `${HEAD}\n${TAIL}` });

  // Enough other matches that the fallback cannot be what rescues it.
  const filler = Array.from({ length: 12 }, (_, i) =>
    mem({ id: `F${i}`, reason: `restricted account work item ${i}` }),
  );

  it('finds a phrase buried in the tail', () => {
    const c = buildContext('why was the restricted windows account declined', [long, ...filler], [], NOW);
    expect(c.text).toContain('declined');
  });

  it('scores the tail even when the fallback is suppressed', () => {
    const c = buildContext('restricted windows account declined owner', [long, ...filler], [], NOW);
    expect(c.candidates).toBeGreaterThanOrEqual(THIN);
    expect(c.text).toContain('declined');
  });

  it('shows the matching part, not just the opening characters', () => {
    const c = buildContext('declined', [long, ...filler], [], NOW);
    const line = c.text.split('\n').find((l) => l.includes('declined'))!;
    expect(line).toContain('…'); // windowed, not truncated from the start
    expect(line.length).toBeLessThan(600); // still bounded
  });

  it('still leads with the opening when nothing matches inside it', () => {
    const c = buildContext('agy', [long], [], NOW);
    expect(c.text).toContain('Grant agy shell access');
  });
});

/** Mirrors THIN_RESULT in retrieve.ts. */
const THIN = 6;

/**
 * Storing whole journal days (128 KB each) broke retrieval silently: days scored
 * highly, then showed the wrong 400 characters, because the window landed on the
 * first match — always a common word near the top. Measured over a simulated
 * three years, the answer never appeared in the retrieved text at all.
 */
describe('snippet picks the densest window, not the first match', () => {
  const buried = [
    'task task task '.repeat(60),          // common word, near the top
    'x'.repeat(3000),
    'REJECTED DEAD_EXPORT: nothing imports it.',  // the actual answer, far in
    'y'.repeat(3000),
  ].join(' ');

  it('shows the part that answers the question', () => {
    const q = expandTerms(terms('why was a task rejected for dead_export'));
    expect(snippet(buried, q)).toContain('DEAD_EXPORT');
  });

  it('beats the first-match window it replaced', () => {
    const q = expandTerms(terms('task dead_export'));
    const chosen = snippet(buried, q);
    const firstMatch = buried.slice(0, 400); // what the old behaviour produced
    expect(chosen).toContain('DEAD_EXPORT');
    expect(firstMatch).not.toContain('DEAD_EXPORT');
  });

  it('still returns the opening when nothing matches', () => {
    expect(snippet(buried, expandTerms(['zephyr']))).toContain('task task');
  });

  it('leaves a short memory untouched', () => {
    expect(snippet('a short note', expandTerms(['note']))).toBe('a short note');
  });

  it('retrieves the answer from a very large memory end to end', () => {
    const huge = mem({ kind: 'journal', reason: `Work journal — 2026-08-07 ${buried}` });
    const filler = Array.from({ length: 12 }, (_, i) => mem({ id: `F${i}`, reason: `task ${i}` }));
    const c = buildContext('why was a task rejected for dead_export?', [huge, ...filler], [], NOW);
    expect(c.text).toContain('DEAD_EXPORT');
  });
});
