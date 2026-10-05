import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Repo } from '../schemas.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-ingestdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');
const { ingestCommits } = await import('../core/ingest.js');

let dir: string;
let repo: Repo;

async function commit(file: string, body: string, msg: string): Promise<string> {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, file), body);
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-m', msg], { cwd: dir });
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sa-ingestrepo-'));
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  repo = {
    id: 'probe',
    path: dir,
    branch: 'main',
    stack: 'typescript',
    verify_cmd: 'echo ok',
    enabled: true,
    weight: 1,
  };
  await commit('src/a.ts', 'export const alpha = 1;\n', 'add alpha');
  await commit('src/b.ts', 'export function beta() {}\n', 'add beta');
  // amends an existing file: gamma is new, alpha is not
  await commit('src/a.ts', 'export const alpha = 1;\nexport const gamma = 3;\n', 'add gamma');
});

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM task_claims; DELETE FROM tasks;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestCommits', () => {
  it('records every commit in history on a first run', async () => {
    const r = await ingestCommits(repo);
    expect(r.ingested).toBe(3);
    expect(ledger.recentResolutions('probe')).toHaveLength(3);
  });

  /** The whole point: the owner's hand-made commits are invisible to the ledger. */
  it('tags commits the ledger never made as external', async () => {
    await ingestCommits(repo);
    const kinds = ledger.recentResolutions('probe').map((x) => x.kind);
    expect(kinds.every((k) => k === 'external_commit')).toBe(true);
  });

  it('tags a commit ShanAuto made as its own, not external', async () => {
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    ledger.insertTasks(null, 'probe', [
      {
        title: 'ours',
        kind: 'feature',
        instruction: 'do',
        acceptance: 'done',
        files_hint: [],
        verify_cmd: 'echo ok',
        depends_on: [],
        est_lines: 5,
        executor_hint: 'cli',
      },
    ]);
    ledger.markCommitted(ledger.readyTasks('probe')[0]!.id, head);

    await ingestCommits(repo);
    const ours = ledger.recentResolutions('probe').find((x) => x.commit_sha === head);
    expect(ours!.kind).toBe('shanauto_commit');
  });

  it('is idempotent — a second run adds no duplicate rows', async () => {
    await ingestCommits(repo);
    const before = ledger.recentResolutions('probe');

    const second = await ingestCommits(repo);
    const after = ledger.recentResolutions('probe');

    expect(second.ingested).toBe(0);
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((r) => r.commit_sha)).size).toBe(after.length);
  });

  /**
   * The cheap path is resuming from lastIngestedSha, which only tracks
   * external commits. When the newest commits are ShanAuto's own, the resume
   * point sits further back and the range re-includes commits already recorded —
   * so the per-sha guard is what prevents duplicates, not the resume point.
   */
  it('skips commits already recorded when the range re-includes them', async () => {
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    ledger.insertTasks(null, 'probe', [
      {
        title: 'ours',
        kind: 'feature',
        instruction: 'do',
        acceptance: 'done',
        files_hint: [],
        verify_cmd: 'echo ok',
        depends_on: [],
        est_lines: 5,
        executor_hint: 'cli',
      },
    ]);
    ledger.markCommitted(ledger.readyTasks('probe')[0]!.id, head);

    await ingestCommits(repo); // HEAD recorded as shanauto_commit
    const second = await ingestCommits(repo);

    expect(second.ingested).toBe(0);
    expect(second.skipped).toBeGreaterThan(0); // the per-sha guard fired
    expect(ledger.recentResolutions('probe')).toHaveLength(3);
  });

  it('captures the paths each commit touched', async () => {
    await ingestCommits(repo);
    const all = ledger.recentResolutions('probe').flatMap((x) => x.paths);
    expect(all).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });

  it('captures only the symbols a commit newly exported', async () => {
    await ingestCommits(repo);
    const rs = ledger.recentResolutions('probe');

    const gammaCommit = rs.find((x) => x.reason === 'add gamma')!;
    expect(gammaCommit.symbols).toContain('gamma');
    // alpha already existed in the parent, so this commit did not add it
    expect(gammaCommit.symbols).not.toContain('alpha');
  });

  it('treats every symbol in a root commit as newly added', async () => {
    await ingestCommits(repo);
    const first = ledger.recentResolutions('probe').find((x) => x.reason === 'add alpha')!;
    expect(first.symbols).toContain('alpha');
  });

  it('resumes from the last ingested commit rather than rewalking', async () => {
    await ingestCommits(repo);
    await commit('src/d.ts', 'export const delta = 4;\n', 'add delta');

    const r = await ingestCommits(repo);
    expect(r.ingested).toBe(1);
    expect(ledger.recentResolutions('probe')[0]!.symbols).toContain('delta');
  });

  it('does not throw on a repo with no commits', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sa-ingestempty-'));
    await execa('git', ['init', '-b', 'main'], { cwd: empty });
    await expect(ingestCommits({ ...repo, id: 'empty', path: empty })).resolves.toMatchObject({
      ingested: 0,
    });
    rmSync(empty, { recursive: true, force: true });
  });
});
