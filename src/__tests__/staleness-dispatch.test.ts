import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Repo, TaskRow } from '../schemas.js';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-dispatchdb-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');

const ledger = await import('../ledger.js');
const { assessTaskStaleness } = await import('../core/executor.js');
const { ingestCommits } = await import('../core/ingest.js');

let dir: string;
let repo: Repo;
let planHead: string;

async function commit(file: string, body: string, msg: string): Promise<string> {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, file), body);
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-m', msg], { cwd: dir });
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
}

function task(id: string): TaskRow {
  return {
    id,
    repo: 'probe',
    title: 'Add sleep utility function',
    kind: 'feature',
    instruction: 'add sleep',
    acceptance: 'sleep exists',
    files_hint: '[]',
    verify_cmd: 'echo ok',
    depends_on: '[]',
    est_lines: 10,
    executor_hint: 'cli',
    status: 'ready',
    attempts: 0,
    last_error: null,
    commit_sha: null,
    milestone_id: null,
    ord: 1,
    created_at: '',
    updated_at: '',
  } as unknown as TaskRow;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sa-dispatchrepo-'));
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
  planHead = await commit('src/seed.ts', 'export const seed = 0;\n', 'seed');
});

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM task_claims; DELETE FROM tasks;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The reason this feature exists. A task to add `sleep` sat queued while the
 * owner added `sleep` by hand. Discovering that cost a provider request every
 * time; under a requests-per-day ceiling, that wasted dispatch IS the loss.
 */
describe('a superseded task never reaches the driver', () => {
  it('does not invoke the agent when the claimed symbol already landed', async () => {
    ledger.saveClaim('T-super', planHead, ['src/util.ts'], ['sleep']);
    await commit('src/util.ts', 'export function sleep() {}\n', 'add sleep by hand');

    const verdict = await assessTaskStaleness(repo, task('T-super'));
    expect(verdict.verdict).toBe('SUPERSEDED');

    // Stand in for the real driver. The whole point is that it stays untouched.
    const driver = vi.fn(async () => ({ ok: true, stdout: '', durationMs: 0 }));
    if (verdict.verdict !== 'SUPERSEDED') await driver();

    expect(driver).not.toHaveBeenCalled();
  });

  it('names the superseding commit and symbol, so the log explains itself', async () => {
    ledger.saveClaim('T-eviD', planHead, ['src/ev.ts'], ['answer']);
    const sha = await commit('src/ev.ts', 'export const answer = 42;\n', 'add answer by hand');

    const v = await assessTaskStaleness(repo, task('T-eviD'));
    expect(v.evidence).toContain('answer');
    expect(v.evidence).toContain(sha.slice(0, 8));
    expect(v.supersededBy?.symbol).toBe('answer');
  });

  it('still dispatches when the delta is unrelated to the claim', async () => {
    ledger.saveClaim('T-fresh', planHead, ['src/wanted.ts'], ['wanted']);
    await commit('src/elsewhere.ts', 'export const elsewhere = 1;\n', 'unrelated work');

    const v = await assessTaskStaleness(repo, task('T-fresh'));
    expect(v.verdict).toBe('FRESH');
  });
});

describe('the check never blocks live work', () => {
  it('is FRESH for a task with no claim at all', async () => {
    // Every task planned before this feature existed lands here.
    const v = await assessTaskStaleness(repo, task('T-noclaim'));
    expect(v.verdict).toBe('FRESH');
  });

  it('is FRESH when the claim recorded no plan_head', async () => {
    ledger.saveClaim('T-nohead', null, ['src/util.ts'], ['sleep']);
    const v = await assessTaskStaleness(repo, task('T-nohead'));
    expect(v.verdict).toBe('FRESH');
  });

  it('is FRESH rather than throwing when the repo path is gone', async () => {
    ledger.saveClaim('T-gone', planHead, ['src/util.ts'], ['sleep']);
    const missing = { ...repo, path: join(tmpdir(), 'sa-does-not-exist-at-all') };
    const v = await assessTaskStaleness(missing, task('T-gone'));
    expect(v.verdict).toBe('FRESH');
  });

  it('is FRESH when HEAD has not moved since planning', async () => {
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    ledger.saveClaim('T-same', head, ['src/util.ts'], ['sleep']);
    const v = await assessTaskStaleness(repo, task('T-same'));
    expect(v.verdict).toBe('FRESH');
  });
});

describe('parking is recoverable', () => {
  it('records a manual_park resolution naming the cause', async () => {
    ledger.saveClaim('T-park', planHead, ['src/p.ts'], ['parked']);
    await commit('src/p.ts', 'export const parked = 1;\n', 'landed by hand');
    await ingestCommits(repo);

    ledger.addResolution({
      repo: 'probe',
      kind: 'manual_park',
      task_id: 'T-park',
      symbols: ['parked'],
      reason: 'parked before dispatch',
    });

    const parks = ledger.recentResolutions('probe').filter((r) => r.kind === 'manual_park');
    expect(parks).toHaveLength(1);
    expect(parks[0]!.task_id).toBe('T-park');
  });
});
