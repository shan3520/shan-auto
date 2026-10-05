import { describe, it, expect } from 'vitest';
import { isDefinitionOnly, dedupe, isUncheckedRemoval, phantomRoot } from '../core/planner.js';
import type { NormalizedTask } from '../schemas.js';

function task(over: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    title: 'do a thing',
    kind: 'feature',
    instruction: 'implement the thing properly',
    acceptance: 'the thing works',
    files_hint: [],
    verify_cmd: 'npm test',
    depends_on: [],
    est_lines: 10,
    executor_hint: 'cli',
    ...over,
  };
}

/**
 * Cases taken verbatim from the 2026-08-06 run, where the planner split features
 * into declaration / helper / test and never scheduled the task that used any of
 * it. Two thirds of that day's commits were code nothing called.
 */
describe('isDefinitionOnly', () => {
  it('rejects the real declaration-only tasks that caused the problem', () => {
    const real = [
      'Define RetryConfig schema',
      'Define PacingConfig schema',
      'Add RecentCommit interface to schemas.ts',
      'Add DailyCommitCount schema',
      'Define CSV_HEADER and TaskRowToCsv type',
      'Export resetTaskStatus signature in ledger',
    ];
    for (const title of real) {
      expect(isDefinitionOnly(task({ title, est_lines: 8 })), title).toBe(true);
    }
  });

  it('allows a declaration that is also wired in', () => {
    expect(
      isDefinitionOnly(
        task({
          title: 'Add PacingConfig type and use it in the executor',
          instruction: 'declare the type and read it from runBatch',
          est_lines: 12,
        }),
      ),
    ).toBe(false);
  });

  it('allows a declaration task whose instruction wires it in', () => {
    expect(
      isDefinitionOnly(
        task({
          title: 'Define RetryConfig schema',
          instruction: 'Declare RetryConfig, then integrate it into OpenCodeBrain.once()',
          est_lines: 10,
        }),
      ),
    ).toBe(false);
  });

  it('allows substantial work that merely mentions a schema', () => {
    expect(
      isDefinitionOnly(
        task({ title: 'Add schema validation to the planner', est_lines: 45 }),
      ),
    ).toBe(false);
  });

  it('does not flag ordinary feature or test work', () => {
    for (const title of [
      'Implement exportLedgerToCsv file writer',
      'Add git rollback tests',
      'Refactor git.ts error handling wrapper',
      'Add test script to package.json',
      'Document git module',
    ]) {
      expect(isDefinitionOnly(task({ title })), title).toBe(false);
    }
  });
});

/**
 * Title similarity alone is too blunt for any job whose steps are deliberately
 * named alike. "Relocate logging module to app/core" and "Relocate health
 * module to app/core" share four words of six — 0.67, over the 0.6 threshold —
 * so a real consolidation lost most of its steps to a check meant to catch
 * restated work.
 */
describe('dedupe distinguishes same-shaped work on different files', () => {
  const task = (title: string, files: string[]) =>
    ({
      title,
      kind: 'refactor',
      instruction: 'move it',
      acceptance: 'tests pass',
      files_hint: files,
      verify_cmd: 'pytest -q',
      depends_on: [],
      est_lines: 20,
      executor_hint: 'cli',
      claim: { paths: files, symbols: [] },
    }) as NormalizedTask;

  it('keeps two similarly-named tasks that touch different files', () => {
    const known = [{ title: 'Relocate logging module to app/core', paths: ['src/core/logging.py'] }];
    const out = dedupe([task('Relocate health module to app/core', ['src/core/health.py'])], known);
    expect(out).toHaveLength(1);
  });

  it('still drops a restatement of the same work on the same file', () => {
    const known = [{ title: 'Relocate logging module to app/core', paths: ['src/core/logging.py'] }];
    const out = dedupe([task('Relocate the logging module into app/core', ['src/core/logging.py'])], known);
    expect(out).toHaveLength(0);
  });

  it('falls back to the title verdict when files are unknown', () => {
    // The old behaviour, and the safe direction: with nothing to compare, a
    // title clash is still treated as a duplicate.
    const out = dedupe([task('Relocate logging module to app/core', [])], [
      { title: 'Relocate logging module to app/core', paths: [] },
    ]);
    expect(out).toHaveLength(0);
  });

  it('accepts a plain list of titles, as before', () => {
    const out = dedupe([task('Add health endpoint', ['a.py'])], ['Add health endpoint']);
    expect(out).toHaveLength(0);
  });

  it('separates each step of a multi-module move', () => {
    const steps = [
      task('Relocate logging module to app/core', ['src/core/logging.py']),
      task('Relocate config module to app/core', ['src/core/config.py']),
      task('Relocate health module to app/core', ['src/core/health.py']),
    ];
    expect(dedupe(steps, [])).toHaveLength(3);
  });
});

