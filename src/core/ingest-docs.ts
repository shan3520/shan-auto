import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { p, dataRoot } from '../config.js';
import * as ledger from '../ledger.js';
import { log } from '../logger.js';
import { today } from '../util.js';
import { journalDays, journalDir, readDay } from './journal.js';

/**
 * Turn the written record into memory.
 *
 * `docs/DECISIONS.md` already contains the reasoning behind every significant
 * choice — why agy has shell access, why FTS5 was rejected, why the gate runs
 * before dispatch. None of that appears in a commit, and it is exactly what
 * someone asks about a year later. Parsing it is the cheapest large gain
 * available: the thinking is already written down, it simply is not retrievable.
 *
 * Deterministic and idempotent. No model call.
 */

/** `## 2026-08-07 — Grant agy shell access` */
const HEADING = /^##\s+(?:(\d{4}-\d{2}-\d{2})\s*[—–-]\s*)?(.+?)\s*$/;

export interface DocIngestResult {
  ingested: number;
  skipped: number;
}

/**
 * Split a markdown file on `##` headings.
 * Exported for testing: heading parsing is where this will break first.
 */
export function parseDecisionSections(md: string): { date: string | null; title: string; body: string }[] {
  const out: { date: string | null; title: string; body: string }[] = [];
  let current: { date: string | null; title: string; body: string[] } | null = null;

  for (const line of md.split('\n')) {
    const m = line.match(HEADING);
    if (m) {
      if (current) out.push({ ...current, body: current.body.join('\n').trim() });
      current = { date: m[1] ?? null, title: (m[2] ?? '').trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) out.push({ ...current, body: current.body.join('\n').trim() });

  return out.filter((s) => s.title && s.body.length > 40);
}

/**
 * Ingest decision records. Idempotent on the section title: re-running after the
 * file grows adds only the new sections.
 */
export function ingestDecisions(repo: string, file = p('docs', 'DECISIONS.md')): DocIngestResult {
  if (!existsSync(file)) return { ingested: 0, skipped: 0 };

  let sections: ReturnType<typeof parseDecisionSections>;
  try {
    sections = parseDecisionSections(readFileSync(file, 'utf8'));
  } catch (e) {
    log.warn(`could not read ${file}: ${(e as Error).message}`);
    return { ingested: 0, skipped: 0 };
  }

  const known = new Set(
    ledger
      .recentResolutions(repo, 2000)
      .filter((r) => r.kind === 'decision')
      .map((r) => (r.reason ?? '').split('\n')[0]),
  );

  let ingested = 0;
  let skipped = 0;

  for (const s of sections) {
    const headline = s.date ? `${s.date} — ${s.title}` : s.title;
    if (known.has(headline)) {
      skipped++;
      continue;
    }
    /*
     * Stored whole, deliberately not truncated.
     *
     * A 1200-char cap looked prudent and was wrong: it cut the agy decision
     * mid-record, so "the restricted Windows account was declined" — the single
     * most important sentence in it — became unsearchable. Decisions are the
     * highest-value and lowest-volume memory here (four of them, ~1KB each);
     * truncating the one thing worth keeping in full saves nothing. Retrieval
     * caps context separately, so this cannot bloat a prompt.
     */
    ledger.remember({
      repo,
      kind: 'decision',
      reason: `${headline}\n${s.body}`,
      // The date in the heading is when the decision was actually made, which is
      // rarely the day the file happens to get ingested.
      occurred_at: s.date ? `${s.date}T12:00:00.000Z` : undefined,
    });
    ingested++;
  }

  if (ingested) log.debug(`ingested ${ingested} decision(s) from ${file}`);
  return { ingested, skipped };
}

/**
 * Terminal outcomes from run logs — not every line, only what a run concluded.
 *
 * `data/runs/*.jsonl` holds one JSON object per log line. The interesting ones
 * are the summaries and the stop reasons; everything else is noise a year later.
 */
const INTERESTING = /Run complete|Stopping run|Killswitch|Outside work hours|ceiling|deadlock/i;

export function ingestRunLogs(repo: string, dir = join(dataRoot(), 'runs')): DocIngestResult {
  if (!existsSync(dir)) return { ingested: 0, skipped: 0 };

  const known = new Set(
    ledger
      .recentResolutions(repo, 2000)
      .filter((r) => r.kind === 'incident')
      .map((r) => r.reason),
  );

  let ingested = 0;
  let skipped = 0;

  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    let lines: string[];
    try {
      lines = readFileSync(join(dir, f), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      let ev: { ts?: string; msg?: string };
      try {
        ev = JSON.parse(line) as { ts?: string; msg?: string };
      } catch {
        continue;
      }
      const msg = (ev.msg ?? '').trim();
      if (!msg || !INTERESTING.test(msg)) continue;

      const reason = `${(ev.ts ?? '').slice(0, 10)} run: ${msg.slice(0, 200)}`;
      if (known.has(reason)) {
        skipped++;
        continue;
      }
      known.add(reason); // also dedupes within this pass
      ledger.remember({ repo, kind: 'incident', reason, occurred_at: ev.ts });
      ingested++;
    }
  }

  if (ingested) log.debug(`ingested ${ingested} run outcome(s) from ${dir}`);
  return { ingested, skipped };
}

/**
 * Turn closed days of the working journal into long-term memory.
 *
 * The journal is short-term working memory: verbatim, recent, and gitignored.
 * This is the bridge into the durable store, so a question in 2027 can still
 * reach how the work actually went — not merely what landed.
 *
 * One rule: only CLOSED days. Today's file is still being appended to, and
 * ingesting it would record a half-written day and then never revisit it.
 *
 * Days are stored whole. An earlier version dropped dispatch prompts and agent
 * chatter and capped each day, because `recentResolutions` loads thousands of
 * rows at once and full days put that path at risk. The owner asked for the
 * complete record instead, so the limit moved to where it is unavoidable — the
 * amount read back into a prompt. See docs/DECISIONS.md for the measurement.
 */

/**
 * Strip only the day title, which the caller re-adds as the memory's headline.
 *
 * Everything else is kept verbatim, at the owner's explicit instruction: the
 * whole exchange, not just the verdicts. This used to drop dispatch prompts and
 * agent chatter and cap the day at 8000 characters. See the note on scale in
 * docs/DECISIONS.md — storage is now unbounded, and only the amount read back
 * into a prompt is limited.
 */
export function condenseDay(md: string, maxChars = Infinity): string {
  const lines = md.split('\n');
  /*
   * The title is line one, because core/journal.ts writes it there and only
   * there. Filtering every line starting with "# " looked equivalent and was
   * not: a result entry is an agent's raw reply, and agents write markdown.
   * The first real journal (2026-08-08) already carries "## Changes Made" and
   * "## Test Results" inside result entries; had either been an H1, that line
   * would have been deleted from the permanent record while the run reported
   * success. Match the writer, not the shape.
   */
  if (lines[0]?.startsWith('# ')) lines.shift();
  const text = lines.join('\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[day truncated]` : text;
}

export function ingestJournal(
  repo: string,
  // journalDir(), not a second copy of the path: this reads what appendEntry
  // wrote, and a redirected instance must ingest its own journal rather than
  // the real one sitting in the checkout.
  dir = journalDir(),
  now = new Date(),
): DocIngestResult {
  const days = journalDays(dir);
  if (days.length === 0) return { ingested: 0, skipped: 0 };

  // Keyed by date, not by headline text. Reading line one of every stored day
  // meant loading them all in full — tens of KB each, forever — to learn
  // something occurred_at already records.
  const known = ledger.ingestedJournalDays(repo);

  const openDay = today(now);
  let ingested = 0;
  let skipped = 0;

  for (const day of days) {
    // Today is still being written to; it is not a closed day.
    if (day >= openDay) {
      skipped++;
      continue;
    }
    if (known.has(day)) {
      skipped++;
      continue;
    }
    const body = condenseDay(readDay(day, dir));
    if (body.length < 40) {
      skipped++;
      continue;
    }
    const headline = `Work journal — ${day}`;
    ledger.remember({
      repo,
      kind: 'journal',
      reason: `${headline}\n${body}`,
      occurred_at: `${day}T12:00:00.000Z`,
    });
    ingested++;
  }

  if (ingested) log.debug(`ingested ${ingested} journal day(s) from ${dir}`);
  return { ingested, skipped };
}
