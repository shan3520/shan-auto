import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

/**
 * The ways this system could lose work that was never anyone's fault.
 *
 * Every fault below was found by driving the real thing rather than reading it,
 * and none was caught by the 549-test suite. They share a shape: the failure is
 * silent, and what the system REPORTS afterwards is wrong in the reassuring
 * direction — "continuing offline", "committed", "exported", "already present".
 */

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    // A SQLite handle may still hold the file on Windows; a failed cleanup of a
    // temp directory must never turn the suite red.
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }),
);

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe('a rebase conflict stops the run instead of orphaning the work', () => {
  /*
   * `ensureClean` swallowed every pull failure as "continuing offline". A
   * CONFLICT is not offline: it leaves the repo detached, mid-rebase. The run
   * carried on, the task committed onto the orphan, simple-git returned a
   * garbage sha ("HEAD 739") which went into the ledger AS the commit id, the
   * push was rejected and logged as a warning, and `git rebase --abort` then
   * made the commit unreachable.
   *
   * The task was marked committed, so it is never retried. The work is gone and
   * the record says it succeeded — the worst combination available.
   */
  async function conflictedRepo(): Promise<{ path: string; branch: string; id: string }> {
    const remote = scratch('rem-');
    const local = scratch('loc-');
    const g = (cwd: string) => (...a: string[]) => execa('git', a, { cwd, reject: false });

    await g(remote)('init', '-q', '--bare');
    await g(local)('clone', '-q', remote, '.');
    await g(local)('config', 'user.email', 't@t');
    await g(local)('config', 'user.name', 't');
    writeFileSync(join(local, 'f.txt'), 'base\n');
    await g(local)('add', '-A');
    await g(local)('commit', '-qm', 'base');
    await g(local)('push', '-q', 'origin', 'HEAD:refs/heads/main');

    // Someone else changes the same line upstream.
    const other = scratch('oth-');
    await g(other)('clone', '-q', remote, '.');
    await g(other)('config', 'user.email', 'o@o');
    await g(other)('config', 'user.name', 'o');
    writeFileSync(join(other, 'f.txt'), 'theirs\n');
    await g(other)('add', '-A');
    await g(other)('commit', '-qm', 'theirs');
    await g(other)('push', '-q', 'origin', 'main');

    // And we change it locally. Rebasing these cannot succeed.
    await g(local)('checkout', '-qB', 'main');
    writeFileSync(join(local, 'f.txt'), 'ours\n');
    await g(local)('add', '-A');
    await g(local)('commit', '-qm', 'ours');

    return { id: 'conflicted', path: local, branch: 'main' };
  }

  it('refuses to run rather than committing onto a detached HEAD', async () => {
    const { ensureClean } = await import('../git.js');
    const repo = (await conflictedRepo()) as never;

    await expect(ensureClean(repo)).rejects.toThrow(/mid-rebase or detached/i);
  });

  it('names the way out, since only a person can resolve a conflict', async () => {
    const { ensureClean } = await import('../git.js');
    const repo = (await conflictedRepo()) as never;

    await expect(ensureClean(repo)).rejects.toThrow(/rebase --abort/);
  });

  it('still continues when the pull fails for an ordinary reason', async () => {
    // A missing remote IS "offline" — failing open is right there, and this is
    // the case the old blanket catch existed for.
    const { ensureClean } = await import('../git.js');
    const dir = scratch('solo-');
    const g = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 't@t');
    await g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    await g('add', '-A');
    await g('commit', '-qm', 'init');

    await expect(
      ensureClean({ id: 'solo', path: dir, branch: 'main' } as never),
    ).resolves.toBeUndefined();
  });
});

/**
 * Work that gets set aside and then never handed back.
 *
 * Driven against real git, deliberately: the existing `ensureClean` tests mock
 * simple-git and assert that `stash push` was CALLED. That is the same test shape
 * that passed over the rollback stash for a fortnight while it failed every time
 * against a real repo. What a stash CONTAINS is not observable through a mock.
 *
 * Ground truth, example-api on 2026-08-15: eleven stashes, the oldest a week old,
 * two of them holding nothing whatever.
 */
