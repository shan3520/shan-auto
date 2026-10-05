import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prune, isProtected, formatBytes } from '../core/prune.js';
import type { RetentionConfig } from '../schemas.js';

/**
 * Everything here runs against a throwaway directory passed as the last
 * argument. Nothing in this file may ever see the real data/ — this is the one
 * module in the system that deletes, and a test that pointed it at the project
 * would destroy the durable memory it is supposed to protect.
 */
const root = mkdtempSync(join(tmpdir(), 'sa-prune-'));

/** 8 Aug 2026, 09:00 local — the day the storage-caps decision was made. */
const NOW = new Date(2026, 7, 8, 9, 0);
const daysAgo = (n: number, h = 20) => new Date(2026, 7, 8 - n, h, 0);

const KEEP_ALL: RetentionConfig = { journal_days: 0, artifact_days: 0, run_log_days: 0, rollback_stash_days: 0 };
const WEEK: RetentionConfig = { journal_days: 7, artifact_days: 7, run_log_days: 7, rollback_stash_days: 0 };

function put(rel: string, body: string, mtime: Date): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  utimesSync(path, mtime, mtime);
  return path;
}

/** Give a directory (and its contents) an explicit age. */
function age(rel: string, mtime: Date): void {
  utimesSync(join(root, rel), mtime, mtime);
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // Working record, named for the day it covers.
  put('journal/2026-08-08.md', 'today, still open\n', daysAgo(0, 9));
  put('journal/2026-08-01.md', `${'j'.repeat(1000)}\n`, daysAgo(7));
  put('journal/2026-07-31.md', `${'j'.repeat(2000)}\n`, daysAgo(8));
  put('journal/2026-07-01.md', `${'j'.repeat(4000)}\n`, daysAgo(38));

  put('runs/2026-08-08.jsonl', '{"msg":"open"}\n', daysAgo(0, 9));
  put('runs/2026-07-31.jsonl', '{"msg":"closed"}\n', daysAgo(8));

  // Artifacts are named for a run id, so only mtime says how old they are.
  put('artifacts/r-old/1-brain-decompose.md', 'x'.repeat(500), daysAgo(20));
  age('artifacts/r-old', daysAgo(20));
  put('artifacts/r-live/1-agent-agy.md', 'being written right now', NOW);
  age('artifacts/r-live', NOW);

  // The durable memory. Deliberately old, so only the guard keeps it.
  put('memory/shanauto-2024.jsonl', '{"type":"resolution"}\n', daysAgo(400));
  put('shanauto.db', 'SQLite format 3\0', daysAgo(400));
  put('shanauto.db-wal', 'wal', daysAgo(400));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('prune keeps everything by default', () => {
  it('deletes nothing when every window is 0', () => {
    const r = prune(KEEP_ALL, { now: NOW }, root);
    expect(r.enabled).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.bytes).toBe(0);
    expect(existsSync(join(root, 'journal/2026-07-01.md'))).toBe(true);
  });

  it('leaves an area alone when only that area is 0', () => {
    // Journal retention on, artifacts off: the 8.5 MB that started this stays.
    const r = prune({ journal_days: 7, artifact_days: 0, run_log_days: 0 }, { now: NOW }, root);
    expect(existsSync(join(root, 'artifacts/r-old'))).toBe(true);
    expect(existsSync(join(root, 'runs/2026-07-31.jsonl'))).toBe(true);
    expect(r.removed.every((e) => e.area === 'journal')).toBe(true);
  });
});

describe('prune retention boundary', () => {
  it('keeps a day exactly at the edge of the window', () => {
    prune(WEEK, { now: NOW }, root);
    expect(existsSync(join(root, 'journal/2026-08-01.md'))).toBe(true);
  });

  it('removes the day just outside it', () => {
    prune(WEEK, { now: NOW }, root);
    expect(existsSync(join(root, 'journal/2026-07-31.md'))).toBe(false);
    expect(existsSync(join(root, 'journal/2026-07-01.md'))).toBe(false);
  });

  it('dates a journal file by its NAME, not its mtime', () => {
    // A run crossing midnight touches yesterday's file today. If mtime decided,
    // an old day would look new and never be reclaimed.
    utimesSync(join(root, 'journal/2026-07-01.md'), daysAgo(0, 8), daysAgo(0, 8));
    const r = prune(WEEK, { now: NOW }, root);
    expect(r.removed.find((e) => e.path.endsWith('2026-07-01.md'))?.day).toBe('2026-07-01');
  });

  it('reports the bytes it reclaimed', () => {
    const r = prune(WEEK, { now: NOW }, root);
    // 2000 + 4000 journal bytes, plus newlines, plus the closed run log.
    expect(r.bytes).toBeGreaterThan(6000);
    expect(r.bytes).toBe(r.removed.reduce((n, e) => n + e.bytes, 0));
  });
});

