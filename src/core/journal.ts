import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot } from '../config.js';
import { today } from '../util.js';
import { log } from '../logger.js';

/**
 * The working journal: what was asked, what came back, what the gate decided —
 * in the order it happened, in markdown a person can read.
 *
 * This exists because every task dispatch was a cold start. The executor passed
 * the agent a title, an instruction and nothing else, so task 7 could not know
 * that task 3 had already tried the same approach and been rejected. The ledger
 * recorded the *outcome* of each task but never the exchange, so nothing
 * downstream could learn from how the work actually went.
 *
 * Two properties matter more than completeness:
 *
 * 1. It never breaks a run. Journalling is bookkeeping; a failed write must not
 *    cost a task that would otherwise have committed. Every export here
 *    swallows its own errors.
 * 2. It stays readable and bounded. A day per file, a cap per entry. The clip
 *    is safe to make because the agent's complete output is archived first, in
 *    data/artifacts/, and each result entry carries the path to it. That was
 *    not true when this file was written: only the brain's responses were
 *    archived, so the clip here was the last cut and the original was simply
 *    lost. Do not tighten one without checking the other still holds.
 *
 * Deliberately NOT tracked by git (see .gitignore). It is written continuously
 * while a run is in flight, and a tracked file doing that would fight
 * `git.ensureClean` and risk being swept into an unrelated commit — which has
 * happened here before. Durability comes from ingestion into the ledger.
 */

export type JournalStage =
  | 'dispatch'
  | 'result'
  | 'gate'
  /** The senior's verdict on a change the gate already passed. */
  | 'review'
  | 'commit'
  | 'park'
  | 'drop'
  | 'plan'
  | 'note';

export interface JournalEntry {
  repo: string;
  stage: JournalStage;
  detail: string;
  taskId?: string | null;
  title?: string | null;
  agent?: string | null;
  /** Defaults to now. Injectable so tests are not clock-dependent. */
  at?: Date;
}

/**
 * Nothing is trimmed on the way in. An entry is written exactly as it happened,
 * however long it is — the owner asked for the full record, and the archive in
 * data/artifacts/ is a backstop, not a substitute for the account itself.
 *
 * The only remaining limit is DEFAULT_READ_CHARS below, which governs how much
 * is read back OUT into a prompt. That one is not a preference: a prompt has a
 * hard size imposed by the provider, and exceeding it fails the call outright.
 */

/** Read-back budget. This is prompt real estate, not storage. */
export const DEFAULT_READ_CHARS = 3000;

/**
 * The archive pointer `executor.ts` appends to every result entry.
 *
 * It is written for the operator, who can open it. Nothing that reads the
 * journal back into a prompt can: it is an absolute path inside ShanAuto's own
 * data directory, and every agent runs under `external_directory: deny`.
 */
const ARCHIVE_POINTER = / · full output: .*/g;

/**
 * Take the operator's file paths back out before the journal becomes a prompt.
 *
 * On 2026-08-21 an intern read
 * `...\.zero12\artifacts\R2bw6udw6fg\1787279619432-agent-opencode-T6p8du5psu8.md`
 * out of its own context block and tried to open it — its own previous
 * attempt's transcript, in the orchestrator's directory. The deny rule held,
 * which is the guardrail working, and the step it spent finding the door locked
 * was a step it did not spend on the task.
 *
 * Stripped on the way OUT, never on the way in: the entry on disk is the
 * operator's record and keeps the pointer, exactly as the note at the top of
 * this file requires.
 */
export function stripArchivePaths(text: string): string {
  return text.replace(ARCHIVE_POINTER, '');
}

/*
 * Follows SHANAUTO_DB through dataRoot(), the way the artifacts and the run log
 * beside it already do.
 *
 * It read `p('data', 'journal')` unconditionally, which made this the one write
 * in data/ that a redirected instance could not move. dataRoot()'s own comment
 * says it covers "the run journal and the brain/agent artifacts" — it covered
 * the artifacts. The consequence was that every from-zero run since .zero5
 * shared a single journal file with all of its predecessors: a run started
 * against an empty ledger was still handed the previous runs' dispatches and
 * rejections as prior work, so "from zero" was never actually from zero, and
 * the runs meant to prove a fix had the unfixed history in their prompts.
 */
export function journalDir(): string {
  return join(dataRoot(), 'journal');
}

export function journalPath(day = today(), dir = journalDir()): string {
  return join(dir, `${day}.md`);
}

function hhmm(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Render one entry. Pure, so the format is testable without touching disk. */
export function formatEntry(e: JournalEntry): string {
  const at = e.at ?? new Date();
  const who = e.agent ? ` → ${e.agent}` : '';
  const what = e.title ? ` · ${e.title}` : '';
  const id = e.taskId ? ` · ${e.taskId}` : '';
  return `### ${hhmm(at)}${id} · ${e.stage}${who} · ${e.repo}${what}\n${(e.detail ?? '').trim()}\n`;
}

/** Append one entry. Never throws — see the note at the top of this file. */
export function appendEntry(e: JournalEntry, dir = journalDir()): void {
  try {
    const day = today(e.at ?? new Date());
    const file = journalPath(day, dir);
    mkdirSync(dir, { recursive: true });
    const header = existsSync(file) ? '' : `# Work journal — ${day}\n`;
    appendFileSync(file, `${header}\n${formatEntry(e)}`, 'utf8');
  } catch (err) {
    log.debug(`journal write skipped: ${(err as Error).message}`);
  }
}

/** Every day that has a journal file, oldest first. */
export function journalDays(dir = journalDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return []; // no journal yet is normal, not an error
  }
}