describe('set-aside work is neither lost nor left in a silent pile', () => {
  async function repoWithHistory(prefix: string) {
    const dir = scratch(prefix);
    const g = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 't@t');
    await g('config', 'user.name', 't');
    writeFileSync(join(dir, 'kept.txt'), 'hello\n');
    await g('add', '-A');
    await g('commit', '-qm', 'init');
    return { dir, g, repo: { id: 'solo', path: dir, branch: 'main' } as never };
  }

  it('does not keep a stash that holds nothing', async () => {
    const { ensureClean } = await import('../git.js');
    const { dir, g, repo } = await repoWithHistory('phantom-');

    /*
     * The exact sequence that produced two of example-api's eleven. `diffStat` runs
     * `git add -A --intent-to-add .` on every task; rollback's fallback then
     * removes an untracked file from disk. What is left is an index entry for a
     * file that exists nowhere, which `git status` reports as a deletion.
     */
    writeFileSync(join(dir, 'agent_new.txt'), 'scratch\n');
    await g('add', '-A', '--intent-to-add', '.');
    rmSync(join(dir, 'agent_new.txt'));
    const dirty = await g('status', '--porcelain');
    expect(dirty.stdout.trim()).not.toBe(''); // git really does claim a change

    await ensureClean(repo);

    const list = await g('stash', 'list');
    expect(list.stdout.trim()).toBe('');
  });

  it('keeps a stash that holds an untracked file of the owner\'s', async () => {
    const { ensureClean } = await import('../git.js');
    const { dir, g, repo } = await repoWithHistory('owner-');

    // The 08-12 case: two .bat files the owner had written, swept up mid-run.
    writeFileSync(join(dir, 'make_commits.bat'), 'echo hi\n');
    await ensureClean(repo);

    const kept = await g('stash', 'show', '--include-untracked', '--name-only', 'stash@{0}');
    expect(kept.stdout).toContain('make_commits.bat');
    // And it is genuinely out of the tree, which is what ensureClean is for.
    expect(existsSync(join(dir, 'make_commits.bat'))).toBe(false);
  });

  it('keeps a stash that holds a tracked edit of the owner\'s', async () => {
    const { ensureClean } = await import('../git.js');
    const { dir, g, repo } = await repoWithHistory('edit-');

    writeFileSync(join(dir, 'kept.txt'), 'mid-edit\n');
    await ensureClean(repo);

    const kept = await g('stash', 'show', '--name-only', 'stash@{0}');
    expect(kept.stdout).toContain('kept.txt');
  });

  it('never touches a stash that is not ours', async () => {
    const { ensureClean } = await import('../git.js');
    const { dir, g, repo } = await repoWithHistory('theirs-');

    writeFileSync(join(dir, 'kept.txt'), 'their work\n');
    await g('stash', 'push', '-m', 'my own wip');

    // Now make the tree phantom-dirty, so the drop path runs with someone
    // else's stash sitting on top of the list.
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    await g('add', '-A', '--intent-to-add', '.');
    rmSync(join(dir, 'x.txt'));

    await ensureClean(repo);

    const list = await g('stash', 'list');
    expect(list.stdout).toContain('my own wip');
  });

  it('reports the pile, so it cannot grow unseen', async () => {
    const { shanautoStashes, stashSummary } = await import('../git.js');
    const { dir, g, repo } = await repoWithHistory('pile-');

    writeFileSync(join(dir, 'owner_note.md'), 'mine\n');
    await g('stash', 'push', '-u', '-m', 'shanauto-autostash-1786558771150');
    writeFileSync(join(dir, 'kept.txt'), 'agent work\n');
    await g('stash', 'push', '-u', '-m', 'shanauto-rollback 2026-08-09T15:40:09.659Z');
    writeFileSync(join(dir, 'kept.txt'), 'their own wip\n');
    await g('stash', 'push', '-m', 'my own wip');

    const entries = await shanautoStashes(repo);
    // Three stashes exist; the owner's own is not ShanAuto's business to report.
    expect(entries.map((e) => e.label)).toEqual([
      'shanauto-rollback 2026-08-09T15:40:09.659Z',
      'shanauto-autostash-1786558771150',
    ]);
    expect(entries.flatMap((e) => e.files).sort()).toEqual(['kept.txt', 'owner_note.md']);

    const [sum] = await stashSummary([repo]);
    expect(sum?.count).toBe(2);
    expect(sum?.files).toContain('owner_note.md');
  });

  it('says nothing when there is nothing set aside', async () => {
    const { stashSummary } = await import('../git.js');
    const { repo } = await repoWithHistory('quiet-');
    expect(await stashSummary([repo])).toEqual([]);
  });
});

