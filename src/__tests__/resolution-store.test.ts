import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import * as git from '../git.js';
import type { Repo } from '../schemas.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-resstore-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');
const ledger = await import('../ledger.js');

let dir: string;
let repo: Repo;
const shas: string[] = [];

async function commit(file: string, body: string, msg: string): Promise<string> {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, file), body);
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-m', msg], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sa-resrepo-'));
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
  shas.push(await commit('src/a.ts', 'export const alpha = 1;\n', 'first'));
  shas.push(await commit('src/b.ts', 'export function beta() {}\n', 'second'));
  shas.push(await commit('src/c.ts', 'export const gamma = 3;\n', 'third'));
});

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM task_claims; DELETE FROM tasks;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('claimKey', () => {
  it('is stable regardless of ordering', () => {
    expect(ledger.claimKey(['b.ts', 'a.ts'], ['y', 'x'])).toBe(
      ledger.claimKey(['a.ts', 'b.ts'], ['x', 'y']),
    );
  });

  it('ignores path separator style, so Windows and posix agree', () => {
    expect(ledger.claimKey(['src\\a.ts'], [])).toBe(ledger.claimKey(['src/a.ts'], []));
  });

  it('differs for genuinely different work', () => {
    expect(ledger.claimKey(['a.ts'], ['x'])).not.toBe(ledger.claimKey(['a.ts'], ['z']));
  });
});

describe('claims', () => {
  it('round-trips paths and symbols', () => {
    ledger.saveClaim('T1', 'abc123', ['src/a.ts'], ['alpha']);
    const c = ledger.getClaim('T1')!;
    expect(c.plan_head).toBe('abc123');
    expect(c.paths).toEqual(['src/a.ts']);
    expect(c.symbols).toEqual(['alpha']);
  });

  it('returns null for an unknown task, so callers fail open', () => {
    expect(ledger.getClaim('nope')).toBeNull();
  });

  it('returns null rather than throwing on malformed json', () => {
    ledger.saveClaim('T2', 'abc', [], []);
    ledger.open().prepare("UPDATE task_claims SET paths='{not json' WHERE task_id=?").run('T2');
    expect(ledger.getClaim('T2')).toBeNull();
  });

  it('replaces an earlier claim for the same task', () => {
    ledger.saveClaim('T3', 'h1', ['a.ts'], ['x']);
    ledger.saveClaim('T3', 'h2', ['b.ts'], ['y']);
    expect(ledger.getClaim('T3')!.plan_head).toBe('h2');
  });
});

describe('resolutions', () => {
  it('records provenance and reads back newest first', () => {
    ledger.addResolution({ repo: 'probe', kind: 'external_commit', commit_sha: 'aaa', paths: ['src/a.ts'] });
    ledger.addResolution({ repo: 'probe', kind: 'already_done', reason: 'agent found it present' });
    const rs = ledger.recentResolutions('probe');
    expect(rs).toHaveLength(2);
    expect(rs[0]!.kind).toBe('already_done');
  });

  it('scopes to the requested repo', () => {
    ledger.addResolution({ repo: 'other', kind: 'external_commit', commit_sha: 'zzz' });
    expect(ledger.recentResolutions('probe')).toHaveLength(0);
  });

  it('tracks the last ingested sha so ingestion can resume', () => {
    expect(ledger.lastIngestedSha('probe')).toBeNull();
    ledger.addResolution({ repo: 'probe', kind: 'external_commit', commit_sha: 'sha1' });
    expect(ledger.lastIngestedSha('probe')).toBe('sha1');
  });
});

describe('isKnownCommit', () => {
  it('recognises a sha ShanAuto committed', () => {
    ledger.insertTasks(null, 'probe', [
      {
        title: 't',
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
    const id = ledger.readyTasks('probe')[0]!.id;
    ledger.markCommitted(id, 'deadbeef');
    expect(ledger.isKnownCommit('deadbeef')).toBe(true);
  });

  it('treats an unseen sha as external', () => {
    expect(ledger.isKnownCommit('cafebabe1234')).toBe(false);
  });

  it('is false for an empty sha rather than throwing', () => {
    expect(ledger.isKnownCommit('')).toBe(false);
  });

  /**
   * A commit ShanAuto recorded before a history rewrite will not match anything
   * in the rewritten history, so it ingests as external. Cosmetic only: the
   * staleness check reads paths and symbols, never provenance.
   */
  it('does not match a sha that is absent from current history', () => {
    expect(ledger.isKnownCommit('0000000000000000000000000000000000000000')).toBe(false);
  });
});

describe('git history helpers', () => {
  it('reads current HEAD', async () => {
    expect(await git.headSha(repo)).toBe(shas[2]);
  });

  it('returns null for a repo with no commits', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sa-empty-'));
    await execa('git', ['init', '-b', 'main'], { cwd: empty });
    expect(await git.headSha({ ...repo, path: empty })).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it('lists commits between two shas, oldest first', async () => {
    const cs = await git.commitsBetween(repo, shas[0]!, shas[2]);
    expect(cs.map((c) => c.message)).toEqual(['second', 'third']);
  });

  it('returns the whole history when from is null', async () => {
    expect(await git.commitsBetween(repo, null)).toHaveLength(3);
  });

  it('returns [] for an unreachable sha instead of throwing', async () => {
    await expect(git.commitsBetween(repo, '0000000000000000000000000000000000000000')).resolves.toEqual(
      [],
    );
  });

  it('lists files changed between two shas', async () => {
    expect(await git.changedFilesBetween(repo, shas[0]!, shas[2])).toEqual(
      expect.arrayContaining(['src/b.ts', 'src/c.ts']),
    );
  });

  it('reads a file as it was at a given sha', async () => {
    expect(await git.fileAtSha(repo, shas[0]!, 'src/a.ts')).toContain('alpha');
  });

  it('returns empty for a file that did not exist at that sha', async () => {
    expect(await git.fileAtSha(repo, shas[0]!, 'src/c.ts')).toBe('');
  });
});
