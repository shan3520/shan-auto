/*
 * Prove the gate's two new verdicts against a real git repo and a real pytest.
 *
 * The unit tests mock git and execa, which is the right shape for them and no
 * evidence at all that the thing works. This builds an actual repository, makes
 * an actual commit, edits actual files and runs actual pytest, then asks the
 * real gate what it thinks.
 *
 * It has already earned its keep once. The first version of the attribution
 * logic compared the filenames in pytest's output against the files in the diff,
 * and case 4 below — a task that changes app/thing.py and thereby breaks
 * tests/test_existing.py — walked straight through it, because pytest names only
 * the file the assertion is in and the task never touched that file. The mocked
 * tests all passed. This did not.
 *
 *   npx tsx scripts/prove-gate.ts
 */
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate, recheckRepo } from '../src/core/verifier.js';
import type { GateResult } from '../src/core/verifier.js';

type Case = { name: string; expect: string; got: string; detail?: string };
const results: Case[] = [];

const cfg = {
  system: {
    limits: {
      max_files_per_task: 10,
      scope_blowout_multiplier: 3,
      min_insertions: 1,
      forbid_dead_exports: false,
    },
    timeouts: { verify_s: 120 },
  },
} as never;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'gateproof-'));
  const git = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
  await git('init', '-q');
  await git('config', 'user.email', 'proof@local');
  await git('config', 'user.name', 'proof');

  mkdirSync(join(dir, 'tests'), { recursive: true });
  mkdirSync(join(dir, 'app'), { recursive: true });

  writeFileSync(join(dir, 'app', 'thing.py'), 'def value():\n    return 1\n');
  // A test that was already in the repo before any task started. This is the
  // file an agent must not quietly rewrite.
  writeFileSync(
    join(dir, 'tests', 'test_existing.py'),
    'from app.thing import value\n\n\ndef test_value():\n    assert value() == 1\n',
  );
  writeFileSync(join(dir, 'app', '__init__.py'), '');
  writeFileSync(join(dir, 'tests', '__init__.py'), '');

  await git('add', '-A');
  await git('commit', '-q', '-m', 'initial');
  return dir;
}

const repoFor = (dir: string) =>
  ({ id: 'proof', path: dir, branch: 'main', verify_cmd: 'python -m pytest -q' }) as never;

const taskWith = (hint: string[]) =>
  ({ files_hint: JSON.stringify(hint), verify_cmd: '' }) as never;

/**
 * What the executor does with a gate rejection, in the same order it does it.
 *
 * Mirrors runOne in src/core/executor.ts: revert exactly what the gate saw, then
 * — if it was the repo's own check that failed — ask the reverted tree whether it
 * is still red. Kept here rather than importing runOne, which would need a
 * ledger, a config file and a live agent driver to reach this branch at all.
 */
async function verdictFor(dir: string, g: GateResult): Promise<string> {
  if (g.ok) return 'ok';
  await execa('git', ['checkout', '--', '.'], { cwd: dir, reject: false });
  await execa('git', ['clean', '-fdq'], { cwd: dir, reject: false });
  if (!g.baseFailed) return g.failure ?? '?';
  const after = await recheckRepo(cfg, repoFor(dir));
  return after.green ? 'VERIFY_FAIL' : 'VERIFY_UNRELATED';
}

async function run(
  name: string,
  expect: string,
  build: (dir: string) => Promise<{ hint: string[]; green?: boolean }>,
) {
  const dir = await makeRepo();
  try {
    const { hint, green = true } = await build(dir);
    const g = await gate(cfg, taskWith(hint), repoFor(dir), undefined, green);
    results.push({ name, expect, got: await verdictFor(dir, g), detail: g.detail.slice(0, 220) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. An agent rewrites an existing test it never declared. The exact shape of
//    what example-api task Tc2ca9kfmri did on 2026-08-20, which the gate committed.
await run('undeclared edit to a pre-existing test', 'TEST_TAMPER', async (dir) => {
  writeFileSync(join(dir, 'app', 'feature.py'), 'def added():\n    return 42\n');
  writeFileSync(
    join(dir, 'tests', 'test_existing.py'),
    'from app.thing import value\n\n\ndef test_value():\n    assert value() >= 0\n',
  );
  return { hint: ['app/feature.py'] };
});

// 2. The same edit, declared by the planner. Ordinary, legitimate work.
await run('declared edit to a pre-existing test', 'ok', async (dir) => {
  writeFileSync(join(dir, 'app', 'feature.py'), 'def added():\n    return 42\n');
  writeFileSync(
    join(dir, 'tests', 'test_existing.py'),
    'from app.thing import value\n\n\ndef test_value():\n    assert value() == 1\n\n\ndef test_more():\n    assert value() > 0\n',
  );
  return { hint: ['app/feature.py', 'tests/test_existing.py'] };
});

// 3. A test the task never touched is already broken. example-api, 2026-08-20.
await run('pre-existing failure the task never caused', 'VERIFY_UNRELATED', async (dir) => {
  const git = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
  writeFileSync(
    join(dir, 'tests', 'test_existing.py'),
    'from app.thing import value\n\n\ndef test_value():\n    assert value() == 999\n',
  );
  await git('add', '-A');
  await git('commit', '-q', '-m', 'break it');

  writeFileSync(join(dir, 'app', 'feature.py'), 'def added():\n    return 42\n');
  writeFileSync(
    join(dir, 'tests', 'test_feature.py'),
    'from app.feature import added\n\n\ndef test_added():\n    assert added() == 42\n',
  );
  return { hint: ['app/feature.py', 'tests/test_feature.py'] };
});

// 4. The task broke a test it never touched. It must still be blamed — this is
//    the case that killed the filename-matching version of this logic.
await run('task breaks a test in a file it did not touch', 'VERIFY_FAIL', async (dir) => {
  writeFileSync(join(dir, 'app', 'thing.py'), 'def value():\n    return 7\n');
  writeFileSync(join(dir, 'app', 'feature.py'), 'def added():\n    return 42\n');
  return { hint: ['app/thing.py', 'app/feature.py'] };
});

let bad = 0;
for (const r of results) {
  const ok = r.got === r.expect;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`      expected ${r.expect}, got ${r.got}`);
  if (r.detail) console.log(`      ${r.detail.replace(/\n/g, '\n      ')}`);
  console.log('');
}
console.log(bad === 0 ? 'ALL PASS (real git, real pytest)' : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