describe('prune never touches work in progress', () => {
  it("keeps today's journal and run log even at a one-day window", () => {
    prune({ journal_days: 1, artifact_days: 1, run_log_days: 1 }, { now: NOW }, root);
    expect(existsSync(join(root, 'journal/2026-08-08.md'))).toBe(true);
    expect(existsSync(join(root, 'runs/2026-08-08.jsonl'))).toBe(true);
  });

  it('keeps an artifact directory a run is still writing to', () => {
    // r-live has no date in its name and belongs to the run happening now.
    prune({ journal_days: 1, artifact_days: 1, run_log_days: 1 }, { now: NOW }, root);
    expect(existsSync(join(root, 'artifacts/r-live'))).toBe(true);
  });

  it('keeps an old-dated file that was touched seconds ago', () => {
    // Its name says July, but something has it open. The name loses here.
    const warm = new Date(NOW.getTime() - 30_000);
    utimesSync(join(root, 'journal/2026-07-01.md'), warm, warm);
    prune(WEEK, { now: NOW }, root);
    expect(existsSync(join(root, 'journal/2026-07-01.md'))).toBe(true);
  });

  it('does reclaim an artifact directory from a finished run', () => {
    const r = prune(WEEK, { now: NOW }, root);
    expect(existsSync(join(root, 'artifacts/r-old'))).toBe(false);
    expect(r.removed.some((e) => e.area === 'artifacts')).toBe(true);
  });
});

describe('prune --dry-run', () => {
  it('removes nothing at all', () => {
    const r = prune(WEEK, { now: NOW, dryRun: true }, root);
    expect(r.dryRun).toBe(true);
    expect(r.removed.length).toBeGreaterThan(0);
    for (const e of r.removed) expect(existsSync(e.path)).toBe(true);
  });

  it('reports the same bytes the real run would reclaim', () => {
    const dry = prune(WEEK, { now: NOW, dryRun: true }, root);
    const wet = prune(WEEK, { now: NOW }, root);
    expect(dry.bytes).toBe(wet.bytes);
    expect(dry.removed.map((e) => e.path)).toEqual(wet.removed.map((e) => e.path));
  });
});

describe('the durable memory is unreachable from prune', () => {
  /*
   * data/shanauto.db and data/memory/*.jsonl are the only copies of anything
   * that outlives a run. The artifacts can be regenerated by running again;
   * these cannot be regenerated at all.
   */
  it('leaves shanauto.db and its wal alone at the most aggressive setting', () => {
    prune({ journal_days: 1, artifact_days: 1, run_log_days: 1 }, { now: NOW }, root);
    expect(readFileSync(join(root, 'shanauto.db'), 'utf8')).toContain('SQLite format 3');
    expect(existsSync(join(root, 'shanauto.db-wal'))).toBe(true);
  });

  it('leaves the memory export alone, however old it is', () => {
    prune({ journal_days: 1, artifact_days: 1, run_log_days: 1 }, { now: NOW }, root);
    expect(readFileSync(join(root, 'memory/shanauto-2024.jsonl'), 'utf8')).toContain('resolution');
  });

  it('refuses the database and the memory export by name', () => {
    expect(isProtected(join(root, 'shanauto.db'), root)).toBe(true);
    expect(isProtected(join(root, 'shanauto.db-wal'), root)).toBe(true);
    expect(isProtected(join(root, 'shanauto.db-shm'), root)).toBe(true);
    expect(isProtected(join(root, 'memory'), root)).toBe(true);
    expect(isProtected(join(root, 'memory', 'shanauto-2024.jsonl'), root)).toBe(true);
  });

  it('refuses a path that walks back into the memory through a prunable dir', () => {
    expect(isProtected(join(root, 'journal', '..', 'memory', 'x.jsonl'), root)).toBe(true);
    expect(isProtected(join(root, 'artifacts', '..', 'shanauto.db'), root)).toBe(true);
  });

  it('refuses anything outside the data directory, including the data dir itself', () => {
    expect(isProtected(root, root)).toBe(true);
    expect(isProtected(join(root, '..'), root)).toBe(true);
    expect(isProtected(join(root, '..', 'src'), root)).toBe(true);
  });

  it('permits exactly the three working directories', () => {
    expect(isProtected(join(root, 'journal', '2026-01-01.md'), root)).toBe(false);
    expect(isProtected(join(root, 'artifacts', 'r-1'), root)).toBe(false);
    expect(isProtected(join(root, 'runs', '2026-01-01.jsonl'), root)).toBe(false);
    // Anything else under data/ — reports/, browser-profile/ — is not its business.
    expect(isProtected(join(root, 'reports', 'ledger.csv'), root)).toBe(true);
  });
});

describe('prune never throws', () => {
  it('survives a data directory that does not exist', () => {
    const r = prune(WEEK, { now: NOW }, join(root, 'no-such-dir'));
    expect(r.removed).toEqual([]);
    expect(r.bytes).toBe(0);
  });

  it('survives an empty data directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sa-prune-empty-'));
    expect(() => prune(WEEK, { now: NOW }, empty)).not.toThrow();
    rmSync(empty, { recursive: true, force: true });
  });

  it('ignores unexpected junk sitting in a working directory', () => {
    put('journal/notes.txt', 'hand-written, no date in the name', daysAgo(90));
    put('runs/README', 'why this directory exists', daysAgo(90));
    expect(() => prune(WEEK, { now: NOW }, root)).not.toThrow();
  });
});

describe('formatBytes', () => {
  it('reports the reclaimed size in units a person reads', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(8.5 * 1024 * 1024)).toBe('8.5 MB');
  });
});