export function readDay(day: string, dir = journalDir()): string {
  try {
    return readFileSync(journalPath(day, dir), 'utf8');
  } catch {
    return '';
  }
}

/**
 * The most recent slice of the journal, for feeding back in before the next
 * task.
 *
 * Returns the TAIL, not the head: continuity comes from what just happened. A
 * day boundary is not a memory boundary — a run starting at 07:00 would
 * otherwise see an empty journal and be exactly as cold as before this feature
 * existed — so it walks back through earlier days until the budget is spent.
 */
export function readRecent(maxChars = DEFAULT_READ_CHARS, dir = journalDir()): string {
  try {
    if (maxChars <= 0) return '';
    const chunks: string[] = [];
    let used = 0;

    for (const day of journalDays(dir).reverse()) {
      if (used >= maxChars) break;
      const body = stripArchivePaths(readDay(day, dir)).trim();
      if (!body) continue;
      const room = maxChars - used;
      // Tail of the day, so the newest entries survive the cut.
      const slice = body.length > room ? `…\n${body.slice(-room)}` : body;
      chunks.push(slice);
      used += slice.length;
    }

    return chunks.reverse().join('\n\n').trim();
  } catch (err) {
    log.debug(`journal read skipped: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Read-back budget for one task's own history. Deliberately smaller than
 * DEFAULT_READ_CHARS: this is spent IN ADDITION to that, not instead of it.
 */
export const DEFAULT_THREAD_CHARS = 2000;

/** The header shape `formatEntry` writes: `### hh:mm · <id> · <stage> …`. */
const ENTRY_HEADER = /^### \d{2}:\d{2} · (\S+) · (\w+)/;

/**
 * What was said about ONE task, oldest first — the record a second attempt needs.
 *
 * `readRecent` returns the tail of a shared, chronological journal, which is the
 * right answer to "what has been going on in this repo" and the wrong answer to
 * "why was I sent back". The two questions were being answered by the same call.
 *
 * Measured 2026-08-21 with two tasks in flight: the rework findings for
 * Tjzy66vbnco were written at offset 36,909 and its own retry dispatched at
 * 45,458. The other task's brief, result and review landed in between, so the
 * 3,000-char window opened at 42,458 and the findings sat 5,500 chars outside
 * it. The retry was handed a description of the OTHER task's work, and
 * reproduced its own defect exactly. The same arithmetic held for the other
 * task's retry. Nothing is wrong with the window; a shared tail simply cannot
 * promise that any particular task's own history is inside it, and the moment
 * more than one task is in flight it usually is not.
 *
 * `gate`, `review` and `note`. A task's own `dispatch` entry is its brief, which
 * the retry is handed again in full anyway, and at ~3k it would spend this
 * entire budget repeating something already on the page.
 *
 * `result` is left out for a subtler reason. An agent's useful summary is the
 * LAST thing it says, but an entry too large for the remaining budget is kept
 * from its HEAD (see below), so admitting result entries would hand a retry the
 * opening of a transcript rather than its conclusion — and a single one of them
 * can be bigger than this whole budget on its own.
 *
 * `note` is the entry written for this reader instead: short enough to always
 * fit, and carrying only what the next attempt needs. Until 2026-08-21 the stage
 * was declared here and written by nothing, and the consequence was that a task
 * which failed BEFORE the gate — the INCOMPLETE path, where the agent stops
 * mid-work — retried with a thread of exactly zero characters. Measured on run
 * 14: the task queued for retry read 0 characters from here while the task that
 * shipped read 331. It knew nothing of the attempt it was repeating.
 */
export function readTaskThread(
  taskId: string,
  maxChars = DEFAULT_THREAD_CHARS,
  dir = journalDir(),
  stages: JournalStage[] = ['gate', 'review', 'note'],
): string {
  try {
    if (!taskId || maxChars <= 0) return '';
    const want = new Set<string>(stages);
    const kept: string[] = [];
    let used = 0;

    // Newest first, so a budget too small for the whole thread keeps the LAST
    // word rather than the first: what it was sent back for most recently is
    // what it has to fix now.
    for (const day of journalDays(dir).reverse()) {
      if (used >= maxChars) break;
      const entries = stripArchivePaths(readDay(day, dir))
        .split(/^(?=### )/m)
        .filter((e) => e.startsWith('### '));

      for (const entry of entries.reverse()) {
        const m = ENTRY_HEADER.exec(entry);
        if (!m || m[1] !== taskId || !want.has(m[2] ?? '')) continue;

        const text = entry.trimEnd();
        const room = maxChars - used;
        if (text.length > room) {
          // One entry larger than the whole budget is still worth its head: the
          // verdict line and the first findings are at the top of it.
          if (kept.length === 0) kept.push(`${text.slice(0, room)}\n…`);
          used = maxChars;
          break;
        }
        kept.push(text);
        used += text.length + 2; // the blank line between entries
      }
    }

    return kept.reverse().join('\n\n').trim();
  } catch (err) {
    log.debug(`journal read skipped: ${(err as Error).message}`);
    return '';
  }
}
