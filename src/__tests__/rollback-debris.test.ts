import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepOrphanedArtifacts } from '../git.js';

/*
 * A rolled-back file is supposed to leave no trace. It left a compiled one.
 *
 * `rollback` reverts the paths `diffStat` reports, and `.pyc` is gitignored, so
 * git never reported them and the sweep never happened. Measured in example-api on
 * 2026-08-21: thirteen orphaned `.pyc` files, the oldest from a run two days
 * earlier.
 *
 * Two of zero12's five dispatches then died on them. One found
 * `alembic/versions/__pycache__/0013_search_log_failure_fields.cpython-311.pyc`
 * — a compiled migration, from zero11's reverted attempt, whose NAME promises
 * exactly the columns its brief needed — and burned its entire budget trying to
 * decompile it. The other read `tests/__pycache__/conftest.cpython-311-pytest-
 * 8.3.3.pyc` as proof of a house-style conftest that has never existed in this
 * tree, and went looking for it.
 *
 * A compiled corpse is worse than the source would have been: it cannot be read,
 * only guessed at, and `git status` cannot see it.
 */
const root = mkdtempSync(join(tmpdir(), 'sa-debris-'));

const put = (rel: string, body = 'x') => {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
};

const gone = (rel: string) => !existsSync(join(root, rel));

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('sweeping the debris of a reverted change', () => {
  it('removes the .pyc of a source file the rollback took away', () => {
    put('alembic/versions/__pycache__/0013_search_log_failure_fields.cpython-311.pyc');
    const removed = sweepOrphanedArtifacts(root, ['alembic/versions/0013_search_log_failure_fields.py']);

    expect(gone('alembic/versions/__pycache__/0013_search_log_failure_fields.cpython-311.pyc')).toBe(true);
    // Reported, because an operator reading a rollback line deserves to know a
    // file they never wrote was deleted from their repo.
    expect(removed).toEqual(['alembic/versions/__pycache__/0013_search_log_failure_fields.cpython-311.pyc']);
  });

  /*
   * The one that keeps this from being destructive. Most rolled-back paths are
   * EDITS, not creations: the source is restored to its committed state and its
   * cache entry is stale, not orphaned. Python recompiles a stale entry on the
   * next import; deleting live build output on every rollback is a cost this
   * buys nothing with.
   */
  it('leaves the .pyc alone when the source is still there', () => {
    put('app/api/stats.py', 'def f(): pass');
    put('app/api/__pycache__/stats.cpython-311.pyc');
    expect(sweepOrphanedArtifacts(root, ['app/api/stats.py'])).toEqual([]);
    expect(gone('app/api/__pycache__/stats.cpython-311.pyc')).toBe(false);
  });

  /*
   * Prefix matching would take `conftest_helpers` down with `conftest`, and a
   * sweep that removes a file belonging to a source that still exists is the
   * bug this function exists to fix, pointed the other way.
   */
  it('matches the whole stem, not a prefix of it', () => {
    put('tests/conftest_helpers.py', 'x');
    put('tests/__pycache__/conftest.cpython-311-pytest-8.3.3.pyc');
    put('tests/__pycache__/conftest_helpers.cpython-311.pyc');

    expect(sweepOrphanedArtifacts(root, ['tests/conftest.py'])).toEqual([
      'tests/__pycache__/conftest.cpython-311-pytest-8.3.3.pyc',
    ]);
    expect(gone('tests/__pycache__/conftest_helpers.cpython-311.pyc')).toBe(false);
  });

  it('takes every variant of the same module, since pytest writes its own', () => {
    put('tests/__pycache__/conftest.cpython-311.pyc');
    put('tests/__pycache__/conftest.cpython-311-pytest-8.3.3.pyc');
    expect(sweepOrphanedArtifacts(root, ['tests/conftest.py'])).toHaveLength(2);
  });
});

describe('what the sweep refuses to touch', () => {
  /*
   * The blast radius is the whole point. `rollback` is called on any repo in any
   * stack, and a TypeScript or Go rollback has no business reading, let alone
   * deleting from, a __pycache__ that happens to sit beside it.
   */
  it('ignores a target that is not python at all', () => {
    put('src/__pycache__/git.cpython-311.pyc');
    expect(sweepOrphanedArtifacts(root, ['src/git.ts', 'README.md', 'src/thing.pyc'])).toEqual([]);
    expect(gone('src/__pycache__/git.cpython-311.pyc')).toBe(false);
  });

  it('says nothing about a directory with no cache in it', () => {
    expect(sweepOrphanedArtifacts(root, ['app/api/gone.py'])).toEqual([]);
  });

  it('survives being handed nothing', () => {
    expect(sweepOrphanedArtifacts(root, [])).toEqual([]);
  });

  it('handles a source at the repo root, where there is no directory part', () => {
    put('__pycache__/setup.cpython-311.pyc');
    expect(sweepOrphanedArtifacts(root, ['setup.py'])).toEqual(['__pycache__/setup.cpython-311.pyc']);
  });

  /*
   * `diffStat` reports forward slashes, but this runs on Windows and a path
   * arriving with the platform separator must not silently match nothing —
   * silently doing nothing is exactly how the debris accumulated in the first
   * place.
   */
  it('reads a windows-separated path the same as a git-separated one', () => {
    // Spelled from its char code so the fixture reads as a path rather than as
    // a string escape.
    const bs = String.fromCharCode(92);
    put('alembic/versions/__pycache__/0013_x.cpython-311.pyc');
    const removed = sweepOrphanedArtifacts(root, [['alembic', 'versions', '0013_x.py'].join(bs)]);
    expect(removed).toEqual(['alembic/versions/__pycache__/0013_x.cpython-311.pyc']);
  });
});