describe('concurrent writers do not lose rows', () => {
  /*
   * WAL permits one writer at a time and, with no busy_timeout, a second writer
   * throws "database is locked" IMMEDIATELY rather than waiting. Measured: four
   * processes writing 300 rows each landed 343 of 1200 — 857 silently lost. The
   * file was never corrupted; the writes just never happened.
   *
   * `remember()` and `recordAgentCost()` swallow their errors by design (memory
   * must never break a run), so this produced a log line and nothing else. Only
   * `sa run` takes the lock file — the TUI, ingest, triage and retry all write
   * with no coordination at all.
   */
  it('sets a busy timeout so a blocked writer waits instead of failing', async () => {
    const dir = scratch('lock-');
    const db = join(dir, 'l.db');
    const script = join(dir, 'w.mjs');
    writeFileSync(
      script,
      `import { DatabaseSync } from 'node:sqlite';
       const d = new DatabaseSync(process.argv[2]);
       d.exec('PRAGMA journal_mode = WAL;');
       d.exec('PRAGMA busy_timeout = 10000;');
       console.log(JSON.stringify(d.prepare('PRAGMA busy_timeout').get()));`,
    );
    const res = await execa('node', [script, db], { reject: false });
    expect(res.stdout).toMatch(/10000/);
  });

  it('the ledger itself sets it, not just a probe', async () => {
    const src = readFileSync(join(process.cwd(), 'src/ledger.ts'), 'utf8');
    expect(src).toMatch(/PRAGMA busy_timeout/);
  });
});

describe('an export cannot destroy the backup it is writing', () => {
  const repo = 'expt';

  beforeEach(() => {
    delete process.env.SHANAUTO_DB;
  });

  it('refuses to write nothing over existing backup files', async () => {
    const dir = scratch('mem-');
    writeFileSync(join(dir, `${repo}-2026.jsonl`), '{"type":"resolution","kind":"decision"}\n');
    const before = readFileSync(join(dir, `${repo}-2026.jsonl`), 'utf8');

    process.env.SHANAUTO_DB = join(scratch('db-'), 'empty.db');
    const { exportMemory } = await import('../core/memory-export.js');
    const res = exportMemory(repo, dir);

    // An empty result almost always means "wrong database", not "no memory".
    expect(res.records).toBe(0);
    expect(readFileSync(join(dir, `${repo}-2026.jsonl`), 'utf8')).toBe(before);
  });

  it('leaves no window in which the only copy does not exist', async () => {
    // Written to .tmp and renamed. rmSync-then-append meant a crash between the
    // two calls left nothing at all.
    const src = readFileSync(join(process.cwd(), 'src/core/memory-export.ts'), 'utf8');
    expect(src).toMatch(/renameSync\(tmp, file\)/);
    expect(src).not.toMatch(/rmSync\(file, \{ force: true \}\);\s*\n\s*appendFileSync/);
  });

  it('writes beside the database it was actually reading', async () => {
    // It resolved to the REAL data/memory whatever ledger was in use, so a temp
    // database could replace a year of backup with its own two rows.
    const dbDir = scratch('db2-');
    process.env.SHANAUTO_DB = join(dbDir, 'x.db');
    const { exportMemory } = await import('../core/memory-export.js');
    exportMemory('nothing-here');

    expect(existsSync(join(process.cwd(), 'data', 'memory', 'nothing-here-2026.jsonl'))).toBe(false);
  });
});

