import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate } from '../core/verifier.js';
import type { AppConfig } from '../config.js';
import type { DiffStat } from '../git.js';
import type { Repo, TaskRow } from '../schemas.js';

/**
 * The gate itself, driven for real.
 *
 * This file used to define a LOCAL COPY of the command composition and test
 * that. It imported nothing from src/, so it would have passed had the whole
 * source tree been deleted — and when the composition was rewritten on
 * 2026-08-09 the copy kept the old, defective form, still asserting the very
 * `base && task` concatenation that let a task disable the baseline. Six tests
 * named after the system's most important guarantee, none of which could fail.
 *
 * A mutation pass proved the consequence: the CI-workflow protection and the
 * scope cap could BOTH be deleted from gate() with all 529 tests still green.
 * The modules were unit-tested; the gate that composes them was not.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Unique per scratch repo: the dead-export tree cache is keyed by repo.id@HEAD,
// and two scratch repos sharing an id would hand the second the first's cached
// file tree (a stale caller.ts leaking between tests).
let repoSeq = 0;

function scratchRepo(verify_cmd: string): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'gatecfg-'));
  dirs.push(dir);
  repoSeq += 1;
  // A script the baseline can run: exits 1, i.e. the project is broken.
  writeFileSync(join(dir, 'fail.js'), 'process.exit(1)\n');
  writeFileSync(join(dir, 'pass.js'), 'process.exit(0)\n');
  return { id: `g${repoSeq}`, path: dir, branch: 'main', stack: 'ts', verify_cmd, enabled: true, weight: 1 } as Repo;
}

function config(over: Record<string, unknown> = {}): AppConfig {
  return {
    system: {
      timeouts: { verify_s: 30 },
      limits: {
        max_attempts: 2,
        max_files_per_task: 4,
        min_insertions: 3,
        scope_blowout_multiplier: 2,
        forbid_dead_exports: false,
        ...over,
      },
    },
  } as unknown as AppConfig;
}

const task = (verify_cmd = ''): TaskRow => ({ id: 'T1', verify_cmd } as TaskRow);

const diff = (files: string[], insertions = 20): DiffStat =>
  ({ files, insertions, deletions: 0, renames: 0 }) as DiffStat;

describe('the repo baseline is not negotiable', () => {
  it('fails when the repo check fails, whatever the task adds', async () => {
    const repo = scratchRepo('node fail.js');
    const g = await gate(config(), task('node pass.js'), repo, diff(['a.ts']));
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('VERIFY_FAIL');
  });

  it('cannot be switched off by a task command containing ||', async () => {
    /*
     * The defect this file exists for. Concatenated as `base && taskCmd`, a
     * top-level || takes the whole baseline as its left operand:
     *   node fail.js && pytest x.py || true   ->   exit 0
     * `|| true` is an ordinary thing a planner writes.
     */
    const repo = scratchRepo('node fail.js');
    for (const evil of ['node pass.js || true', 'echo x || echo x', 'node pass.js || exit 0']) {
      const g = await gate(config(), task(evil), repo, diff(['a.ts']));
      expect(g.ok, `"${evil}" must not pass a failing baseline`).toBe(false);
    }
  });

  it('cannot be switched off by a task command containing &', async () => {
    const repo = scratchRepo('node fail.js');
    const g = await gate(config(), task('node pass.js & node pass.js'), repo, diff(['a.ts']));
    expect(g.ok).toBe(false);
  });

  it('says WHICH check failed, so the cause is not guesswork', async () => {
    const repo = scratchRepo('node pass.js');
    const g = await gate(config(), task('node fail.js'), repo, diff(['a.ts']));
    expect(g.ok).toBe(false);
    expect(g.detail).toMatch(/task's own check/i);
  });

  it('passes only when both checks pass', async () => {
    const repo = scratchRepo('node pass.js');
    const g = await gate(config(), task('node pass.js'), repo, diff(['a.ts']));
    expect(g.ok).toBe(true);
  });

  it('runs the baseline alone when the task adds nothing', async () => {
    const repo = scratchRepo('node fail.js');
    expect((await gate(config(), task(''), repo, diff(['a.ts']))).ok).toBe(false);
  });
});

describe('paths an agent may never touch', () => {
  /*
   * Deleting this protection from gate() left all 529 tests green, because no
   * test ever reached the check.
   */
  const repo = () => scratchRepo('node pass.js');

  it.each([
    ['.github/workflows/ci.yml', 'CI configuration'],
    ['.gitignore', 'the ignore file'],
    ['.git/config', 'git internals'],
    ['deep/nested/.github/workflows/x.yml', 'a nested workflow'],
  ])('refuses %s (%s)', async (path) => {
    const g = await gate(config(), task(), repo(), diff([path, 'src/ok.ts']));
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('FORBIDDEN_PATH');
  });

  it('allows an ordinary source file', async () => {
    expect((await gate(config(), task(), repo(), diff(['src/a.ts']))).ok).toBe(true);
  });
});

