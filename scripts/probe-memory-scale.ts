/**
 * Does the memory still work at the scale it was designed for?
 *
 * Everything so far has been verified against two days and 135 memories. The
 * stated requirement is years. This synthesises three years of history in a
 * throwaway database and checks the parts that could plausibly break: rollup
 * build time, retrieval quality, and whether the context handed to the model
 * stays inside its cap.
 *
 *   npx tsx scripts/probe-memory-scale.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sa-scale-'));
process.env.SHANAUTO_DB = join(dir, 'scale.db');

const ledger = await import('../src/ledger.js');
const { buildRollups } = await import('../src/core/rollup.js');
const { buildContext } = await import('../src/core/retrieve.js');

const REPO = 'scaletest';
const DAYS = 365 * 3;
const COMMITS_PER_DAY = 10;

const FILES = [
  'src/ledger.ts', 'src/core/planner.ts', 'src/core/executor.ts', 'src/git.ts',
  'src/core/verifier.ts', 'src/index.ts', 'src/core/rollup.ts', 'README.md',
];
const VERBS = ['add', 'fix', 'refactor', 'test', 'document', 'remove'];
const NOUNS = ['retry backoff', 'the gate', 'the allocator', 'commit parsing', 'rollups', 'the planner'];

const start = new Date('2024-01-01T09:00:00.000Z');
const db = ledger.open();

console.log(`synthesising ${DAYS} days x ${COMMITS_PER_DAY} commits...`);
const t0 = Date.now();

db.exec('BEGIN');
const stmt = db.prepare(
  `INSERT INTO resolutions (id,repo,resolved_at,kind,commit_sha,paths,symbols,reason,task_id,claim_key,occurred_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
);

let n = 0;
for (let day = 0; day < DAYS; day++) {
  const when = new Date(start.getTime() + day * 86_400_000);
  for (let c = 0; c < COMMITS_PER_DAY; c++) {
    const iso = new Date(when.getTime() + c * 3_600_000).toISOString();
    const file = FILES[(day + c) % FILES.length]!;
    stmt.run(
      `s${n}`, REPO, iso, 'external_commit', `sha${n.toString(16).padStart(8, '0')}`,
      JSON.stringify([file]), JSON.stringify([`symbol${n % 400}`]),
      `${VERBS[n % VERBS.length]}: ${NOUNS[n % NOUNS.length]}`, null, null, iso,
    );
    n++;
  }
  // A decision roughly monthly, an incident roughly fortnightly — the shape of
  // real history, where reasoning is rare and commits are not.
  if (day % 30 === 0) {
    const iso = when.toISOString();
    stmt.run(`d${day}`, REPO, iso, 'decision', null, '[]', '[]',
      `${iso.slice(0, 10)} — Decision about ${NOUNS[day % NOUNS.length]}\nchosen because the alternative cost more`,
      null, null, iso);
    n++;
  }
  if (day % 14 === 0) {
    const iso = when.toISOString();
    stmt.run(`i${day}`, REPO, iso, 'incident', null, '[]', '[]',
      `${iso.slice(0, 10)} run: killswitch tripped during ${NOUNS[day % NOUNS.length]}`, null, null, iso);
    n++;
  }
}
db.exec('COMMIT');
console.log(`  ${n.toLocaleString()} memories in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const now = new Date('2027-01-15T00:00:00.000Z');

for (const period of ['month', 'week'] as const) {
  const t = Date.now();
  const built = buildRollups(REPO, period, now);
  console.log(`rollup ${period}: ${built} periods in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const memories = ledger.recentResolutions(REPO, 4000);
const rollups = ledger.getRollups(REPO, undefined, 500);
console.log(`\nretrieval pool: ${memories.length} memories + ${rollups.length} rollups`);

const questions = [
  'what do you know about the scaletest project?',
  'why was there a decision about the gate?',
  'what went wrong with the allocator?',
  'when did rollups change?',
];

console.log('\n--- retrieval at 3-year scale ---');
let worst = 0;
for (const q of questions) {
  const t = Date.now();
  const ctx = buildContext(q, memories, rollups, now);
  const ms = Date.now() - t;
  worst = Math.max(worst, ms);
  console.log(
    `  ${ms.toString().padStart(4)}ms  ${ctx.candidates.toString().padStart(3)} lines  ` +
    `${ctx.used.toString().padStart(5)} chars  "${q.slice(0, 44)}"`,
  );
  if (ctx.used > 6000) console.log('    !! OVER CAP');
  if (ctx.candidates === 0) console.log('    !! NOTHING RETRIEVED');
}

console.log(`\nslowest retrieval: ${worst}ms`);
ledger.closeForTest();
rmSync(dir, { recursive: true, force: true });
