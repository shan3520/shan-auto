/**
 * Isolation test for the agy driver.
 *
 * Runs the REAL AgyAgent against a throwaway git repo with a task that cannot
 * already be satisfied, so a failure here means the driver is broken rather
 * than the task being poorly specified.
 *
 *   npx tsx scripts/probe-agy.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import AgyAgent from '../src/drivers/agent.agy.js';
import type { Repo, TaskRow } from '../src/schemas.js';

const dir = mkdtempSync(join(tmpdir(), 'agyprobe-'));
writeFileSync(join(dir, 'README.md'), '# probe\n');
await execa('git', ['init', '-b', 'main'], { cwd: dir });
await execa('git', ['add', '-A'], { cwd: dir });
await execa('git', ['-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-m', 'init'], { cwd: dir });

const repo: Repo = {
  id: 'probe',
  path: dir,
  branch: 'main',
  stack: 'text',
  verify_cmd: 'echo ok',
  enabled: true,
  weight: 1,
};

const unique = `probe-${Date.now()}`;
const task = {
  id: 'PROBE1',
  repo: 'probe',
  title: 'Create a marker file',
  kind: 'feature',
  instruction: `Create a new file named marker.txt in the workspace root whose entire contents are exactly: ${unique}`,
  acceptance: `marker.txt exists and contains ${unique}`,
  files_hint: '["marker.txt"]',
  verify_cmd: 'echo ok',
  depends_on: '[]',
  est_lines: 1,
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

const agent = new AgyAgent({});
console.log('health:', await agent.healthCheck());
console.log('repo  :', dir);

const started = Date.now();
const res = await agent.execute(task, repo, 240);
console.log(`\nresult: ok=${res.ok} reason=${res.reason ?? '-'} ${(Date.now() - started) / 1000}s`);
console.log('agent said:', res.stdout.slice(0, 400).replace(/\s+/g, ' '));

const marker = join(dir, 'marker.txt');
const changed = (await execa('git', ['status', '--porcelain'], { cwd: dir })).stdout;

console.log('\n--- VERDICT ---');
console.log('marker.txt exists  :', existsSync(marker));
if (existsSync(marker)) console.log('contents match     :', readFileSync(marker, 'utf8').trim() === unique);
console.log('git sees changes   :', changed.trim() || '(none)');
console.log(
  existsSync(marker) && changed.trim()
    ? 'PASS - agy writes into the target repo through the driver'
    : 'FAIL - driver did not produce a change in the repo',
);