/**
 * On 2026-08-08 a seven-task consolidation committed 7 of 7, copied instead of
 * moved, and left six files in both src/ and app/. Every commit passed: dead
 * code compiles, and the tests imported the new copy. The gate verifies that
 * what exists works — it cannot notice that what should be gone is still there.
 */
describe('isUncheckedRemoval', () => {
  const t = (over: Partial<NormalizedTask>) =>
    ({
      title: 'Remove legacy src directory',
      kind: 'refactor',
      instruction: 'delete it',
      acceptance: 'src is gone',
      files_hint: ['src/main.py'],
      verify_cmd: 'python -m pytest',
      depends_on: [],
      est_lines: 10,
      executor_hint: 'cli',
      claim: { paths: ['src/main.py'], symbols: [] },
      ...over,
    }) as NormalizedTask;

  it('rejects a removal whose check is only the default build', () => {
    expect(isUncheckedRemoval(t({}))).toBe(true);
  });

  it('accepts a removal that names the path it removes', () => {
    const v = 'python -c "import os,sys; sys.exit(1 if os.path.exists(\'src\') else 0)"';
    expect(isUncheckedRemoval(t({ verify_cmd: v }))).toBe(false);
  });

  it('treats a MOVE the same way — a move that only checks the destination is a copy', () => {
    expect(isUncheckedRemoval(t({ title: 'Relocate logging module to app/core' }))).toBe(true);
    expect(
      isUncheckedRemoval(
        t({
          title: 'Relocate logging module to app/core',
          files_hint: ['src/core/logging.py'],
          claim: { paths: ['src/core/logging.py'], symbols: [] },
          verify_cmd: 'test ! -f src/core/logging.py && pytest -q',
        }),
      ),
    ).toBe(false);
  });

  it('leaves ordinary feature work alone', () => {
    expect(isUncheckedRemoval(t({ title: 'Add health endpoint', kind: 'feature' }))).toBe(false);
  });

  it('fires when the task names no paths to check against', () => {
    /*
     * This test asserted the opposite until 2026-08-15. "Nothing named to check
     * against" was read as nothing to complain about, which made naming no paths
     * the cheapest way past the guard: a task proposing to delete something that
     * cannot say what is the least verifiable task there is. No task in the
     * ledger has ever taken that escape — all ten name paths — so this closes a
     * hole rather than changing any observed behaviour.
     */
    expect(isUncheckedRemoval(t({ files_hint: [], claim: { paths: [], symbols: [] } }))).toBe(true);
  });

  it('ignores short path segments that would match almost anything', () => {
    // "src/a.py" -> only "a" is short; the check must not pass on a stray "a".
    const x = t({ files_hint: ['src/a.py'], claim: { paths: ['src/a.py'], symbols: [] }, verify_cmd: 'pytest -q' });
    expect(isUncheckedRemoval(x)).toBe(true);
  });
});

/**
 * The real example-api roots, from `git ls-files` on 2026-08-14. Note there is no
 * `src` — it exists on disk but is untracked, which is precisely why this check
 * reads git rather than the filesystem.
 */
