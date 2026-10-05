/**
 * Vocabulary for query expansion.
 *
 * Memory is searched lexically, so a question phrased differently from the text
 * that was recorded finds nothing: "can the agent run terminal commands" shares
 * no word with "Grant agy shell access". These groups close that gap without an
 * embedding model, an index to keep in sync, or a single provider call.
 *
 * EDIT THIS FILE as the project's vocabulary grows — it is meant to be extended.
 *
 * Each group is a set of terms that mean the same thing HERE. Being wrong is
 * cheap in one direction and expensive in the other: a missing group means a
 * question quietly finds less, while an over-broad group makes unrelated
 * memories match. Prefer tight groups, and keep genuinely distinct concepts
 * apart — `gate` and `test` overlap in practice but are not synonyms.
 */

export const ALIAS_GROUPS: string[][] = [
  // running things
  ['shell', 'command', 'commands', 'terminal', 'bash', 'exec', 'execa', 'subprocess'],
  // the commit gate
  ['gate', 'verify_cmd', 'verifier', 'verification', 'typecheck', 'gating'],
  // the agents
  ['agy', 'antigravity'],
  ['opencode', 'brain', 'planner'],
  ['agent', 'driver', 'executor'],
  // permissions and safety
  ['permission', 'permissions', 'allowlist', 'allow-list', 'deny', 'sandbox', 'skip_permissions'],
  ['killswitch', 'stop', 'halt', 'disabled', 'switched'],
  // scheduling
  ['schedule', 'scheduler', 'cron', 'scheduled', 'work_hours'],
  ['quota', 'requests', 'rate', 'limit', 'throttle', 'tier'],
  // the work pipeline
  ['task', 'tasks', 'micro-task', 'backlog'],
  ['idea', 'ideas', 'inbox', 'milestone', 'epic'],
  ['dropped', 'drop', 'retired', 'abandoned', 'discarded'],
  ['failed', 'failure', 'failing', 'broke', 'broken', 'wrong'],
  ['parked', 'park', 'superseded', 'stale', 'staleness'],
  ['deadlock', 'deadlocked', 'blocked', 'stuck', 'frozen'],
  // memory itself
  ['memory', 'recall', 'remember', 'resolution', 'resolutions'],
  ['rollup', 'rollups', 'summary', 'summaries', 'digest'],
  // git
  ['commit', 'commits', 'committed', 'sha'],
  ['remote', 'origin', 'push', 'pushed', 'github'],
  ['repo', 'repository', 'project', 'codebase'],
  // qualities people ask about
  ['dead', 'unused', 'uncalled', 'unreferenced', 'dead_export'],
  ['test', 'tests', 'testing', 'suite', 'vitest'],
];

/** term -> every group containing it. Built once; the list is small. */
const INDEX: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const group of ALIAS_GROUPS) {
    for (const term of group) {
      const bucket = m.get(term) ?? new Set<string>();
      for (const other of group) if (other !== term) bucket.add(other);
      m.set(term, bucket);
    }
  }
  return m;
})();

export interface WeightedTerm {
  term: string;
  /** 1 for what the user typed, less for anything inferred. */
  weight: number;
}

/**
 * How much an inferred term counts relative to a typed one.
 *
 * Deliberately well under 1. Naive expansion destroys precision: if every alias
 * scored full value, a memory matching three weak synonyms would outrank one
 * matching the exact word the user typed.
 */
export const ALIAS_WEIGHT = 0.4;

/** Cap total expansion, so a broad question cannot end up matching everything. */
const MAX_EXPANDED = 40;

export function expandTerms(terms: string[]): WeightedTerm[] {
  const out: WeightedTerm[] = [];
  const seen = new Set<string>();

  for (const t of terms) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push({ term: t, weight: 1 });
    }
  }

  for (const t of terms) {
    for (const alias of INDEX.get(t) ?? []) {
      if (seen.has(alias) || out.length >= MAX_EXPANDED) continue;
      seen.add(alias);
      out.push({ term: alias, weight: ALIAS_WEIGHT });
    }
  }

  return out;
}