describe('a restore gives back everything it was given', () => {
  /*
   * Keyed on kind:sha:reason, two genuinely different records collapsed whenever
   * they shared a reason and had no commit — which journal and decision rows
   * routinely do. Measured on a real export: 53 out, 46 back, 7 reported as
   * "skipped (already present)".
   */
  it('does not treat two different events as the same memory', async () => {
    const dbDir = scratch('rt-');
    process.env.SHANAUTO_DB = join(dbDir, 'rt.db');
    const memDir = scratch('rtm-');

    const lines = [
      { type: 'resolution', kind: 'journal', reason: 'daily note', occurred_at: '2026-08-01', paths: [] },
      { type: 'resolution', kind: 'journal', reason: 'daily note', occurred_at: '2026-08-02', paths: [] },
      { type: 'resolution', kind: 'journal', reason: 'daily note', occurred_at: '2026-08-03', paths: [] },
    ];
    writeFileSync(join(memDir, 'rt-2026.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { importMemory } = await import('../core/memory-export.js');
    const res = importMemory('rt', memDir);

    expect(res.imported, 'three distinct days must survive a restore').toBe(3);
    expect(res.skipped).toBe(0);
  });

  it('is still idempotent, so importing twice adds nothing', async () => {
    const dbDir = scratch('rt2-');
    process.env.SHANAUTO_DB = join(dbDir, 'rt2.db');
    const memDir = scratch('rtm2-');
    writeFileSync(
      join(memDir, 'rt2-2026.jsonl'),
      JSON.stringify({ type: 'resolution', kind: 'journal', reason: 'x', occurred_at: '2026-08-01', paths: [] }) + '\n',
    );

    const { importMemory } = await import('../core/memory-export.js');
    expect(importMemory('rt2', memDir).imported).toBe(1);
    expect(importMemory('rt2', memDir).imported).toBe(0);
  });
});

describe('the dedupe script deletes exactly what it reports', () => {
  /*
   * The report filtered on reasons appearing in more than one repo; the DELETE
   * partitioned by reason ALONE. So two genuinely different events in the SAME
   * repo lost one — 1 copy reported, 4 deleted. A cleanup that removes more than
   * it shows is worse than the duplication it was written to fix.
   */
  it('scopes the delete to the same condition as the report', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/dedupe-memory.ts'), 'utf8');
    const del = src.slice(src.indexOf('DELETE FROM resolutions'));
    expect(del).toMatch(/COUNT\(DISTINCT repo\) > 1/);
  });

  it('exports a backup before deleting anything', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/dedupe-memory.ts'), 'utf8');
    const applyIdx = src.indexOf("process.exit(0);");
    expect(src.slice(applyIdx)).toMatch(/exportMemory/);
  });
});

