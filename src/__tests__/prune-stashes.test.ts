import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { pruneRollbackStashes } from '../core/prune.js';
import { dropStashBySha, rollbackStashes } from '../git.js';
import type { Repo } from '../schemas.js';

/*
 * Rollback stashes, let go of on a schedule.
 *
 * Every gate rejection stashes the agent's work before reverting it, and nothing
 * ever gave any back: 43 in one project in three weeks, and six more within
 * three hours of clearing them by hand on 2026-08-27. These run against REAL git
 * repositories, because every property worth testing here is a property of git:
 * what a stash label reads back as, and which stash a position points at after
 * another one is pushed.
 */

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a failed temp cleanup must never turn the suite red */
    }
  }),
);

async function repo(id = 'project'): Promise<Repo> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-stash-'));
  dirs.push(dir);
  const g = (...a: string[]) => execa('git', a, { cwd: dir });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@t');
  await g('config', 'user.name', 't');
  await g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'base');
  return { id, path: dir, branch: 'main' } as unknown as Repo;
}

let n = 0;
/** Push a stash with exactly this message, holding one fresh untracked file. */
async function stash(r: Repo, message: string): Promise<string> {
  const g = (...a: string[]) => execa('git', a, { cwd: r.path });
  writeFileSync(join(r.path, `f${++n}.txt`), `${message}\n`);
  await g('stash', 'push', '-u', '-q', '-m', message);
  return (await g('rev-parse', 'stash@{0}')).stdout.trim();
}

async function shas(r: Repo): Promise<string[]> {
  const { stdout } = await execa('git', ['stash', 'list', '--format=%H'], { cwd: r.path });
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

const NOW = new Date('2026-10-05T09:00:00Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
/** A label exactly as rollback writes it, optionally with O24's suffix. */
const rb = (daysAgo: number, why = '') => `shanauto-rollback ${iso(daysAgo)}${why ? ` — ${why}` : ''}`;

describe('pruning rollback stashes', () => {
  it('keeps everything when the window is 0, which is the default', async () => {
    const r = await repo();
    const old = await stash(r, rb(400));

    const res = await pruneRollbackStashes([r], 0, { now: NOW });

    expect(res.enabled).toBe(false);
    expect(res.removed).toEqual([]);
    expect(await shas(r)).toEqual([old]);
  });

  it('drops a rollback older than the window and keeps a recent one', async () => {
    const r = await repo();
    const old = await stash(r, rb(30));
    const recent = await stash(r, rb(2));

    const res = await pruneRollbackStashes([r], 14, { now: NOW });

    expect(res.removed.map((e) => e.sha)).toEqual([old]);
    expect(res.kept).toBe(1);
    expect(await shas(r)).toEqual([recent]);
  });

  /*
   * O24 put the task and the verdict on the end of the label on 2026-08-31, and
   * the stashes taken before that have no suffix. Both shapes are in the wild.
   * A matcher that only knew one would silently keep the other forever.
   */
  it('recognises the labels written since O24, with the task and verdict on the end', async () => {
    const r = await repo();
    const old = await stash(r, rb(30, "T4uxha4ldlc VERIFY_FAIL - the repo's own check failed"));

    const res = await pruneRollbackStashes([r], 14, { now: NOW });

    expect(res.removed.map((e) => e.sha)).toEqual([old]);
    expect(await shas(r)).toEqual([]);
  });

  /*
   * ensureClean takes an autostash from a dirty tree BEFORE a task runs, so it
   * can hold the owner's own unsaved work — two of their scripts, in one real
   * project, swept up on 2026-08-12. Age says nothing about whether that is
   * safe to lose.
   */
  it("never touches an autostash, however old: it can hold the owner's own work", async () => {
    const r = await repo();
    const owners = await stash(r, 'shanauto-autostash-1786129913329');
    const old = await stash(r, rb(30));

    const res = await pruneRollbackStashes([r], 1, { now: NOW });

    expect(res.removed.map((e) => e.sha)).toEqual([old]);
    expect(await shas(r)).toEqual([owners]);
  });

  it("never touches the owner's own stashes, even one that mentions the name", async () => {
    const r = await repo();
    const mine = [
      await stash(r, `notes on shanauto-rollback ${iso(400)}`),
      await stash(r, `${rb(400)}x`),
      await stash(r, 'wip'),
    ];

    const res = await pruneRollbackStashes([r], 1, { now: NOW });

    expect(res.removed).toEqual([]);
    expect((await shas(r)).sort()).toEqual([...mine].sort());
  });

  it('--dry-run names what would go and drops nothing', async () => {
    const r = await repo();
    const old = await stash(r, rb(30));

    const res = await pruneRollbackStashes([r], 14, { dryRun: true, now: NOW });

    expect(res.removed.map((e) => e.sha)).toEqual([old]);
    expect(await shas(r)).toEqual([old]);
  });

  it('keeps a stash dated in the future rather than reading it as ancient', async () => {
    const r = await repo();
    const skewed = await stash(r, rb(-3));

    const res = await pruneRollbackStashes([r], 1, { now: NOW });

    expect(res.removed).toEqual([]);
    expect(await shas(r)).toEqual([skewed]);
  });

  it('reports a repo it cannot read, and still sweeps the rest', async () => {
    const gone = { id: 'gone', path: join(tmpdir(), 'sa-no-such-repo-q7x'), branch: 'main' } as unknown as Repo;
    const r = await repo('live');
    const old = await stash(r, rb(30));

    const res = await pruneRollbackStashes([gone, r], 14, { now: NOW });

    expect(res.errors.some((e) => e.startsWith('gone:'))).toBe(true);
    expect(res.removed.map((e) => e.sha)).toEqual([old]);
  });
});

describe('dropping a stash by identity', () => {
  /*
   * The failure this exists to prevent. `git stash drop` takes a POSITION, and
   * every push shifts every older stash down one. Read the list, let a run push
   * one stash, then drop by the position read earlier — and the stash at that
   * position is now the newer neighbour. Here that neighbour is an autostash:
   * the owner's own work, deleted by a sweep that only ever meant to touch
   * ShanAuto's.
   */
  it('drops the stash it read, not whatever has slid into its old position', async () => {
    const r = await repo();
    await stash(r, rb(30));
    const [victim] = await rollbackStashes(r);
    expect(victim!.ref).toBe('stash@{0}');

    // A run pushes one in between. The victim is now stash@{1}.
    const owners = await stash(r, 'shanauto-autostash-1786999999999');
    const { stdout: atOldPosition } = await execa('git', ['rev-parse', victim!.ref], { cwd: r.path });
    expect(atOldPosition.trim()).toBe(owners); // what a position-based drop would have hit

    expect(await dropStashBySha(r, victim!.sha)).toBe(true);
    expect(await shas(r)).toEqual([owners]);
  });

  it('leaves alone a stash that is no longer there, rather than guessing', async () => {
    const r = await repo();
    const keep = await stash(r, rb(30));

    expect(await dropStashBySha(r, '0'.repeat(40))).toBe(false);
    expect(await shas(r)).toEqual([keep]);
  });
});
