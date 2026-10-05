import type { Resolution, RollupRow } from '../ledger.js';
import { renderStats, type RollupStats } from './rollup.js';
import { expandTerms, type WeightedTerm } from './aliases.js';

/**
 * Assemble the context for a question about the project's history.
 *
 * Deterministic on purpose: no embeddings, no vector store, no model call. The
 * ranking is keyword overlap with a mild recency tilt, which is inspectable and
 * testable in a way a similarity score is not. Revisit only with evidence that
 * it is genuinely insufficient — not because a vector database sounds better.
 *
 * Rollups are preferred for older periods so a question about last March costs
 * one summary rather than nine hundred commits.
 */

const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','what','why','how','when',
  'do','does','did','is','are','was','were','be','been','it','its','this','that','about',
  'you','i','we','know','tell','me','project','anything','something','there','their',
]);

/** Below this many keyword hits, a question is treated as broad. */
const THIN_RESULT = 6;

/**
 * Ceiling on what synonyms can contribute in total. Deliberately under 1, so a
 * single exact match always outranks any quantity of inferred ones.
 */
const MAX_INFERRED_SCORE = 0.9;

export interface RetrievedContext {
  text: string;
  used: number;
  candidates: number;
}

export function terms(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9_./\-\s]/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 12);
}

/**
 * Overlap plus a gentle recency tilt — recent work matters more, old work must
 * still surface.
 *
 * Accepts weighted terms so an inferred synonym counts for less than a word the
 * user actually typed. Plain strings are still accepted and weigh 1.
 */
export function scoreText(
  text: string,
  qterms: (string | WeightedTerm)[],
  ageDays: number,
): number {
  if (qterms.length === 0) return 0;
  const hay = text.toLowerCase();

  /*
   * Exact and inferred matches are scored separately, and the inferred total is
   * capped below the value of a single exact hit.
   *
   * Simply weighting synonyms lower is not enough: at 0.4 each, a memory reading
   * "terminal subprocess via exec" scored 1.2 and beat "grant shell access" on
   * 1.0 — three weak matches outranking the word actually typed. Lowering the
   * weight only moves the threshold; capping the total removes the failure.
   */
  let exact = 0;
  let inferred = 0;
  for (const q of qterms) {
    const { term, weight } = typeof q === 'string' ? { term: q, weight: 1 } : q;
    if (!hay.includes(term)) continue;
    if (weight >= 1) exact += weight;
    else inferred += weight;
  }

  const hits = exact + Math.min(inferred, MAX_INFERRED_SCORE);
  if (hits === 0) return 0;

  // Deliberately shallow: a year-old decision must still beat a fresh but
  // irrelevant commit, so recency breaks ties rather than dominating.
  const recency = 1 / (1 + Math.max(0, ageDays) / 365);
  return hits + recency * 0.5;
}

/** How much of a memory is shown once it has matched. */
const SNIPPET = 400;

/**
 * Everything in a memory that is worth matching against — the whole reason, not
 * its opening lines.
 *
 * Scoring used to run over the *display* form, which was capped at 400
 * characters. Measured against the real store, that meant 7.9% of the longest
 * decision was searchable and the remaining 92% scored zero: a word in its tail
 * was unreachable. It appeared to work only because the thin-result fallback
 * happens to include every decision, and there are four of them. Anything long
 * and numerous — a work journal — would have failed silently.
 */
function memoryText(r: Resolution): string {
  const what = [...(r.symbols ?? []), ...(r.paths ?? [])].join(', ');
  return `${r.kind} ${what} ${r.reason ?? ''}`;
}

/** Occurrences considered per term. Enough to find the dense part, cheaply. */
const MAX_POSITIONS = 40;

/**
 * The window where the most of the question is answered — not the first match.
 *
 * "First match" is fine for a short memory and useless for a long one. Measured
 * on a simulated three years of whole-day journals (128 KB each), a question
 * about a gate rejection scored those days highly and then showed the wrong
 * 400 characters every time: the first hit was a common word near the top, so
 * the answer never appeared in the retrieved text at all. Nothing failed
 * loudly; the memory simply stopped being able to answer.
 *
 * So candidate positions are ranked by how many DISTINCT query terms fall
 * inside the window, exact matches counting for more than inferred ones.
 */
