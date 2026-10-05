import { z } from 'zod';
import type { Resolution } from '../ledger.js';
import * as ledger from '../ledger.js';
import type { BrainDriver } from '../drivers/contracts.js';
import { fill, prompt } from '../config.js';
import { log } from '../logger.js';
import { untrusted } from '../util.js';

const NarrativeSchema = z.object({ narrative: z.string() });

/**
 * Compress a period of memories into something still readable years later.
 *
 * Storage was never the constraint — 135 bytes a memory means three years costs
 * 4.2 MB. Usefulness is: by 2027 there would be ~11,000 rows and the signal
 * would be invisible. A question about last March should read one summary, not
 * nine hundred commits.
 *
 * The statistics here are deterministic and cost nothing. A narrative sentence
 * is added separately by one model call per closed period.
 */

export type Period = 'day' | 'week' | 'month';

export interface RollupStats {
  total: number;
  byKind: Record<string, number>;
  topPaths: [string, number][];
  topSymbols: [string, number][];
  /** Reasons worth carrying forward verbatim: decisions and incidents. */
  highlights: string[];
}

/** UTC period boundaries. Weeks start Monday, matching ISO. */
export function periodBounds(period: Period, at: Date): { starts: Date; ends: Date } {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

  if (period === 'day') {
    return { starts: d, ends: new Date(d.getTime() + 86_400_000) };
  }
  if (period === 'week') {
    // getUTCDay: 0 = Sunday. Shift so Monday is day 0.
    const shift = (d.getUTCDay() + 6) % 7;
    const starts = new Date(d.getTime() - shift * 86_400_000);
    return { starts, ends: new Date(starts.getTime() + 7 * 86_400_000) };
  }
  const starts = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const ends = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { starts, ends };
}

function topN(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

/**
 * Pure: takes the memories, returns the statistics. No I/O, so the arithmetic is
 * testable without a database.
 */
export function computeStats(memories: Resolution[]): RollupStats {
  const byKind: Record<string, number> = {};
  const paths = new Map<string, number>();
  const symbols = new Map<string, number>();
  const highlights: string[] = [];

  for (const m of memories) {
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;

    for (const p of m.paths ?? []) {
      if (typeof p === 'string' && p.trim()) paths.set(p, (paths.get(p) ?? 0) + 1);
    }
    for (const s of m.symbols ?? []) {
      if (typeof s === 'string' && s.trim()) symbols.set(s, (symbols.get(s) ?? 0) + 1);
    }

    // Counts tell you how much happened; these tell you what actually mattered.
    if ((m.kind === 'decision' || m.kind === 'incident') && m.reason) {
      highlights.push(m.reason.split('\n')[0]!.slice(0, 140));
    }
  }

  return {
    total: memories.length,
    byKind,
    topPaths: topN(paths, 8),
    topSymbols: topN(symbols, 8),
    highlights: highlights.slice(0, 10),
  };
}

/**
 * Build every closed period from the first memory up to now.
 *
 * Only CLOSED periods are rolled up — a period still in progress would produce a
 * summary that is wrong an hour later, and rebuilding it forever is waste.
 * Upsert semantics make re-running safe.
 */
export function buildRollups(repo: string, period: Period, now = new Date()): number {
  const earliest = ledger.earliestResolutionAt(repo);
  if (!earliest) return 0;

  const openPeriodStart = periodBounds(period, now).starts;
  const all = ledger.resolutionsBetween(repo, earliest, now.toISOString());
  if (all.length === 0) return 0;

  /*
   * One ordered pass, bucketed in JS, instead of one query per period (PERF-7).
   * resolutionsBetween already orders by COALESCE(occurred_at, resolved_at), so
   * each resolution lands in the same period the old loop would have queried
   * for it. The old code had a silent 5000-period cap; with no per-period query
   * there is no loop to cap, and the only bound left is the row count itself.
   */
  const buckets = new Map<string, Resolution[]>();
  for (const m of all) {
    // occurred_at may be an empty string in a legacy row; fall back to resolved_at.
    const t = m.occurred_at && m.occurred_at.length ? m.occurred_at : m.resolved_at;
    const at = new Date(t);
    const { starts } = periodBounds(period, at);
    const key = starts.toISOString();
    const bucket = buckets.get(key);
    if (bucket) bucket.push(m);
    else buckets.set(key, [m]);
  }

  let built = 0;
  for (const [key, memories] of buckets) {
    const starts = new Date(key);
    if (starts.getTime() >= openPeriodStart.getTime()) continue; // period still open
    const { ends } = periodBounds(period, starts);
    ledger.saveRollup({
      repo,
      period,
      starts_at: key,
      ends_at: ends.toISOString(),
      stats: computeStats(memories),
      source_count: memories.length,
    });
    built++;
  }
  return built;
}

/**
 * Add a human sentence to closed periods that lack one.
 *
 * The statistics say how much happened; a narrative says what it *was*, which is
 * what someone actually wants back in a year. This is the only part of the
 * memory feature that costs a model call, and it is bounded by design: one call
 * per closed period, so roughly 52 weekly and 12 monthly a year.
 *
 * Narratives are optional. If the brain is unavailable the stats stand on their
 * own, so this must never be the reason a command fails.
 */
export async function narrateRollups(
  repo: string,
  brain: BrainDriver,
  limit = 10,
): Promise<{ narrated: number; failed: number }> {
  const pending = ledger.rollupsNeedingNarrative(repo, limit);
  let narrated = 0;
  let failed = 0;

  for (const r of pending) {
    let stats: RollupStats;
    try {
      stats = JSON.parse(r.stats) as RollupStats;
    } catch {
      failed++;
      continue;
    }

    const text = fill(prompt('narrate'), {
      PERIOD: r.period,
      STARTS: r.starts_at.slice(0, 10),
      REPO: repo,
      STATS: renderStats(stats),
      // Highlights are model-written resolution reasons — DATA, not instructions (SEC-4).
      HIGHLIGHTS: untrusted('HIGHLIGHTS', stats.highlights?.length ? stats.highlights.join('\n') : '(none)'),
    });

    try {
      const out = await brain.ask(text, NarrativeSchema, `narrate-${r.period}`);
      const n = out.narrative.trim();
      if (n) {
        ledger.setRollupNarrative(r.id, n.slice(0, 600));
        narrated++;
      }
    } catch (e) {
      // A period without a narrative is still a useful period.
      log.warn(`could not narrate ${r.period} ${r.starts_at.slice(0, 10)}: ${(e as Error).message}`);
      failed++;
    }
  }
  return { narrated, failed };
}

/** One-line rendering used in retrieval context and in `sa rollup` output. */
export function renderStats(s: RollupStats): string {
  if (s.total === 0) return 'nothing recorded';
  const kinds = Object.entries(s.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  const files = s.topPaths.slice(0, 4).map(([p]) => p).join(', ');
  return [`${s.total} memories (${kinds})`, files ? `most active: ${files}` : '']
    .filter(Boolean)
    .join(' · ');
}
