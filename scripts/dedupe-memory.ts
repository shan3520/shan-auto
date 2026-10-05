/**
 * Remove memories duplicated across repos.
 *
 * DECISIONS.md and the run logs describe the SYSTEM, not one project, but they
 * were ingested inside the per-repo loop — so every one was stored once per
 * configured repo. `recall` showed the same decision twice as if two had been
 * made, and `ask` spent half its context budget on copies.
 *
 * Ingestion is fixed; this clears what is already stored. Keeps the OLDEST copy
 * of each (by occurred_at, then rowid) so the surviving row is the one with the
 * truest date. Pass --apply to delete; the default reports and changes nothing.
 */
import * as ledger from '../src/ledger.js';

const apply = process.argv.includes('--apply');
const db = ledger.open();

const dupes = db
  .prepare(
    `SELECT reason, COUNT(*) n, COUNT(DISTINCT repo) repos
       FROM resolutions
      WHERE kind IN ('decision','incident','journal') AND reason IS NOT NULL
      GROUP BY reason HAVING n > 1 AND repos > 1
      ORDER BY n DESC`,
  )
  .all() as { reason: string; n: number; repos: number }[];

const extra = dupes.reduce((sum, d) => sum + (d.n - 1), 0);
console.log(`${dupes.length} memories stored more than once across repos`);
console.log(`${extra} redundant copies\n`);
for (const d of dupes.slice(0, 5)) {
  console.log(`  x${d.n}  ${d.reason.split('\n')[0]!.slice(0, 68)}`);
}

if (!apply) {
  console.log('\n(dry run — nothing deleted. Pass --apply to remove the copies.)');
  process.exit(0);
}

/*
 * Export before deleting. This table's own schema comment says "Append-only.
 * Never updated, never deleted", and it holds everything the system has ever
 * learned — one bad WHERE clause away from zero. A backup costs a second.
 */
const { exportMemory } = await import('../src/core/memory-export.js');
for (const { repo } of db.prepare('SELECT DISTINCT repo FROM resolutions').all() as {
  repo: string;
}[]) {
  exportMemory(repo);
}
console.log('exported a backup before deleting');

const res = db
  .prepare(
    `DELETE FROM resolutions WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY reason ORDER BY COALESCE(occurred_at, resolved_at) ASC, rowid ASC
         ) rn
         FROM resolutions
         WHERE kind IN ('decision','incident','journal') AND reason IS NOT NULL
           /*
            * Only reasons duplicated ACROSS repos, matching what the dry run
            * reports. Without this the DELETE partitioned by reason alone, so
            * two genuinely different events in the SAME repo lost one: measured
            * at 1 copy reported and 4 deleted. A cleanup that removes more than
            * it shows is worse than the duplication it fixes.
            */
           AND reason IN (
             SELECT reason FROM resolutions
              WHERE kind IN ('decision','incident','journal') AND reason IS NOT NULL
              GROUP BY reason HAVING COUNT(DISTINCT repo) > 1
           )
       ) WHERE rn > 1
     )`,
  )
  .run();
console.log(`\nremoved ${res.changes} duplicate memories`);
console.log(`remaining: ${(db.prepare('SELECT COUNT(*) n FROM resolutions').get() as { n: number }).n}`);
