import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { diffStat, commitAndPush, splitRename, rollback } from '../git.js';
import type { Repo } from '../schemas.js';

/**
 * The two guarantees this whole system rests on, both of which were bypassable
 * until 2026-08-09 and neither of which any existing test would have caught.
 *
 *   1. Nothing is committed unless the repo's own check passes.
 *   2. A commit contains only the files the gate inspected.
 *
 * These drive real git repositories rather than mocks, because both faults lived
 * in what git actually does — not in what the code appeared to say.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function repoWith(files: Record<string, string>): Promise<Repo> {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  dirs.push(dir);
  const git = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
  await git('init', '-q');
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  await git('add', '-A');
  await git('commit', '-qm', 'init');
  return { id: 'g', path: dir, branch: 'main', verify_cmd: 'echo ok' } as unknown as Repo;
}

describe('the gate can see deletions', () => {
  /*
   * `git add -A --intent-to-add .` was used to reveal untracked files. `-A`
   * also STAGES deletions for real, and the next call read the unstaged diff —
   * so every deletion vanished from the gate's view. The line meant to make it
   * see more is what made it see less.
   */
  it('reports a deleted file', async () => {
    const repo = await repoWith({ 'keep.ts': 'a\n', 'gone.ts': 'b\n' });
    rmSync(join(repo.path, 'gone.ts'));

    const d = await diffStat(repo);
    expect(d.files).toContain('gone.ts');
    expect(d.deletions).toBeGreaterThan(0);
  });

  it('reports a deletion alongside an addition', async () => {
    // The shape of a "move": the destination was always visible, the source was
    // not — which is why a copy was indistinguishable from a move.
    const repo = await repoWith({ 'old.ts': 'x\n' });
    rmSync(join(repo.path, 'old.ts'));
    writeFileSync(join(repo.path, 'new.ts'), 'x\n');

    const d = await diffStat(repo);
    // git reports a true move as a rename; both sides must come back as paths.
    expect(d.files.sort()).toEqual(['new.ts', 'old.ts']);
  });

  it('counts deleted files toward the scope it reports', async () => {
    // 46 deletions once passed a cap of 8, because they counted as zero.
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.ts`] = 'x\n';
    const repo = await repoWith(files);
    for (let i = 0; i < 10; i++) rmSync(join(repo.path, `f${i}.ts`));

    expect((await diffStat(repo)).files).toHaveLength(10);
  });

  it('still sees untracked files, which is why the intent-to-add is there', async () => {
    const repo = await repoWith({ 'a.ts': 'a\n' });
    writeFileSync(join(repo.path, 'brand-new.ts'), 'new\n');
    expect((await diffStat(repo)).files).toContain('brand-new.ts');
  });
});

describe('a commit contains only what the gate inspected', () => {
  /*
   * `git commit <msg>` writes the whole INDEX, and diffStat's own `git add -A`
   * had already staged every deletion into it. Measured: the gate authorised one
   * file and the commit contained four, deleting .github/workflows/ci.yml — a
   * path the gate refuses to let an agent EDIT.
   */
  it('does not smuggle in deletions the gate did not authorise', async () => {
    const repo = await repoWith({ 'ci.yml': 'ci\n', 'old.ts': 'x\n' });
    rmSync(join(repo.path, 'ci.yml'));
    rmSync(join(repo.path, 'old.ts'));
    writeFileSync(join(repo.path, 'new.ts'), 'new\n');

    // diffStat runs first in the real flow, and stages things as a side effect.
    await diffStat(repo);
    await commitAndPush(repo, 'only new.ts', ['new.ts']);

    const show = await execa('git', ['show', '--name-status', '--format=', 'HEAD'], {
      cwd: repo.path,
    });
    expect(show.stdout).toContain('new.ts');
    expect(show.stdout).not.toContain('ci.yml');
    expect(show.stdout).not.toContain('old.ts');
  });

  it('leaves the unauthorised changes in the worktree rather than committing them', async () => {
    // They are still wrong, but they are visible and recoverable — not buried
    // inside an automated commit under someone else's message.
    const repo = await repoWith({ 'other.ts': 'x\n' });
    writeFileSync(join(repo.path, 'other.ts'), 'edited by someone else\n');
    writeFileSync(join(repo.path, 'mine.ts'), 'mine\n');

    await diffStat(repo);
    await commitAndPush(repo, 'only mine', ['mine.ts']);

    const status = await execa('git', ['status', '--porcelain'], { cwd: repo.path });
    expect(status.stdout).toContain('other.ts');
  });
});

describe('rename notation is expanded into real paths', () => {
  /*
   * Once deletions became visible, a true move stopped being two entries and
   * became one: "old.ts => new.ts". That is not a path — it matches nothing as a
   * pathspec, and no forbidden-path rule could ever match it, so a rename INTO a
   * protected path would have gone straight through.
   */
  it('splits a simple rename', () => {
    expect(splitRename('old.ts => new.ts').sort()).toEqual(['new.ts', 'old.ts']);
  });

  it('splits the braced form git uses when a prefix is shared', () => {
    expect(splitRename('src/{core => tui}/a.ts').sort()).toEqual(['src/core/a.ts', 'src/tui/a.ts']);
  });

  it('exposes a rename into a protected path, rather than hiding it', () => {
    // The whole point: `.github/workflows/ci.yml` must be checkable as a name.
    expect(splitRename('src/x.ts => .github/workflows/ci.yml')).toContain(
      '.github/workflows/ci.yml',
    );
  });

  it('leaves an ordinary path untouched', () => {
    expect(splitRename('src/a.ts')).toEqual(['src/a.ts']);
  });

  it('does not invent a second path when both sides are equal', () => {
    expect(splitRename('a.ts => a.ts')).toEqual(['a.ts']);
  });
});

describe('a rollback never destroys work outright', () => {
  /*
   * A task may run for 15 minutes, and `diffStat` reports anything written in
   * the repo during that window exactly as if the agent had written it — there
   * is no way to tell the agent's work from the owner's. Rollback used to
   * `rmSync` untracked files and `git checkout` tracked ones: both permanent.
   * Measured — a note the owner made while a task ran was deleted, with no
   * stash and no way back.
   *
   * It cannot know whose work it is, so it must stop being able to lose it.
   */
  it('keeps a reverted file recoverable in a stash', async () => {
    const repo = await repoWith({ 'mine.md': 'original\n' });
    writeFileSync(join(repo.path, 'mine.md'), 'what I typed while it ran\n');
    writeFileSync(join(repo.path, 'note.md'), 'a file I just made\n');

    await rollback(repo, ['mine.md', 'note.md']);

    const list = await execa('git', ['stash', 'list'], { cwd: repo.path });
    expect(list.stdout).toContain('shanauto-rollback');
  });

  it('puts the working tree back, which is the point of rolling back', async () => {
    const repo = await repoWith({ 'a.ts': 'original\n' });
    writeFileSync(join(repo.path, 'a.ts'), 'agent edit\n');
    await rollback(repo, ['a.ts']);
    expect(readFileSync(join(repo.path, 'a.ts'), 'utf8')).toContain('original');
  });

  it('restores an untracked file the owner made, when they pop the stash', async () => {
    const repo = await repoWith({ 'a.ts': 'x\n' });
    writeFileSync(join(repo.path, 'my-notes.md'), 'do not lose this\n');
    await rollback(repo, ['my-notes.md']);
    expect(existsSync(join(repo.path, 'my-notes.md'))).toBe(false);

    await execa('git', ['stash', 'pop'], { cwd: repo.path, reject: false });
    expect(readFileSync(join(repo.path, 'my-notes.md'), 'utf8')).toContain('do not lose this');
  });
});

describe('the rollback stash engages on the path that matters', () => {
  /*
   * The first version of this fix did not work, and the test did not notice
   * because it mocked simple-git and asserted `stash push` was CALLED.
   *
   * Against real git it always FAILED whenever an untracked file was in the
   * pathspec — `diffStat` runs `git add -A --intent-to-add .` moments earlier,
   * and git refuses to stash such an entry ("Entry 'x' not uptodate"). So the
   * safety net engaged only for tracked files, which were already recoverable
   * from HEAD, and the destructive fallback ran for exactly the files that
   * could not be recovered.
   *
   * These drive the real flow — diffStat, then rollback — because that ordering
   * is the bug.
   */
  it('keeps an untracked file after a real diffStat, which is what broke', async () => {
    const repo = await repoWith({ 'tracked.txt': 'original\n' });
    writeFileSync(join(repo.path, 'tracked.txt'), 'agent edit\n');
    writeFileSync(join(repo.path, 'MY-NOTES.md'), 'the owner typed this\n');

    await diffStat(repo); // stages the untracked file with --intent-to-add
    await rollback(repo, ['tracked.txt', 'MY-NOTES.md']);

    const list = await execa('git', ['stash', 'list'], { cwd: repo.path });
    expect(list.stdout, 'the stash must actually be created').toContain('shanauto-rollback');

    await execa('git', ['stash', 'pop'], { cwd: repo.path, reject: false });
    expect(readFileSync(join(repo.path, 'MY-NOTES.md'), 'utf8')).toContain('the owner typed this');
  });

  it('keeps an untracked file even when the whole change is new files', async () => {
    const repo = await repoWith({ 'a.ts': 'x\n' });
    writeFileSync(join(repo.path, 'one.md'), 'first\n');
    writeFileSync(join(repo.path, 'two.md'), 'second\n');

    await diffStat(repo);
    await rollback(repo, ['one.md', 'two.md']);

    const list = await execa('git', ['stash', 'list'], { cwd: repo.path });
    expect(list.stdout).toContain('shanauto-rollback');
  });

  it('reverts the tracked file as well, so the tree is genuinely clean', async () => {
    const repo = await repoWith({ 'a.ts': 'original\n' });
    writeFileSync(join(repo.path, 'a.ts'), 'agent edit\n');
    writeFileSync(join(repo.path, 'new.md'), 'new\n');

    await diffStat(repo);
    await rollback(repo, ['a.ts', 'new.md']);

    expect(readFileSync(join(repo.path, 'a.ts'), 'utf8')).toContain('original');
    expect(existsSync(join(repo.path, 'new.md'))).toBe(false);
  });
});
