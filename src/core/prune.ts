import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { p } from '../config.js';
import { log } from '../logger.js';
import { today } from '../util.js';
import type { Repo, RetentionConfig } from '../schemas.js';
import { dropStashBySha, rollbackStashes } from '../git.js';

/**
 * Retention for the three directories that grow forever.
 *
 * Nothing in this system has ever deleted a file. One night of real autonomous
 * work left 8.5 MB in data/artifacts/ alone (ISSUES.md O4), and the storage caps
 * were deliberately removed the same night so the full record would be kept —
 * which was right for recall and made the growth faster. This is the other half
 * of that decision: a way to let go of the old record, opt-in, so the default
 * behaviour of the system is still "keep everything".
 *
 * Three rules make this safe enough to run unattended:
 *
 * 1. Default retention is 0, which means KEEP EVERYTHING. A misread config, an
 *    absent config, or a fresh checkout all delete nothing.
 * 2. The durable memory is unreachable from here. data/shanauto.db and
 *    data/memory/*.jsonl are the only copies of anything that outlives a run,
 *    and losing them cannot be undone from the artifacts — so they are checked
 *    against an explicit deny before every single removal, not merely left out
 *    of the sweep.
 * 3. Nothing throws. Housekeeping must never be the reason a command fails, so
 *    every failure is counted and reported rather than raised.
 */

export type PruneArea = 'journal' | 'artifacts' | 'runs';

/**
 * Directories this may sweep, hardcoded rather than configurable.
 *
 * A retention window is a number in a yaml file; the set of things it can point
 * at must not be.
 */
const PRUNABLE: PruneArea[] = ['journal', 'artifacts', 'runs'];

/**
 * Never removable, at any retention, by any configuration.
 *
 * data/memory/*.jsonl is the export that exists precisely because "infinite
 * memory in one binary file is one corruption away from zero" (memory-export.ts).
 * A prune that ate the backup and the database in the same pass would be the
 * exact failure that export was written to prevent.
 */
const PROTECTED = ['shanauto.db', 'memory'];

/** A file only counts as settled once it has been quiet this long. */
const IN_FLIGHT_MS = 5 * 60_000;

export interface PrunedEntry {
  path: string;
  area: PruneArea;
  /** Local calendar day this entry belongs to. */
  day: string;
  bytes: number;
}

export interface PruneResult {
  /** False when every window is 0 — the default, and the whole point of it. */
  enabled: boolean;
  dryRun: boolean;
  removed: PrunedEntry[];
  /** Bytes reclaimed, or that would be reclaimed under --dry-run. */
  bytes: number;
  /** Entries inside the retention window, still being written, or protected. */
  kept: number;
  errors: string[];
}

/**
 * True if `path` is the durable memory, wherever it sits relative to `dataDir`.
 *
 * Compares resolved paths, so `data/../data/memory/x.jsonl` and a path escaping
 * dataDir entirely both fail closed. Anything outside dataDir is protected too:
 * this function's answer is "may prune delete it", and the answer for the rest
 * of the disk is no.
 */
export function isProtected(path: string, dataDir = p('data')): boolean {
  try {
    const root = resolve(dataDir);
    const full = resolve(path);
    if (full === root) return true;
    if (!full.startsWith(root + sep)) return true;

    const rel = full.slice(root.length + 1).split(/[\\/]/);
    const head = rel[0] ?? '';
    // shanauto.db plus its -wal and -shm siblings, which are the live database
    // just as much as the .db file is.
    if (PROTECTED.some((n) => head === n || head.startsWith(`${n}-`) || head.startsWith(`${n}.`))) {
      return true;
    }
    return !PRUNABLE.includes(head as PruneArea);
  } catch {
    return true; // cannot tell what it is => not allowed to delete it
  }
}

/** Total bytes and newest mtime beneath `path`, following no links. */
function measure(path: string): { bytes: number; newestMs: number } {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return { bytes: st.size, newestMs: st.mtimeMs };
    let bytes = 0;
    let newestMs = st.mtimeMs;
    for (const name of readdirSync(path)) {
      const child = measure(join(path, name));
      bytes += child.bytes;
      newestMs = Math.max(newestMs, child.newestMs);
    }
    return { bytes, newestMs };
  } catch {
    // Unreadable reads as "just written", so an entry we cannot size is kept.
    return { bytes: 0, newestMs: Date.now() };
  }
}

/**
 * The local day N days before `now`. Local, for the reason in util.today.
 *
 * Returns null when the window is not a number of days this calendar can
 * express. A very large value overflows the Date, `today()` then formats
 * "NaN-NaN-NaN", and the keep test — a STRING comparison — reads
 * "2026-08-09" >= "NaN-NaN-NaN" as false, because 'N' sorts above '2'. So the
 * check written to protect recent files rejected every file there was, and a
 * retention window meaning "keep it all for three centuries" deleted the lot.
 * The caller keeps everything when this is null.
 */
function cutoffDay(now: Date, days: number): string | null {
  if (!Number.isFinite(days) || days < 0 || days > 36500) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - days);
  if (Number.isNaN(d.getTime())) return null;
  const day = today(d);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * A journal day and a run log are named for the day they cover, and that name is
 * the truth. mtime is not: the file for the 3rd is appended to all through the
 * 3rd, and a run crossing midnight touches it on the 4th.
 */
const DATED = /^(\d{4}-\d{2}-\d{2})\.(?:md|jsonl)$/;