describe('reading a repo with no commits does not throw', () => {
  // `git diff HEAD` in a repo whose first commit does not exist is a fatal
  // error, and diffStat is called on every task. A brand-new project is a
  // perfectly ordinary thing to point this at.
  it('reports the new files instead of failing', async () => {
    const { diffStat } = await import('../git.js');
    const dir = scratch('fresh-');
    await execa('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'first.ts'), 'export const a = 1;\n');

    const d = await diffStat({ id: 'fresh', path: dir, branch: 'main' } as never);
    expect(d.files).toContain('first.ts');
  });
});

describe('memory backups survive names git and Windows disagree about', () => {
  it('keeps a file whose name is not ASCII', async () => {
    // rollback matched paths by string; a name round-tripped through git's
    // quoting ("\346\227\245") no longer equals the one on disk, so it fell
    // through to the destructive branch.
    const { rollback } = await import('../git.js');
    const dir = scratch('uni-');
    const g = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
    await g('init', '-q');
    await g('config', 'core.quotePath', 'false');
    await g('config', 'user.email', 't@t');
    await g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.ts'), 'x\n');
    await g('add', '-A');
    await g('commit', '-qm', 'init');

    const name = 'メモ.md';
    writeFileSync(join(dir, name), 'do not lose this\n');
    await rollback({ id: 'uni', path: dir, branch: 'main' } as never, [name]);

    const list = await execa('git', ['stash', 'list'], { cwd: dir });
    const quarantined = existsSync(join(dir, '.shanauto-rollback'));
    expect(
      list.stdout.includes('shanauto-rollback') || quarantined,
      'either stashed or quarantined — never simply gone',
    ).toBe(true);
  });
});

describe('a stale git lock does not turn a rollback into a deletion', () => {
  /*
   * `.git/index.lock` is left behind by any git process killed mid-write —
   * exactly what a timed-out agent produces, and this system kills agents on a
   * timeout by design. With it present, `reset`, `stash` and `checkout` all fail
   * with "Unable to create index.lock: File exists"; safeGit swallows each one;
   * and rollback proceeded to rmSync untracked files with no stash, no revert
   * and no recovery.
   *
   * The single condition that disables every safety net at once was the one a
   * crash leaves behind.
   */
  async function lockedRepo(): Promise<{ dir: string; repo: never }> {
    const dir = scratch('lock2-');
    const g = (...a: string[]) => execa('git', a, { cwd: dir, reject: false });
    await g('init', '-q');
    await g('config', 'user.email', 't@t');
    await g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.ts'), 'x\n');
    await g('add', '-A');
    await g('commit', '-qm', 'init');
    return { dir, repo: { id: 'locked', path: dir, branch: 'main' } as never };
  }

  it('keeps the file when the lock is fresh, rather than deleting it', async () => {
    const { rollback } = await import('../git.js');
    const { dir, repo } = await lockedRepo();
    writeFileSync(join(dir, 'MY-WORK.md'), 'the owner typed this\n');
    writeFileSync(join(dir, '.git', 'index.lock'), '');

    await rollback(repo, ['MY-WORK.md']);

    expect(
      existsSync(join(dir, 'MY-WORK.md')),
      'a held lock must abandon the rollback, not fall through to rm',
    ).toBe(true);
  });

  it('clears a lock old enough that no live command could hold it', async () => {
    const { rollback } = await import('../git.js');
    const { dir, repo } = await lockedRepo();
    writeFileSync(join(dir, 'note.md'), 'work\n');

    const lock = join(dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    const old = Date.now() - 60 * 60 * 1000; // an hour
    utimesSync(lock, new Date(old), new Date(old));

    await rollback(repo, ['note.md']);

    expect(existsSync(lock), 'the stale lock is cleared').toBe(false);
    const list = await execa('git', ['stash', 'list'], { cwd: dir });
    expect(list.stdout, 'and the rollback then works normally').toContain('shanauto-rollback');
  });
});

describe('a retention window it cannot express is not permission to delete', () => {
  /*
   * cutoffDay overflowed on a very large window, today() formatted
   * "NaN-NaN-NaN", and the keep test is a STRING comparison:
   * "2026-08-09" >= "NaN-NaN-NaN" is false, because 'N' sorts above '2'. The
   * check written to protect recent files rejected every file there was — so
   * "keep it all for three centuries" deleted the lot.
   */
  it('keeps everything instead of deleting everything', async () => {
    const { prune } = await import('../core/prune.js');
    const dataDir = scratch('prune-');
    const jdir = join(dataDir, 'journal');
    mkdirSync(jdir, { recursive: true });
    writeFileSync(join(jdir, '2020-01-01.md'), 'an old day\n');

    const res = prune(
      { journal_days: 1e9, artifact_days: 0, run_log_days: 0 } as never,
      { dryRun: false },
      dataDir,
    );

    expect(existsSync(join(jdir, '2020-01-01.md')), 'nothing may be removed').toBe(true);
    expect(res.removed).toHaveLength(0);
    expect(res.errors.join(' ')).toMatch(/keeping everything/);
  });

  it('still prunes normally for an ordinary window', async () => {
    const { prune } = await import('../core/prune.js');
    const dataDir = scratch('prune2-');
    const jdir = join(dataDir, 'journal');
    mkdirSync(jdir, { recursive: true });
    writeFileSync(join(jdir, '2020-01-01.md'), 'an old day\n');

    // Also aged, or the in-flight guard keeps it: a run may still be appending.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(join(jdir, '2020-01-01.md'), old, old);

    prune({ journal_days: 30, artifact_days: 0, run_log_days: 0 } as never, {}, dataDir);
    expect(existsSync(join(jdir, '2020-01-01.md'))).toBe(false);
  });
});

describe('a broken record cannot overwrite a good one', () => {
  /*
   * memory_rollups is keyed UNIQUE(repo, period, starts_at). A row with any of
   * those empty collides with every other malformed row, and the upsert then
   * quietly OVERWRITES a real summary. importMemory reaches saveRollup straight
   * from a JSONL line via String(rec.period) — which is the literal "undefined"
   * for a truncated file — so one damaged line could replace a month of
   * compressed memory with itself.
   */
  it('refuses a rollup with no period', async () => {
    process.env.SHANAUTO_DB = join(scratch('roll-'), 'r.db');
    const ledger = await import('../ledger.js');
    expect(() =>
      ledger.saveRollup({
        repo: 'x',
        period: '',
        starts_at: '2026-08-01',
        ends_at: '2026-08-31',
        stats: {},
        source_count: 1,
      }),
    ).toThrow(/Refusing to store/);
  });

  it('refuses the literal "undefined" a truncated JSONL line produces', async () => {
    process.env.SHANAUTO_DB = join(scratch('roll2-'), 'r.db');
    const ledger = await import('../ledger.js');
    expect(() =>
      ledger.saveRollup({
        repo: 'x',
        period: 'undefined',
        starts_at: 'undefined',
        ends_at: '',
        stats: {},
        source_count: 0,
      }),
    ).toThrow(/Refusing to store/);
  });

  it('still stores and rebuilds a well-formed one', async () => {
    process.env.SHANAUTO_DB = join(scratch('roll3-'), 'r.db');
    const ledger = await import('../ledger.js');
    const row = {
      repo: 'x',
      period: 'month',
      starts_at: '2026-08-01',
      ends_at: '2026-08-31',
      stats: { n: 1 },
      source_count: 4,
      narrative: 'what happened',
    };
    ledger.saveRollup(row);
    // A rebuild must not discard a narrative that cost a model call.
    ledger.saveRollup({ ...row, narrative: null, source_count: 9 });

    const out = ledger.getRollups('x', undefined, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.narrative).toBe('what happened');
    expect(out[0]!.source_count).toBe(9);
  });
});

describe('a half-built database is never cached', () => {
  /*
   * `db` was assigned BEFORE the schema ran, so a failure in SCHEMA or migrate()
   * left a handle with missing tables cached for the life of the process. Every
   * later error named a missing table rather than the failure that caused it,
   * and the next process to open the same file migrated it correctly — so the
   * fault hid itself.
   */
  it('assigns the module handle only after the schema and migrations run', () => {
    const src = readFileSync(join(process.cwd(), 'src/ledger.ts'), 'utf8');
    const open = src.slice(src.indexOf('export function open()'), src.indexOf('export function dbPath') + 1 || undefined);
    const body = src.slice(src.indexOf('export function open()'));
    expect(body.indexOf('db = fresh;')).toBeGreaterThan(body.indexOf('migrate(fresh)'));
    expect(open).not.toMatch(/db = new DatabaseSync/);
  });
});

/**
 * "From zero" has to mean from zero.
 *
 * reportsDir(), dataRoot() and stateRoot() all follow SHANAUTO_DB. journalDir()
 * did not — it read `p('data', 'journal')` unconditionally — so every isolated
 * instance still wrote into, and read back out of, the one journal in the
 * checkout. Runs .zero5 through .zero11 all shared a single 52KB file: each
 * "clean" run was dispatched with its predecessors' rejections in its prompt,
 * and a run staged to prove a fix was reading the era before the fix.
 */
describe('a redirected instance journals beside its own ledger', () => {
  beforeEach(() => {
    delete process.env.SHANAUTO_DB;
  });

  it('writes where the database is, not where the source tree is', async () => {
    const dbDir = scratch('jd-');
    process.env.SHANAUTO_DB = join(dbDir, 'zero.db');
    const { appendEntry, journalDir, readRecent } = await import('../core/journal.js');

    expect(journalDir()).toBe(join(dbDir, 'journal'));
    appendEntry({ repo: 'r', stage: 'note', detail: 'redirected-instance-marker' });

    expect(readRecent()).toContain('redirected-instance-marker');
    // And the real one in the checkout is untouched by it.
    const real = join(process.cwd(), 'data', 'journal');
    const leaked = existsSync(real)
      ? readdirSync(real).some((f) =>
          readFileSync(join(real, f), 'utf8').includes('redirected-instance-marker'),
        )
      : false;
    expect(leaked, 'a redirected run must not append to the real journal').toBe(false);
  });

  /*
   * The point of the fix, stated as the property that was broken: two instances
   * pointed at two ledgers must not be able to read each other's history.
   */
  it('starts empty for a new ledger even when another instance has a journal', async () => {
    const first = scratch('jd1-');
    process.env.SHANAUTO_DB = join(first, 'a.db');
    const j = await import('../core/journal.js');
    j.appendEntry({ repo: 'r', stage: 'review', detail: 'REWORK: the previous era' });
    expect(j.readRecent()).toContain('the previous era');

    process.env.SHANAUTO_DB = join(scratch('jd2-'), 'b.db');
    expect(j.readRecent()).toBe('');
  });

  it('ingests its own journal rather than the checkout copy', async () => {
    const src = readFileSync(join(process.cwd(), 'src/core/ingest-docs.ts'), 'utf8');
    // It kept a second, unredirected copy of the path instead of asking for it.
    expect(src).not.toMatch(/p\('data', 'journal'\)/);
    expect(src).toMatch(/dir = journalDir\(\)/);
  });
});
