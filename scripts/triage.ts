/**
 * Classify and clear failed tasks so their dependents stop being stranded.
 *
 * A failed task freezes everything downstream of it permanently, so failures have
 * to be resolved, not left. Doing it by hand does not scale — this was done
 * one-by-one four times during the 2026-08-07 drain.
 *
 * The rules encode what those failures actually turned out to be:
 *
 *   NO_CHANGES   the agent looked and found the work already present -> drop
 *   DEAD_EXPORT  the task asks for a helper with no consumer. Unbuildable as
 *                written under the gate; forcing it means inventing scope -> drop
 *   TRIVIAL      the change was below the minimum; almost always already done -> drop
 *   VERIFY_FAIL  a genuine bug in the attempt -> retry, it deserves another go
 *   other        left alone for a human to look at
 *
 *   npx tsx scripts/triage.ts          # report only
 *   npx tsx scripts/triage.ts --apply  # actually resolve them
 */
import * as ledger from '../src/ledger.js';

const apply = process.argv.includes('--apply');

const DROP: [RegExp, string][] = [
  [/NO_CHANGES/, 'agent found the work already present'],
  [/DEAD_EXPORT/, 'adds an export with no consumer — unbuildable as specified'],
  [/TRIVIAL/, 'change below the minimum; the work already exists'],
];

/*
 * A milestone whose every proposal was rejected queues no tasks at all, so it
 * cannot appear in the loop below however hard you look. It is still unfinished
 * work — one was closed as `satisfied` on 2026-08-08 and only found by hand —
 * so it is reported here, where stuck work is looked for.
 */
for (const m of ledger.stuckMilestones()) {
  console.log(`PLAN   ${m.id}  ${m.title.slice(0, 46)}`);
  for (const line of (m.last_error ?? '').split('\n').slice(0, 3)) {
    if (line.trim()) console.log(`         ${line.slice(0, 70)}`);
  }
  console.log('         requeue with: npm run sa -- retry --failed');
}

const failed = ledger
  .open()
  .prepare("SELECT id, title, last_error FROM tasks WHERE status IN ('failed','blocked')")
  .all() as unknown as { id: string; title: string; last_error: string | null }[];

if (failed.length === 0) {
  console.log('No failed or blocked tasks. Nothing to triage.');
  process.exit(0);
}

let dropped = 0;
let retried = 0;
let skipped = 0;

for (const t of failed) {
  const err = t.last_error ?? '';
  const rule = DROP.find(([re]) => re.test(err));

  if (rule) {
    console.log(`DROP   ${t.id}  ${t.title.slice(0, 46)}\n         ${rule[1]}`);
    if (apply) ledger.dropTask(t.id, rule[1]);
    dropped++;
  } else if (/VERIFY_FAIL|TIMEOUT|EXIT_/.test(err)) {
    console.log(`RETRY  ${t.id}  ${t.title.slice(0, 46)}`);
    if (apply) ledger.retryTask(t.id);
    retried++;
  } else {
    console.log(`SKIP   ${t.id}  ${t.title.slice(0, 46)}\n         ${err.slice(0, 70)}`);
    skipped++;
  }
}

console.log(`\n${dropped} to drop, ${retried} to retry, ${skipped} left for you.`);
if (!apply) console.log('Dry run — re-run with --apply to act on it.');