describe('scope caps', () => {
  const repo = () => scratchRepo('node pass.js');

  it('refuses a change sprawling far beyond the file limit', async () => {
    // Cap is max_files_per_task * scope_blowout_multiplier = 8.
    const many = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    const g = await gate(config(), task(), repo(), diff(many));
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('SCOPE_BLOWOUT');
  });

  it('allows a change at the cap', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    expect((await gate(config(), task(), repo(), diff(eight))).ok).toBe(true);
  });

  it('refuses a change too small to be real work', async () => {
    const g = await gate(config(), task(), repo(), diff(['src/a.ts'], 1));
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('TRIVIAL');
  });
});

describe('the size floor does not block a fix to a broken project', () => {
  /*
   * Measured end to end on 2026-08-09. The example-api suite was red. ShanAuto
   * planned the work correctly and agy wrote exactly the right patch — two
   * lines, one in the endpoint and one in the test that asserted the old key.
   * Applied to a clean clone, it turned the failing tests green.
   *
   * The gate threw it away: "TRIVIAL - only 2 insertion(s); below minimum 3".
   * And because the floor is checked BEFORE the verify, it never ran the suite
   * that would have proved the change worked. Two more tasks died the same way
   * in the same run — three agent dispatches and four brain calls spent, nothing
   * committed, and the same tasks left queued to burn the quota again tomorrow.
   *
   * A one-line fix to a broken build is the most valuable change this system can
   * make. The floor made it structurally impossible.
   */
  const repo = () => scratchRepo('node pass.js');

  it('lets a two-line fix through when the project was already failing', async () => {
    const g = await gate(config(), task(), repo(), diff(['app/api/health.py'], 1), false);
    expect(g.ok, 'a red baseline makes the suite going green the proof of work').toBe(true);
  });

  it('still refuses a one-line change on a project that was already passing', async () => {
    // The floor's real purpose: on a green project ANY diff passes the check by
    // default, so size is the only thing between a whitespace edit and a commit.
    const g = await gate(config(), task(), repo(), diff(['src/a.ts'], 1), true);
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('TRIVIAL');
  });

  it('treats an unmeasured baseline as green, which is the cautious direction', async () => {
    const g = await gate(config(), task(), repo(), diff(['src/a.ts'], 1));
    expect(g.failure).toBe('TRIVIAL');
  });

  it('counts deletions too — a replaced line is one in and one out', async () => {
    // "only 2 insertion(s)" was itself an undercount: the patch that was
    // rejected changed two lines, each a replacement, so it read as 2 of a
    // required 3 while touching four lines of the file.
    const d = { files: ['a.ts'], insertions: 2, deletions: 2, renames: 0 } as DiffStat;
    expect((await gate(config(), task(), repo(), d, true)).ok).toBe(true);
  });

  it('a red baseline still cannot get past the repo check itself', async () => {
    // Waiving the floor must not waive the gate. If the suite is still failing
    // after the change, nothing is committed however broken it started.
    const g = await gate(config(), task(), scratchRepo('node fail.js'), diff(['a.ts'], 1), false);
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('VERIFY_FAIL');
  });

  it('a red baseline does not unlock protected paths either', async () => {
    const g = await gate(config(), task(), repo(), diff(['.github/workflows/ci.yml'], 1), false);
    expect(g.failure).toBe('FORBIDDEN_PATH');
  });
});

describe('dead exports — the shipped default', () => {
  /*
   * Every other gate in this file forces forbid_dead_exports: false, which is
   * NOT the shipped default (config/system.yaml has it true). Before this block
   * existed, the DEAD_EXPORT branch had no test that reached it — deleting it
   * from gate() would have left all 529 tests green. A repo's own check is a
   * .js script here, so these two tests are the only ones that exercise the
   * .ts export scan at all.
   */
  it('rejects a new export nothing references', async () => {
    const repo = scratchRepo('node pass.js');
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(join(repo.path, 'src', 'orphan.ts'), 'export function orphan() { return 1; }\n');
    const g = await gate(config({ forbid_dead_exports: true }), task(), repo, diff(['src/orphan.ts']));
    expect(g.ok).toBe(false);
    expect(g.failure).toBe('DEAD_EXPORT');
    expect(g.detail).toMatch(/orphan/);
  });

  it('lets a wired-up export through', async () => {
    const repo = scratchRepo('node pass.js');
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(
      join(repo.path, 'src', 'used.ts'),
      'export function used() { return 1; }\n',
    );
    writeFileSync(
      join(repo.path, 'src', 'caller.ts'),
      'import { used } from "./used.js";\nconsole.log(used());\n',
    );
    const g = await gate(config({ forbid_dead_exports: true }), task(), repo, diff(['src/used.ts']));
    expect(g.ok, 'a symbol referenced from another file is not dead').toBe(true);
  });
});
