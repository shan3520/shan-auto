import { describe, it, expect } from 'vitest';
import { stashNote } from '../reporter.js';
import type { RunSummary } from '../executor.js';
import type { StashSummary } from '../../git.js';

/*
 * O24 — the pile was named but not explained, 2026-08-31.
 *
 * A rejected task's work survives only as a stash, and example-api held 38 of
 * them. Every single one was called `shanauto-rollback <timestamp>` and nothing
 * else: no task id, no reason. "Restore the newest" was a coin toss over which
 * rejected task you got back, and one of those entries was run 21's real fix
 * for the global-slice bug — thrown away by a rule since narrowed, and found
 * again only by reading diffs.
 *
 * The report already said a pile existed and listed some filenames. What it
 * could not say was which entry was which, and that is the only question
 * anybody asks of a stash list.
 */

const summary = (over: Partial<StashSummary> = {}): RunSummary =>
  ({
    stashes: [
      {
        repo: 'example-api',
        path: 'D:/repos/example-api',
        count: 38,
        files: ['app/services/hybrid_search.py'],
        oldest: '2026-08-08',
        recent: [],
        ...over,
      },
    ],
  }) as unknown as RunSummary;

const entry = (label: string, ref = 'stash@{0}', when = '2026-08-30') => ({ ref, label, when });

describe('what the report says about set-aside work', () => {
  it('still says a pile exists and how old it is', () => {
    const out = stashNote(summary()).join('\n');
    expect(out).toContain('38 set-aside change(s)');
    expect(out).toContain('2026-08-08');
  });

  it('names the most recent entries, so one can be chosen', () => {
    const out = stashNote(
      summary({
        recent: [
          entry('shanauto-rollback 2026-08-30T12:00:00Z — T4uxha4ldlc Implement the add command'),
          entry('shanauto-rollback 2026-08-29T09:00:00Z — Tabc Rank the attention list', 'stash@{1}'),
        ],
      }),
    ).join('\n');

    expect(out).toContain('T4uxha4ldlc');
    expect(out).toContain('Implement the add command');
    expect(out).toContain('stash@{1}');
  });

  it('offers restoring one BY NAME, which is the whole point', () => {
    // `stash pop` with no ref takes the newest. With 38 identical labels that
    // was the only option and it was a guess.
    const out = stashNote(summary({ recent: [entry('shanauto-rollback X — T1 something')] })).join('\n');
    expect(out).toContain('stash pop <ref>');
  });

  it('says nothing extra when the labels could not be read', () => {
    // An older stash list, or a repo git could not read. The pile is still
    // reported; there is simply nothing to choose between.
    const out = stashNote(summary({ recent: [] })).join('\n');
    expect(out).toContain('38 set-aside change(s)');
    expect(out).not.toContain('The most recent');
  });

  it('says nothing at all when there is no pile', () => {
    expect(stashNote({ stashes: [] } as unknown as RunSummary)).toEqual([]);
  });
});
