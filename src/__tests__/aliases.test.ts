import { describe, it, expect } from 'vitest';
import { expandTerms, ALIAS_GROUPS, ALIAS_WEIGHT } from '../core/aliases.js';
import { buildContext, scoreText, terms } from '../core/retrieve.js';
import type { Resolution } from '../ledger.js';

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

describe('expandTerms', () => {
  it('keeps what was typed at full weight', () => {
    const e = expandTerms(['shell']);
    expect(e.find((x) => x.term === 'shell')!.weight).toBe(1);
  });

  it('adds synonyms at a reduced weight', () => {
    const e = expandTerms(['shell']);
    const alias = e.find((x) => x.term === 'terminal')!;
    expect(alias.weight).toBe(ALIAS_WEIGHT);
    expect(alias.weight).toBeLessThan(1);
  });

  it('expands in both directions', () => {
    expect(expandTerms(['terminal']).map((x) => x.term)).toContain('shell');
    expect(expandTerms(['shell']).map((x) => x.term)).toContain('terminal');
  });

  it('leaves an unknown term alone', () => {
    expect(expandTerms(['zephyr'])).toEqual([{ term: 'zephyr', weight: 1 }]);
  });

  it('does not duplicate a term the user already typed', () => {
    const e = expandTerms(['shell', 'terminal']);
    expect(e.filter((x) => x.term === 'terminal')).toHaveLength(1);
    expect(e.find((x) => x.term === 'terminal')!.weight).toBe(1);
  });

  it('caps expansion so a broad question cannot match everything', () => {
    expect(expandTerms(['shell', 'gate', 'agent', 'task', 'memory', 'commit']).length).toBeLessThanOrEqual(40);
  });

  it('has no empty or duplicated entries in the vocabulary', () => {
    for (const g of ALIAS_GROUPS) {
      expect(g.length).toBeGreaterThan(1);
      expect(new Set(g).size).toBe(g.length);
      for (const t of g) expect(t.trim()).toBe(t);
    }
  });
});

describe('scoreText with weighted terms', () => {
  /**
   * The failure this guards against actually happened: at 0.4 each, "terminal
   * subprocess via exec" scored 1.2 and beat "grant shell access" on 1.0 —
   * three inferred matches outranking the word the user typed.
   */
  it('ranks one exact match above any number of synonyms', () => {
    const q = expandTerms(['shell']);
    const exact = scoreText('grant shell access to the agent', q, 0);
    const threeAliases = scoreText('run a terminal subprocess via exec', q, 0);
    const manyAliases = scoreText('terminal subprocess exec execa bash command commands', q, 0);

    expect(exact).toBeGreaterThan(threeAliases);
    expect(exact).toBeGreaterThan(manyAliases);
  });

  it('still ranks more synonyms above fewer', () => {
    const q = expandTerms(['shell']);
    expect(scoreText('terminal subprocess', q, 0)).toBeGreaterThan(scoreText('terminal', q, 0));
  });

  it('still accepts plain strings', () => {
    expect(scoreText('shell access', ['shell'], 0)).toBeGreaterThan(0);
  });
});

describe('retrieval across differently-worded questions', () => {
  const memories = [
    mem({ kind: 'decision', reason: 'Grant agy shell access\nauthorised after risks documented' }),
    mem({ kind: 'external_commit', reason: 'chore: bump the lockfile' }),
  ];

  /** The gap that motivated this: no word in common with what was recorded. */
  it('finds "shell access" when asked about running terminal commands', () => {
    const c = buildContext('can the automation run terminal commands?', memories, [], NOW);
    expect(c.text).toContain('Grant agy shell access');
  });

  it('finds the gate when asked about verification', () => {
    const c = buildContext('what does verification do?', [mem({ kind: 'decision', reason: 'the gate now runs tests' })], [], NOW);
    expect(c.text).toContain('gate');
  });

  it('finds antigravity when asked about agy', () => {
    const c = buildContext('tell me about antigravity', [mem({ kind: 'decision', reason: 'agy was granted access' })], [], NOW);
    expect(c.text).toContain('agy');
  });

  it('does not drag in unrelated memories', () => {
    const c = buildContext('terminal commands', memories, [], NOW);
    expect(c.text).not.toContain('lockfile');
  });

  it('keeps the exact match first when both are present', () => {
    const c = buildContext(
      'shell access',
      [mem({ reason: 'a terminal subprocess ran' }), mem({ reason: 'shell access was granted' })],
      [],
      NOW,
    );
    expect(c.text.split('\n')[0]).toContain('shell access');
  });
});