export function snippet(text: string, qterms: (string | WeightedTerm)[], max = SNIPPET): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;

  const hay = flat.toLowerCase();
  const terms = qterms.map((q) => (typeof q === 'string' ? { term: q, weight: 1 } : q));

  const positions: number[] = [];
  for (const { term } of terms) {
    let i = hay.indexOf(term);
    for (let n = 0; i >= 0 && n < MAX_POSITIONS; n++) {
      positions.push(i);
      i = hay.indexOf(term, i + term.length);
    }
  }
  if (positions.length === 0) return `${flat.slice(0, max)}…`;

  let best = positions[0]!;
  let bestScore = -1;
  for (const at of positions) {
    const start = Math.max(0, at - Math.floor(max / 3));
    const window = hay.slice(start, start + max);
    let score = 0;
    for (const { term, weight } of terms) if (window.includes(term)) score += weight;
    // Ties go to the earlier position, which reads more naturally.
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }

  // Lead in slightly before the match so it reads in context.
  const start = Math.max(0, best - Math.floor(max / 3));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + max)}${start + max < flat.length ? '…' : ''}`;
}

function memoryLine(r: Resolution, qterms: (string | WeightedTerm)[] = []): string {
  const when = (r.occurred_at ?? r.resolved_at ?? '').slice(0, 10);
  const what = [...(r.symbols ?? []), ...(r.paths ?? [])].slice(0, 5).join(', ');
  const why = snippet(r.reason ?? '', qterms);
  return `[${when}] ${r.kind}${what ? ` (${what})` : ''}: ${why}`.trim();
}

function rollupLine(r: RollupRow): string {
  let stats = '';
  try {
    stats = renderStats(JSON.parse(r.stats) as RollupStats);
  } catch {
    stats = '';
  }
  const when = r.starts_at.slice(0, 10);
  return `[${when}] ${r.period} summary: ${r.narrative ?? stats}`.slice(0, 500);
}

/**
 * @param maxChars hard cap. Everything downstream is one prompt, so this is the
 *                 only thing standing between a year of history and a blown call.
 */
export function buildContext(
  question: string,
  memories: Resolution[],
  rollups: RollupRow[],
  now = new Date(),
  maxChars = 6000,
): RetrievedContext {
  // Expanded, so "can the agent run terminal commands" reaches a memory that
  // says "shell access". Synonyms weigh less than the words actually typed.
  const q = expandTerms(terms(question));
  const age = (iso: string | null | undefined) =>
    iso ? (now.getTime() - new Date(iso).getTime()) / 86_400_000 : 9999;

  const scored: { score: number; line: string }[] = [];

  for (const r of rollups) {
    const line = rollupLine(r);
    // Rollups are the compressed view of a whole period, so they earn a small
    // bonus: one of them can answer what fifty raw commits would.
    const s = scoreText(line, q, age(r.starts_at));
    if (s > 0) scored.push({ score: s + 0.75, line });
  }

  for (const m of memories) {
    // Score the whole memory, show the part that matched.
    let s = scoreText(memoryText(m), q, age(m.occurred_at ?? m.resolved_at));
    const line = memoryLine(m, q);
    // Decisions and incidents are the reasoning, which is usually what is being
    // asked for; commits are the mechanics.
    if (s > 0 && (m.kind === 'decision' || m.kind === 'incident')) s += 1;
    if (s > 0) scored.push({ score: s, line });
  }

  scored.sort((a, b) => b.score - a.score);

  /*
   * Keyword scoring collapses on broad questions.
   *
   * "What do you know about the shanauto project?" scored only three hits,
   * because a project's memories rarely contain the project's own name — and
   * that is precisely the question this feature exists to answer. When matching
   * is thin, fall back to what a person would actually summarise from: the
   * period narratives, then the decisions and incidents, newest first.
   *
   * Supplements rather than replaces, so a precise question keeps its precise
   * hits at the top.
   */
  const seen = new Set(scored.map((s) => s.line));
  if (scored.length < THIN_RESULT) {
    const overview: string[] = [
      ...rollups
        .filter((r) => r.narrative)
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
        .map(rollupLine),
      ...memories
        .filter((m) => m.kind === 'decision' || m.kind === 'incident')
        .sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''))
        // Not `.map(memoryLine)` — map would pass the array index as qterms.
        .map((m) => memoryLine(m, q)),
    ];
    for (const line of overview) {
      if (!seen.has(line)) {
        seen.add(line);
        scored.push({ score: -1, line }); // after the real matches
      }
    }
  }

  const out: string[] = [];
  let used = 0;
  for (const { line } of scored) {
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }

  return { text: out.join('\n'), used, candidates: out.length };
}