const RAGFORGE = new Set([
  '.env.example',
  '.gitignore',
  'agents.md',
  'readme.md',
  'alembic',
  'alembic.ini',
  'app',
  'docs',
  'tests',
]);

const PY_GATE = 'python -m compileall -q -x "(node_modules|[.]venv|[.]next)" . && python -m pytest -q';

describe('phantomRoot', () => {
  /*
   * The four tasks from the 2026-08-13 run that the repo's own check could never
   * have failed: they write .tsx files into a Python repo, and compileall+pytest
   * pass whether or not a single line was written. Two of them reached an agent
   * and burned quota before dying on a path that was never there.
   */
  it('rejects the real frontend tasks planned into a repo with no frontend', () => {
    const real: [string, string[]][] = [
      ['Filter DocumentList view based on GroupSidebar selection',
        ['frontend/src/components/GroupSidebar.tsx', 'frontend/src/components/DocumentList.tsx']],
      ['Add group selection dropdown to DocumentUpload component',
        ['frontend/src/components/DocumentUpload.tsx', 'frontend/src/components/DocumentUpload.test.tsx']],
      ['Implement Create Group modal in Sidebar',
        ['frontend/src/components/GroupSidebar.tsx', 'frontend/src/components/GroupSidebar.test.tsx']],
      ['Create Group Sidebar component with list fetch',
        ['frontend/src/components/GroupSidebar.tsx', 'frontend/src/app/layout.tsx']],
    ];
    for (const [title, files_hint] of real) {
      expect(phantomRoot(task({ title, files_hint, verify_cmd: PY_GATE }), RAGFORGE), title).toBe(
        'frontend',
      );
    }
  });

  it('admits the one frontend task whose check actually names the new path', () => {
    // The same phantom directory, but this verify_cmd fails if the file is not
    // written — so the work is checkable and is allowed to proceed.
    const t = task({
      title: 'Add group context selector to SearchBar and API call',
      files_hint: ['frontend/src/components/SearchBar.tsx'],
      verify_cmd:
        `node -e "const fs=require('fs'); process.exit(fs.readFileSync('frontend/src/components/SearchBar.tsx', 'utf8').includes('group_id') ? 0 : 1)"`,
    });
    expect(phantomRoot(t, RAGFORGE)).toBeNull();
  });

  it('leaves the real backend tasks from the same run alone', () => {
    const real = [
      ['app/services/document_search.py', 'tests/services/test_document_search.py'],
      ['app/api/documents.py', 'tests/api/test_documents.py'],
      ['app/api/groups.py', 'tests/api/test_groups.py'],
    ];
    for (const files_hint of real) {
      expect(phantomRoot(task({ files_hint, verify_cmd: PY_GATE }), RAGFORGE), files_hint[0]).toBeNull();
    }
  });

  it('allows a new directory alongside work in one that exists', () => {
    const t = task({ files_hint: ['frontend/x.tsx', 'app/api/y.py'], verify_cmd: PY_GATE });
    expect(phantomRoot(t, RAGFORGE)).toBeNull();
  });

  it('does not strip the leading dot off a real dotfile root', () => {
    expect(phantomRoot(task({ files_hint: ['.env.example'] }), RAGFORGE)).toBeNull();
    expect(phantomRoot(task({ files_hint: ['./app/api/x.py'] }), RAGFORGE)).toBeNull();
  });

  it('treats an unknown tree as "cannot tell", not as "reject everything"', () => {
    // A fresh repo has no tracked files. Rejecting every path there would stop
    // the system ever planning the first commit.
    expect(phantomRoot(task({ files_hint: ['anything/at/all.py'] }), new Set())).toBeNull();
  });

  it('does not fire when the task names no paths', () => {
    expect(phantomRoot(task({ files_hint: [] }), RAGFORGE)).toBeNull();
  });

  it('is case-insensitive about the root', () => {
    expect(phantomRoot(task({ files_hint: ['App/api/x.py'] }), RAGFORGE)).toBeNull();
  });
});
