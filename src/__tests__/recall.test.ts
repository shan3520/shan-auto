import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const dbDir = mkdtempSync(join(tmpdir(), 'sa-recalldb-'));
const DB = join(dbDir, 'test.db');
process.env.SHANAUTO_DB = DB;
const ledger = await import('../ledger.js');

const repoRoot = resolve(import.meta.dirname, '..', '..');
/*
 * The test's OWN killswitch, in a temp directory.
 *
 * This used to write the real one at state/KILLSWITCH and delete it in
 * teardown, so a crash or timeout in between left the owner's system paused by
 * a test run. A test must never be able to change how the machine behaves after
 * it finishes.
 */
const KILLSWITCH = join(dbDir, 'KILLSWITCH');
/*
 * `state/` is gitignored, so it exists here and in no fresh checkout. This test
 * wrote into it and passed only on a machine that had already run the system —
 * every worktree created on 2026-08-08 started red because of it. A test that
 * depends on untracked local state is not protecting anything.
 */
const ensureStateDir = () => mkdirSync(join(repoRoot, 'state'), { recursive: true });
let killswitchWasSet = false;

beforeAll(() => {
  ledger.open().exec('DELETE FROM resolutions;');
  ledger.addResolution({
    repo: 'probe',
    kind: 'external_commit',
    commit_sha: 'abc12345deadbeef',
    paths: ['src/util.ts'],
    symbols: ['sleep'],
    reason: 'add sleep helper by hand',
  });
  ledger.addResolution({
    repo: 'probe',
    kind: 'manual_park',
    symbols: ['generateSparklineSvg'],
    reason: 'parked before dispatch — already exported',
  });
  ledger.addResolution({
    repo: 'other',
    kind: 'external_commit',
    commit_sha: 'ffff0000',
    paths: ['README.md'],
    reason: 'unrelated repo',
  });
  ensureStateDir();
  killswitchWasSet = existsSync(KILLSWITCH);
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dbDir, { recursive: true, force: true });
  // Leave the killswitch exactly as it was found.
  if (!killswitchWasSet && existsSync(KILLSWITCH)) unlinkSync(KILLSWITCH);
});

describe('searchResolutions', () => {
  it('finds a resolution by symbol', () => {
    expect(ledger.searchResolutions(null, 'sleep')).toHaveLength(1);
  });

  it('finds one by a word in its reason', () => {
    expect(ledger.searchResolutions(null, 'by hand')[0]!.symbols).toContain('sleep');
  });

  it('finds one by path', () => {
    expect(ledger.searchResolutions(null, 'util.ts')).toHaveLength(1);
  });

  it('finds one by commit sha prefix', () => {
    expect(ledger.searchResolutions(null, 'abc12345')).toHaveLength(1);
  });

  it('requires every term to match, so two words narrow rather than flood', () => {
    expect(ledger.searchResolutions(null, 'sleep helper')).toHaveLength(1);
    expect(ledger.searchResolutions(null, 'sleep nonexistentword')).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(ledger.searchResolutions(null, 'SLEEP')).toHaveLength(1);
  });

  it('can scope to one repo', () => {
    expect(ledger.searchResolutions('probe', 'unrelated')).toHaveLength(0);
    expect(ledger.searchResolutions('other', 'unrelated')).toHaveLength(1);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(ledger.searchResolutions(null, '   ')).toHaveLength(0);
  });

  it('finds parked tasks, which is the main reason to reach for it', () => {
    const hits = ledger.searchResolutions(null, 'parked');
    expect(hits[0]!.kind).toBe('manual_park');
  });
});

/**
 * The killswitch stops execution, not inspection. Asking why something was
 * parked is exactly what you do while the system is stopped, so this spawns the
 * real CLI with the killswitch present rather than trusting the function alone.
 */
describe('sa recall with the killswitch set', () => {
  it('returns results while the system is switched off', async () => {
    writeFileSync(KILLSWITCH, new Date().toISOString());
    expect(existsSync(KILLSWITCH)).toBe(true);

    const res = await execa('npx', ['tsx', 'src/index.ts', 'recall', 'sleep'], {
      cwd: repoRoot,
      reject: false,
      stdin: 'ignore',
      timeout: 120_000,
      env: { ...process.env, SHANAUTO_DB: DB, SHANAUTO_KILLSWITCH: KILLSWITCH },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('sleep');
    expect(res.stdout).not.toContain('Killswitch is active');
  }, 130_000);

  it('refuses an empty query with usage rather than dumping everything', async () => {
    const res = await execa('npx', ['tsx', 'src/index.ts', 'recall'], {
      cwd: repoRoot,
      reject: false,
      stdin: 'ignore',
      timeout: 120_000,
      env: { ...process.env, SHANAUTO_DB: DB },
    });
    expect(res.exitCode).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('Usage');
  }, 130_000);
});
