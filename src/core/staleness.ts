import type { Resolution, TaskClaim } from '../ledger.js';

/**
 * Decide whether a queued task is still worth dispatching.
 *
 * Measured over one session: 41 of 51 dropped tasks were work that had already
 * been done by the time they ran — usually because the repo owner fixed it by
 * hand while the task sat queued. The agent does notice and reports
 * ALREADY_DONE, but only after spending a provider request to find out. Under a
 * requests-per-day ceiling that wasted dispatch *is* the loss, so this check has
 * to be deterministic and run before the driver is touched.
 *
 * Deliberately pure: no git, no database, no clock. The delta is passed in, so
 * every verdict is reproducible from its arguments alone and the table below is
 * the whole specification.
 */

export type Verdict = 'FRESH' | 'SUPERSEDED' | 'DRIFTED';

export interface StalenessResult {
  verdict: Verdict;
  /** Human-readable, names the commit and symbol responsible. Empty when FRESH. */
  evidence: string;
  supersededBy?: { sha: string | null; symbol: string };
  /*
   * The commit that moved the ground under a DRIFTED task, and the task that
   * made it. `taskId` is the whole point: it is what turns "this file changed"
   * into "this file changed because something this run already promised", which
   * is a different sentence and wants a different response. Null for a commit
   * that arrived from outside this system.
   */
  driftedBy?: { sha: string | null; path: string; taskId: string | null };
}

const FRESH: StalenessResult = { verdict: 'FRESH', evidence: '' };

/*
 * Both normalisers tolerate non-strings. The arrays they receive come from
 * JSON.parse of a database column that a model ultimately populated, so a null
 * or a number in there is entirely possible — and throwing mid-dispatch would
 * be the one outcome this check must never produce.
 */

/** Paths compare case- and separator-insensitively; Windows and git disagree. */
const normPath = (s: unknown) => (typeof s === 'string' ? s.trim().replace(/\\/g, '/').toLowerCase() : '');
/** Symbols are JS identifiers — case is significant. */
const normSym = (s: unknown) => (typeof s === 'string' ? s.trim() : '');

/**
 * @param claim     what the task said it would produce, or null if it said nothing
 * @param planHead  repo HEAD when the task was planned, or null if unrecorded
 * @param currentHead repo HEAD right now, read after ensureClean
 * @param delta     resolutions recorded since planHead — the caller's job to scope
 *
 * Fails open in every ambiguous case. A false SUPERSEDED silently parks live
 * work; a false FRESH costs one provider request, which is merely the status
 * quo. This may only ever reduce waste, never create it.
 */
export function assessStaleness(
  claim: TaskClaim | null,
  planHead: string | null,
  currentHead: string | null,
  delta: Resolution[],
): StalenessResult {
  // No claim, no opinion. Tasks planned before this feature existed land here.
  if (!claim) return FRESH;

  // Nothing has landed since the task was planned, so nothing can have
  // superseded it. Cheapest and by far the most common case.
  if (planHead && currentHead && planHead === currentHead) return FRESH;

  // Without a baseline there is no meaningful "since", so no claim of staleness
  // can be justified.
  if (!planHead) return FRESH;

  const claimedSymbols = (claim.symbols ?? []).map(normSym).filter(Boolean);
  const claimedPaths = (claim.paths ?? []).map(normPath).filter(Boolean);
  if (claimedSymbols.length === 0 && claimedPaths.length === 0) return FRESH;
  if (!delta || delta.length === 0) return FRESH;

  // A claimed symbol that something else has since exported is the strong
  // signal: the thing this task was going to create now exists.
  for (const sym of claimedSymbols) {
    for (const r of delta) {
      const hit = (r?.symbols ?? []).map(normSym).find((s) => s && s === sym);
      if (hit) {
        const where = r.commit_sha ? r.commit_sha.slice(0, 8) : r.kind;
        const why = r.reason ? ` (${r.reason.split('\n')[0]!.slice(0, 60)})` : '';
        return {
          verdict: 'SUPERSEDED',
          evidence: `"${hit}" was already exported by ${where}${why}`,
          supersededBy: { sha: r.commit_sha, symbol: hit },
        };
      }
    }
  }

  // The files moved but the thing itself is absent: the task may still be valid,
  // just written against a stale picture of the code. Dispatch anyway — the
  // agent is better placed to judge — but say so.
  for (const path of claimedPaths) {
    for (const r of delta) {
      if ((r?.paths ?? []).map(normPath).some((p) => p && p === path)) {
        const where = r.commit_sha ? r.commit_sha.slice(0, 8) : r.kind;
        return {
          verdict: 'DRIFTED',
          evidence: `${path} changed in ${where} since this task was planned`,
          driftedBy: { sha: r.commit_sha, path, taskId: r.task_id ?? null },
        };
      }
    }
  }

  return FRESH;
}
