/*
 * The guard that keeps a forgetful test out of the real ledger.
 *
 * This file deliberately does NOT set SHANAUTO_DB. It stands in for the 26 of
 * 47 test files that never set it either. Without the global setup in
 * vitest.config.ts, config.ts resolves the fallback and every write from such a
 * file lands in the tracked data/ and state/ directories — which is how sixteen
 * `repo r1 / "do the thing"` fixture tasks reached the production database and
 * then data/reports/ledger.csv, rebuilt from the tasks table on every export.
 *
 * If this file ever starts setting SHANAUTO_DB itself, it stops testing
 * anything. That is the one edit to refuse.
 */
import { describe, it, expect } from 'vitest';
import { ROOT, p, dataRoot, reportsDir, stateRoot } from '../config.js';

const inside = (child: string, parent: string) => {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(child) === norm(parent) || norm(child).startsWith(`${norm(parent)}/`);
};

/*
 * Resolved HERE, at module scope, not inside a test. Test files that open the
 * ledger or read a path at import time run before any beforeEach fires, so the
 * setup file has to assign a database when it is imported, not merely before
 * each test. Captured now and asserted below, because an expect() at module
 * scope is not attributed to any test.
 */
const atImportTime = { data: dataRoot(), reports: reportsDir(), state: stateRoot() };

describe('a test file that never sets SHANAUTO_DB is still isolated', () => {
  it('has a database path chosen for it', () => {
    // The setup file assigns one; unset means the guard is not wired up.
    expect(process.env.SHANAUTO_DB, 'no SHANAUTO_DB — the global setup did not run').toBeTruthy();
  });

  it('does not resolve writes into the tracked data/ directory', () => {
    // dataRoot() covers the run journal and agent artifacts, reportsDir() the
    // ledger.csv and weekly reports — the two that were corrupted before.
    expect(inside(dataRoot(), p('data'))).toBe(false);
    expect(inside(reportsDir(), p('data', 'reports'))).toBe(false);
  });

  it('does not resolve the run lock or killswitch into the tracked state/', () => {
    // Sharing state/ with production would let a test take over a live run's
    // lock, not merely dirty a file.
    expect(inside(stateRoot(), p('state'))).toBe(false);
  });

  it('keeps every resolved path out of the repo altogether', () => {
    for (const dir of [dataRoot(), reportsDir(), stateRoot()]) {
      expect(inside(dir, ROOT), `${dir} is inside the repo`).toBe(false);
    }
  });

  it('was already isolated when this file was imported, before any hook ran', () => {
    // A module-scope `open()` in some other test file gets no beforeEach.
    for (const [what, dir] of Object.entries(atImportTime)) {
      expect(inside(dir, ROOT), `${what} resolved into the repo at import time: ${dir}`).toBe(false);
    }
  });
});

describe('isolation survives a test that clears the variable', () => {
  /*
   * Not hypothetical: agy-permissions.test.ts and data-safety.test.ts both
   * delete SHANAUTO_DB in teardown. Without the beforeEach re-assert, every
   * test after them in the same worker resolves to production. These two run in
   * order and the pair is the point — the first is the damage, the second the
   * recovery.
   */
  it('a test clears it, the way two real files do', () => {
    delete process.env.SHANAUTO_DB;
    expect(process.env.SHANAUTO_DB).toBeUndefined();
  });

  it('and the next test is pointed somewhere safe again', () => {
    expect(process.env.SHANAUTO_DB, 'left unset after a test deleted it').toBeTruthy();
    expect(inside(dataRoot(), p('data'))).toBe(false);
    expect(inside(stateRoot(), p('state'))).toBe(false);
  });
});
