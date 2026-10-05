import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { workingPatch } from '../git.js';

/*
 * Real repositories, because a mocked `git diff` proves only that the mock was
 * called. Everything this function can get wrong is a property of git: an
 * unborn HEAD, a file the index has never seen, an index left dirty behind it.
 *
 * It must show exactly what `diffStat` counted and what `commitAndPush` will
 * stage — a reviewer reading a different set of changes to the one being pushed
 * is worse than no reviewer, because its approval names work it never read.
 */

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a git process may still hold it on Windows; cleanup must not go red */
    }
  }),
);

const git = (cwd: string) => (...a: string[]) => execa('git', a, { cwd });

async function repoWithCommit(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'wp-'));
  dirs.push(d);
  const g = git(d);
  await g('init', '-q');
  await g('config', 'user.email', 't@t');
  await g('config', 'user.name', 't');
  writeFileSync(join(d, 'base.ts'), 'export const base = 1;\n');
  await g('add', '-A');
  await g('commit', '-q', '-m', 'base');
  return d;
}

const repo = (path: string) => ({ id: 'r', path, branch: 'main' }) as never;

/** What the index holds right now. Empty means workingPatch cleaned up. */
async function staged(dir: string): Promise<string> {
  const { stdout } = await execa('git', ['diff', '--cached', '--name-only'], { cwd: dir });
  return stdout.trim();
}

describe('workingPatch', () => {
  it('shows a modification the gate would have counted', async () => {
    const d = await repoWithCommit();
    writeFileSync(join(d, 'base.ts'), 'export const base = 2;\n');

    const p = await workingPatch(repo(d), ['base.ts']);
    expect(p.text).toContain('-export const base = 1;');
    expect(p.text).toContain('+export const base = 2;');
    expect(p.truncated).toBe(false);
  });

  /*
   * The one git will not show without help: a file the index has never seen is
   * invisible to `git diff HEAD`. `commitAndPush` will commit it regardless, so
   * a reviewer that cannot see new files is reviewing the wrong change — and a
   * new file is what most tasks produce.
   */
  it('shows a file git has never seen before', async () => {
    const d = await repoWithCommit();
    writeFileSync(join(d, 'added.ts'), 'export const added = true;\n');

    const p = await workingPatch(repo(d), ['added.ts']);
    expect(p.text).toContain('added.ts');
    expect(p.text).toContain('+export const added = true;');
  });

  it('reads a repo that has no commits at all', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wp-fresh-'));
    dirs.push(d);
    await git(d)('init', '-q');
    writeFileSync(join(d, 'first.ts'), 'export const first = 1;\n');

    const p = await workingPatch(repo(d), ['first.ts']);
    expect(p.text).toContain('+export const first = 1;');
  });

  /*
   * SEC-8: `--intent-to-add` marks every untracked file, including ones this
   * task never touched. Leaving that behind would make the very next
   * `commitAndPush` sweep unrelated work into the task's commit.
   */
  it('leaves the index exactly as it found it', async () => {
    const d = await repoWithCommit();
    writeFileSync(join(d, 'added.ts'), 'export const added = true;\n');
    writeFileSync(join(d, 'unrelated.ts'), 'export const other = true;\n');

    await workingPatch(repo(d), ['added.ts']);
    expect(await staged(d)).toBe('');
  });

  it('leaves the index clean in a repo with no commits either', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wp-fresh2-'));
    dirs.push(d);
    await git(d)('init', '-q');
    writeFileSync(join(d, 'first.ts'), 'export const first = 1;\n');

    await workingPatch(repo(d), ['first.ts']);
    const { stdout } = await execa('git', ['diff', '--cached', '--name-only'], { cwd: d });
    expect(stdout.trim()).toBe('');
  });

  it('shows only the files the gate accounted for', async () => {
    const d = await repoWithCommit();
    writeFileSync(join(d, 'base.ts'), 'export const base = 2;\n');
    writeFileSync(join(d, 'elsewhere.ts'), 'export const elsewhere = 9;\n');

    const p = await workingPatch(repo(d), ['base.ts']);
    expect(p.text).toContain('base.ts');
    expect(p.text).not.toContain('elsewhere.ts');
  });

  /*
   * ShanAuto's own bookkeeping lives in the target repo. It is excluded from the
   * gate's count and from the commit, so showing it to the reviewer would invite
   * a rejection over a file the task did not write and cannot fix.
   */
  it('never shows ShanAuto its own bookkeeping', async () => {
    const d = await repoWithCommit();
    mkdirSync(join(d, '.shanauto'), { recursive: true });
    writeFileSync(join(d, '.shanauto', 'state.json'), '{"n":1}\n');
    writeFileSync(join(d, 'base.ts'), 'export const base = 2;\n');

    const p = await workingPatch(repo(d), ['.shanauto/state.json', 'base.ts']);
    expect(p.text).not.toContain('state.json');
    expect(p.text).toContain('base.ts');
  });

  it('reports no diff rather than an empty one when nothing changed', async () => {
    const d = await repoWithCommit();
    const p = await workingPatch(repo(d), ['base.ts']);
    expect(p.text).toBe('');
    expect(p.fullLength).toBe(0);
  });

  /*
   * agy is spawned with its prompt in argv and Windows caps that at 32767
   * characters. An oversized patch has to be cut HERE, where the fact can be
   * declared to the reviewer, rather than by the prompt fitter, which would drop
   * the section silently and leave the senior reviewing nothing.
   */
  it('cuts an oversized patch and says how much it cut', async () => {
    const d = await repoWithCommit();
    writeFileSync(join(d, 'big.ts'), Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n'));

    const p = await workingPatch(repo(d), ['big.ts'], 500);
    expect(p.truncated).toBe(true);
    expect(p.text).toHaveLength(500);
    expect(p.fullLength).toBeGreaterThan(500);
  });

  it('does not mark a patch truncated when it fits', async () => {
    const d = await repoWithCommit();
    writeFileSync(join(d, 'base.ts'), 'export const base = 2;\n');

    const p = await workingPatch(repo(d), ['base.ts'], 100000);
    expect(p.truncated).toBe(false);
    expect(p.fullLength).toBe(p.text.length);
  });
});