export function prune(
  // The three file windows only: the stash window is pruneRollbackStashes'.
  retention: Pick<RetentionConfig, 'journal_days' | 'artifact_days' | 'run_log_days'>,
  opts: { dryRun?: boolean; now?: Date } = {},
  dataDir = p('data'),
): PruneResult {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const result: PruneResult = { enabled: false, dryRun, removed: [], bytes: 0, kept: 0, errors: [] };

  try {
    const windows: Record<PruneArea, number> = {
      journal: retention.journal_days,
      artifacts: retention.artifact_days,
      runs: retention.run_log_days,
    };
    result.enabled = PRUNABLE.some((a) => windows[a] > 0);
    if (!result.enabled) return result;

    const openDay = today(now);

    for (const area of PRUNABLE) {
      const days = windows[area];
      if (days <= 0) continue; // 0 means keep everything in this area

      const dir = join(dataDir, area);
      if (!existsSync(dir)) continue;

      const cutoff = cutoffDay(now, days);
      if (cutoff === null) {
        // A window this program cannot express is not permission to delete.
        result.errors.push(
          `${area}: keeping everything — ${days} days is not a retention window this can work with`,
        );
        continue;
      }

      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (e) {
        result.errors.push(`${area}: ${(e as Error).message}`);
        continue;
      }

      for (const name of names) {
        const path = join(dir, name);
        const { bytes, newestMs } = measure(path);

        // An artifact directory is named for a run id, not a date, so its day
        // comes from mtime; a journal or run-log file is named for its day.
        const day = DATED.exec(name)?.[1] ?? today(new Date(newestMs));

        // Today is never old, whatever the window says or the clock did.
        // Ingestion applies the same rule for the same reason: the day is still
        // being written to.
        if (day >= openDay || day >= cutoff) {
          result.kept++;
          continue;
        }
        // Still warm. A run in flight is appending to its artifact directory
        // right now, and its id carries no date to protect it.
        if (now.getTime() - newestMs < IN_FLIGHT_MS) {
          result.kept++;
          continue;
        }
        if (isProtected(path, dataDir)) {
          result.kept++;
          continue;
        }

        if (!dryRun) {
          try {
            rmSync(path, { recursive: true, force: true });
          } catch (e) {
            result.errors.push(`${name}: ${(e as Error).message}`);
            continue;
          }
        }
        result.removed.push({ path, area, day, bytes });
        result.bytes += bytes;
      }
    }
  } catch (e) {
    // Housekeeping never costs a command. Report and carry whatever was done.
    result.errors.push((e as Error).message);
  }

  if (result.removed.length && !dryRun) {
    log.debug(`pruned ${result.removed.length} entr(ies), ${formatBytes(result.bytes)}`);
  }
  return result;
}

export interface StashPruneEntry {
  repo: string;
  sha: string;
  label: string;
  /** Local calendar day the rollback was taken. */
  day: string;
}

export interface StashPruneResult {
  /** False when the window is 0 — the default, as everywhere else here. */
  enabled: boolean;
  dryRun: boolean;
  removed: StashPruneEntry[];
  /** Rollback stashes inside the window, or no longer there to drop. */
  kept: number;
  errors: string[];
}

/**
 * Let go of rollback stashes older than the window, in every allowlisted repo.
 *
 * `rollback` stashes an agent's rejected work rather than deleting it, which is
 * right — it is the only place that work survives — and nothing ever gave any of
 * it back. 43 piled up in one project in three weeks, and when they were cleared
 * by hand on 2026-08-27, six more had arrived within three hours. A
 * rejected attempt is retried at once, so by the time one is weeks old the task
 * has long since landed or been dropped, and the stash is a record nobody reads.
 *
 * The same three rules as the file sweep above, plus two of its own:
 *
 * 1. A window of 0 keeps everything, and 0 is the default.
 * 2. Only `shanauto-rollback` stashes, matched exactly — never an autostash,
 *    which can hold the owner's own work, and never the owner's own stashes.
 *    Only repos in the allowlist are read at all.
 * 3. Nothing throws. A repo that cannot be read is reported and skipped.
 * 4. Every drop is by SHA, re-resolved immediately before it — see
 *    `dropStashBySha` for why a position read earlier is not safe to use.
 * 5. A dropped stash is reported with its SHA. That SHA is the way back:
 *    `git stash apply <sha>` works until git's garbage collection removes the
 *    unreachable commit, typically a further two weeks.
 */
export async function pruneRollbackStashes(
  repos: Repo[],
  days: number,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<StashPruneResult> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const result: StashPruneResult = { enabled: days > 0, dryRun, removed: [], kept: 0, errors: [] };
  if (!result.enabled) return result;

  const cutoff = cutoffDay(now, days);
  if (cutoff === null) {
    result.errors.push(
      `rollback stashes: keeping everything — ${days} days is not a retention window this can work with`,
    );
    return result;
  }
  const openDay = today(now);

  for (const repo of repos) {
    let stashes;
    try {
      stashes = await rollbackStashes(repo);
    } catch (e) {
      result.errors.push(`${repo.id}: could not read its stashes — ${(e as Error).message}`);
      continue;
    }

    for (const s of stashes) {
      const day = today(s.created);
      // Today is never old, the same rule the file sweep applies.
      if (day >= openDay || day >= cutoff) {
        result.kept++;
        continue;
      }
      if (!dryRun) {
        try {
          if (!(await dropStashBySha(repo, s.sha))) {
            // Gone already, or no longer where we can prove it is: leave it.
            result.kept++;
            continue;
          }
        } catch (e) {
          result.errors.push(`${repo.id}: ${s.sha.slice(0, 8)} — ${(e as Error).message}`);
          continue;
        }
      }
      result.removed.push({ repo: repo.id, sha: s.sha, label: s.label, day });
    }
  }

  if (result.removed.length && !dryRun) {
    log.debug(`pruned ${result.removed.length} rollback stash(es)`);
  }
  return result;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
