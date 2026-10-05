/*
 * Test isolation, applied globally instead of per file.
 *
 * config.ts resolves the database, reports, run journal, artifacts, lock and
 * killswitch from SHANAUTO_DB, and falls back to the REAL data/ and state/
 * directories when it is unset. That fallback is correct for production and
 * dangerous for tests: a test that forgets to set the variable writes into the
 * live ledger.
 *
 * It has already happened. Sixteen `repo r1 / "do the thing"` fixture tasks
 * reached the production database and rode into data/reports/ledger.csv, which
 * is rebuilt from the tasks table on every export. They were only noticed
 * because they showed up as dropped tasks with a hand-written reason. Before
 * that, reporter tests rebuilt the tracked ledger.csv from an empty temp
 * database and replaced 135 rows of real history with a header line.
 *
 * Discipline did not hold: only 21 of 47 test files set the variable. So this
 * inverts the default — every test file starts pointed at its own scratch
 * database, and a file that wants a specific one still just sets SHANAUTO_DB.
 * Re-asserted in beforeEach because two files delete the variable in teardown,
 * which would otherwise hand the rest of the run back to production.
 */
import { beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// setupFiles run once per test file, so each file gets its own scratch dir and
// cannot see another file's rows.
const scratch = mkdtempSync(join(tmpdir(), 'shanauto-test-'));
const FALLBACK = join(scratch, 'isolated.db');

function isolate(): void {
  if (!process.env.SHANAUTO_DB) process.env.SHANAUTO_DB = FALLBACK;
  /*
   * The outage wait, made instant.
   *
   * A run whose only agent stops answering waits two minutes and tries once
   * more before giving up the rest of the day (O22). That is the right length
   * for a real provider blip and the wrong one for a test suite, where it
   * turned nine outage tests into timeouts.
   *
   * Set here rather than per file so no suite that reaches the outage path can
   * accidentally sit through the real thing. How LONG it waits is a constant
   * with its reasoning beside it; what the tests are about is that it waits
   * once, and then stops.
   */
  if (!process.env.SHANAUTO_OUTAGE_WAIT_MS) process.env.SHANAUTO_OUTAGE_WAIT_MS = '1';
}

isolate();
beforeEach(isolate);
