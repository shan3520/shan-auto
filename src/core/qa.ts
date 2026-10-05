import { fill, prompt } from '../config.js';
import type { BrainDriver } from '../drivers/contracts.js';
import { apiSurface } from './context.js';
import { fitPrompt } from './planner.js';
import { declaredFiles, normPath } from './verifier.js';
import type { QaReview, Repo, TaskRow } from '../schemas.js';
import type { BrainAuthor } from '../drivers/contracts.js';
import { QaReviewSchema } from '../schemas.js';

/**
 * The senior's read of the intern's work, between the gate and the commit.
 *
 * The gate answers a mechanical question — do the tests pass, is the change in
 * scope, did it touch anything forbidden. It cannot answer the one that decided
 * every result in the 2026-08-21 model probe: whether the tests that pass are
 * capable of failing. Four of eight models produced suites that were green
 * against a deliberately broken implementation. The gate called all four green,
 * correctly, and all four were worthless.
 *
 * This is therefore a SHIP decision, not a code review. Everything here exists
 * to keep it one: a closed severity list, findings that must name a file the
 * intern actually touched, and a taste filter. A senior that can reject for
 * taste will, and each rejection costs a full re-implementation — a shop that
 * never ships is a worse failure than one that ships an imperfect commit.
 */

/**
 * Phrases that mark a finding as preference rather than defect.
 *
 * Not a style guide: every one of these can be true and none of them makes
 * green, in-scope, tested work unfit to push. They are checked on the SENIOR's
 * output, where a rejection costs one repair round, rather than being argued
 * with after the intern has re-run.
 */
const TASTE_TELLS =
  /\b(consider(?:ing)?|might (?:be|want)|could (?:be|have)|would (?:be|have) (?:been )?(?:nicer|cleaner|better|clearer)|prefer(?:ably|red)?|readab(?:le|ility)|idiomatic|naming|rename|nitpick|minor|cosmetic|for consistency|personal(?:ly)?|suggest(?:ion|ed)?)\b/i;

/**
 * Words that mean the finding is anchored to something in the patch.
 *
 * A defect the reader can act on says what happens: it returns, it throws, it
 * counts, it skips. "The implementation is incomplete" says nothing an intern
 * can fix and nothing a person can disagree with.
 */
const ANCHOR_WORDS =
  /\b(returns?|throws?|raises?|crash\w*|null|undefined|empty|off by|order|duplicat\w*|overwrit\w*|silent\w*|swallow\w*|mock\w*|stub\w*|assert\w*|never fails?|always passes?|hard-?cod\w*|ignor\w*|skip\w*|miss\w*|omit\w*|wrong\w*|incorrect\w*|leak\w*|race|unbounded|unclosed|not (?:closed|called|awaited|handled|covered))\b/i;

/**
 * The other way a finding can be anchored: by naming something in the code.
 *
 * A word list alone is a vocabulary test, and on 2026-08-21 it acted like one.
 * Both findings on Tnudc90a2fc's second attempt were thrown out:
 *
 *     "aggregate_failed_searches does not filter out 'running' or 'errored'
 *      searches ... will be incorrectly aggregated"
 *     "The brief mandated a test that fails if a 'running' status is included.
 *      This test was completely omitted."
 *
 * Both name a real defect. `\bincorrect\b` does not match "incorrectly", and
 * "omitted" was in no list. The repair cost a second model call and came back
 * WORSE — "The test suite skips asserting on the status filter and returns a
 * passing result for the suite" — prose bent to hit `skip` and `assert`. A
 * reviewer writing for the regex is not reviewing.
 *
 * Adding the missed words would only move the line. What actually separates a
 * defect from a nitpick is whether it points AT something: a symbol, a literal,
 * a path, a call. "The naming could be clearer" points at nothing; every real
 * finding this system has thrown away pointed at something.
 */
const CODE_REFERENCE =
  /`[^`]+`|['"][^'"]+['"]|\b\w+_\w+\b|\b\w+\(\)|\b[a-z]+[A-Z]\w*\b|(?:^|\s)[\w./-]*\/[\w./{}-]+/;

/**
 * The subset of TASTE_TELLS that says the complaint IS the style.
 *
 * "Consider", "might be", "for consistency" and "suggest" are how a reviewer is
 * polite; they say nothing about what the finding is about. "Rename", "the
 * naming", "readability", "nitpick" say the finding is about how the code looks.
 *
 * The distinction is load-bearing because CODE_REFERENCE rescues findings that
 * name a symbol, and both of these name one:
 *
 *     "for consistency with the other stats routes, this endpoint should
 *      require get_current_user"                         <- a missing auth check
 *     "consider renaming countComplaints to something clearer"   <- a nitpick
 *
 * A polite defect is still a defect. A named nitpick is still a nitpick.
 */
const STYLE_COMPLAINT =
  /\b(rename|renaming|naming|readab(?:le|ility)|idiomatic|nitpick|minor|cosmetic|personal(?:ly)?|prefer(?:ably|red|ence)?|nicer|cleaner|clearer|tidier|style)\b/i;

/**
 * A defect conceded in prose while shipping anyway.
 *
 * `summary` is the one field no rule read, and on 2026-08-21 the senior used
 * it exactly that way: verdict "ship", findings `[]`, and in the summary —
 * "the junior added an extra route alias (/stats/dead-documents), which ships
 * fine but is technically redundant". It saw the duplicate, said so, and
 * shipped it. Because the remark was narrated instead of filed, every rule
 * below was bypassed.
 *
 * The instruction to do that was mine. The ship-with-findings message used to
 * end "or move the remark into summary and send no findings", which is a
 * documented route around the contract. That wording is gone, and this catches
 * the shape if the model finds it again on its own.
 *
 * Deliberately narrow. It wants a concession AND a named defect inside the
 * same clause — `[^.]*` never crosses a sentence — because "but" and "however"
 * are far too common to act on alone. Checked against real summaries: it fires
 * on "ships fine but is technically redundant", "though the second helper is
 * unused" and "but the error path is not covered", and stays quiet on "does
 * nothing but add tests, all of which are meaningful" and "however it is
 * idempotent and safe to rerun".
 *
 * The reviewer is not being asked to reject more. It is being asked to decide:
 * file it, or drop it. A caveat in the summary is neither.
 */
const CONCEDED_DEFECT =
  /\b(?:but|however|though|although|albeit|that said|arguably|even so|nonetheless)\b[^.]*\b(?:redundant|duplicat\w*|unnecessary|dead|unused|missing|not (?:covered|tested|handled|checked)|should (?:be|have)|ought to|leftover|stray|inconsistent\w*)\b/i;

export interface ReviewIssueOpts {
  /** The files the gate accounted for. A finding may not name anything else. */
  changedFiles: string[];
  /** Whether this task was dispatched with a brief at all. */
  hasBrief: boolean;
}

/** Compare paths the way the two sides spell them, not the way git prints them. */
function norm(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * What is wrong with a REVIEW, as sentences to hand back to the senior.
 *
 * Passed as the `accept` callback, so it runs inside the brain's repair loop
 * exactly like the planner's and the brief's. A review rejected here costs one
 * more model call. A bad review that gets through costs an entire intern run,
 * or — worse, and silently — pushes work the senior meant to stop.
 */
export function reviewIssues(review: QaReview, opts: ReviewIssueOpts): string[] {
  const issues: string[] = [];
  const changed = new Set(opts.changedFiles.map(norm));

  if (review.verdict === 'rework' && review.findings.length === 0)
    issues.push(
      `the verdict is "rework" but no findings are listed. Name the change that has to ` +
        `be made, or return "ship".`,
    );

  /*
   * A "ship" carrying objections is the shape that quietly destroys the rule.
   * The next reader sees work that shipped with findings attached and learns
   * that findings do not stop anything.
   */
  if (review.verdict === 'ship' && review.findings.length > 0)
    issues.push(
      `the verdict is "ship" but ${review.findings.length} finding(s) are listed. A finding ` +
        `is a reason NOT to ship. Either return "rework", or drop the finding entirely — ` +
        `if it is not worth sending the work back for, it is not worth recording as a finding.`,
    );

  /*
   * A ship whose summary hedges is a finding that was never filed. See
   * CONCEDED_DEFECT: the reviewer that shipped a duplicate unauthenticated
   * endpoint had already spotted it and written it down here.
   */
  if (review.verdict === 'ship' && review.findings.length === 0 && CONCEDED_DEFECT.test(review.summary))
    issues.push(
      `the verdict is "ship" and no findings are listed, but the summary concedes a problem ` +
        `("${review.summary.trim().slice(0, 160)}"). Decide which it is: if it is worth ` +
        `mentioning, return "rework" and file it as a finding so the intern can fix it; if it ` +
        `is not worth sending the work back for, leave it out of the summary too.`,
    );

  for (const f of review.findings) {
    if (!changed.has(norm(f.file)))
      issues.push(
        `"${f.file}" is not one of the files this task changed (${opts.changedFiles.join(', ') || 'none'}). ` +
          `Review only the patch in front of you; work you would also like done is a separate task.`,
      );

    if (f.severity === 'off_brief' && !opts.hasBrief)
      issues.push(
        `"${f.file}" is marked off_brief, but this task was dispatched without a brief, ` +
          `so there was no design to depart from. Use "defect" or "untested", or drop it.`,
      );

    /*
     * Substance decides, and phrasing only decides when there is no substance.
     *
     * These two ran the other way round until 2026-08-21: TASTE_TELLS was
     * tested first, so a finding was thrown out for the words it used even
     * when it named a real failure. Checked against the live regex, both of
     * these were discarded —
     *
     *   "For consistency with the other stats routes, this endpoint should
     *    require get_current_user."                    ("for consistency")
     *   "This duplicates the existing /api/stats/unsearched-documents
     *    endpoint; consider removing one."             ("consider")
     *
     * — one a missing auth check on an endpoint serving document titles to
     * anonymous callers, the other the duplicate-endpoint finding this system
     * most needed to hear. "Consider" and "for consistency" are ordinary
     * review prose; a reviewer being polite is not a reviewer being trivial.
     *
     * It fails in the expensive direction, too. reviewIssues is the `accept`
     * callback inside the repair loop, so a discarded finding goes back as
     * invalid — and the cheapest repair is to drop it and ship, not to
     * rephrase it. A filter meant to stop nitpick rework could turn a correct
     * rejection into an approval.
     *
     * So: a finding that names a concrete behaviour stands however it is
     * worded, and the taste filter now only catches findings that named
     * nothing in the first place.
     */
    // Anchored by what it says goes wrong, or — failing that — by naming
    // something concrete, unless naming things IS the complaint.
    const anchored =
      ANCHOR_WORDS.test(f.detail) ||
      (CODE_REFERENCE.test(f.detail) && !STYLE_COMPLAINT.test(f.detail));

    if (!anchored) {
      if (TASTE_TELLS.test(f.detail))
        issues.push(
          `the finding on "${f.file}" reads as a preference, not a defect. This is a ship/no-ship ` +
            `decision: reject only for code that is wrong, a test that cannot fail, or a design ` +
            `the brief specified and the intern replaced. Anything else ships.`,
        );
      else
        issues.push(
          `the finding on "${f.file}" does not say what actually goes wrong. Name the behaviour ` +
            `— what it returns, what it skips, what the test would still pass against — so the ` +
            `intern can fix the thing you mean.`,
        );
    }
  }

  return issues;
}

/** The review as the journal and the next attempt's prompt read it. */
/**
 * The changed files, with the ones the plan never mentioned called out.
 *
 * `off_brief` has been a severity since the contract was written and had never
 * once been used, because nothing ever told the reviewer which files were the
 * intern's own idea. On 2026-08-20 a task shipped a new alembic migration, a
 * model change and an `ALTER TABLE` inside `try/except Exception: pass` — none
 * of it declared, none of it mentioned in a review that said ship. The change
 * was defensible on the merits. Going unremarked was not: authoring a schema
 * migration is the largest blast radius available to the intern, and the one
 * participant able to judge it was not told it had happened.
 *
 * The gate deliberately does NOT reject on this. A task legitimately touches an
 * `__init__.py`, an import, a fixture the planner did not foresee, and throwing
 * away real work over a filename is the trade this system refuses everywhere
 * else. It is a fact handed to the participant whose job is judgement.
 */
/**
 * The line that names existing tests the junior edited on its own initiative.
 *
 * Silent when there are none, and that silence is the common case — most tasks
 * never touch a test they did not write. A heading that appears in every prompt
 * saying "none" is a line the reader learns to skip, and this one has to be
 * read on the day it is not empty.
 */
export function renderTestEdits(files?: string[]): string {
  if (!files?.length) return '';
  return [
    '',
    `EXISTING TESTS THIS JUNIOR EDITED, UNASKED: ${files.join(', ')}`,
    '',
    'Those tests were in the repo before this task started and the plan never',
    'listed them. The gate has already checked the one thing it can check: every',
    'assertion they made before, they still make. Nothing was deleted, rewritten,',
    'or skipped.',
    '',
    'What it cannot check is the setup around those assertions. A test whose',
    'seeded rows went from ten to one, whose fixture lost the awkward case, whose',
    'dates were moved until the boundary it guards is no longer near it, still',
    'passes an assertion-for-assertion count and proves far less than it did.',
    'Read those hunks and decide. Adjusting setup so an existing test still runs',
    'under changed behaviour is legitimate and expected — say so and move on. A',
    'test quietly made easier is a `defect`.',
  ].join('\n');
}

export function annotateFiles(files: string[], filesHint: string): string {
  if (!files.length) return '(none)';
  const declared = declaredFiles(filesHint);
  /*
   * A task with no hint at all declared nothing, so the marker would be true of
   * every file and would therefore say nothing about any of them. Marking all
   * of them is how a signal becomes noise; stay quiet instead.
   */
  if (!declared.size) return files.join(', ');
  return files.map((f) => (declared.has(normPath(f)) ? f : `${f} (NOT IN THE PLAN)`)).join(', ');
}

/**
 * The verdict as the operator reads it, in the journal that survives the run.
 *
 * `author` is stamped on the header rather than mentioned below it because a
 * fallback changes what the verdict IS. On zero13 a SHIP that authorised a
 * commit and a push came from the understudy in 24 seconds after the
 * configured senior failed OAuth, and the only trace was a WARN in the middle
 * of a run's other warnings. A reader skimming for SHIP has to meet it.
 */
export function renderReview(review: QaReview & { author?: BrainAuthor }): string {
  const who = review.author?.fallback
    ? ` — NOT the configured senior; ${review.author.model} answered after it could not`
    : '';
  const lines = [`SENIOR REVIEW: ${review.verdict.toUpperCase()}${who}`, review.summary.trim()];
  if (review.findings.length) {
    lines.push('', 'What has to change before this can be committed:');
    for (const f of review.findings)
      lines.push(
        `- ${f.file} [${f.severity}]: ${f.detail.trim()}`,
        `  FIX: ${f.fix.trim()}`,
      );
  }
  return lines.join('\n');
}

export interface ReviewInput {
  /** Unified diff of exactly the files the gate accounted for. */
  patch: string;
  /** True when the diff was cut short; the reader is told so explicitly. */
  truncated: boolean;
  /** The files the gate accounted for. */
  files: string[];
  /** The gate's own line, so the reviewer never re-litigates a settled question. */
  gateDetail: string;
  /**
   * Existing tests the junior edited without the plan declaring them.
   *
   * Only ones the gate cleared reach here: every assertion they made before,
   * they still make. What the gate cannot judge is the SETUP — a seeded row
   * dropped, a fixture narrowed, a date moved — which can hollow out a case
   * without touching a line that looks like a proof. That is a reading of the
   * patch, and this is the participant that reads the patch.
   */
  adjustedTests?: string[];
  /**
   * What the junior said it did, in its own words.
   *
   * Until 2026-08-21 the reviewer was handed the brief and the diff and nothing
   * the junior wrote, which meant a deviation and its justification arrived as
   * a silent absence. A task that had proved one of its brief's steps impossible
   * — a filter on a column no model has — was rejected `off_brief` for not doing
   * it, deleted, and abandoned. The reasoning was there the whole time; nothing
   * carried it.
   *
   * A claim, not evidence: the prompt says so, and the patch outranks it.
   */
  report: string;
}

/**
 * Ask the senior whether this change should be committed.
 *
 * Throws if the senior cannot produce an acceptable review. The caller decides
 * what that means; in the executor it means ship, because a senior that is down
 * must not stop the shop.
 */
export async function reviewWork(
  brain: BrainDriver,
  repo: Repo,
  task: TaskRow,
  input: ReviewInput,
): Promise<QaReview> {
  const taskBlock = [
    `TITLE: ${task.title}`,
    `KIND: ${task.kind}`,
    `WHAT THE PLAN ASKED FOR: ${task.instruction}`,
    `ACCEPTANCE: ${task.acceptance}`,
    /*
     * Always rendered, including when nothing was declared.
     *
     * The reviewer is being asked whether the patch changes something the plan
     * never mentioned, and it cannot answer that from a line that is simply
     * missing - an omitted field reads as "not shown to you" exactly as much
     * as it reads as "there was none". The negative has to be said out loud.
     */
    task.breaking
      ? `DECLARED BREAKING: ${task.breaking}`
      : 'DECLARED BREAKING: nothing - the plan says this task changes no existing behaviour',
  ].join('\n');

  /*
   * The patch is the one section that must not be traded away for room, so it
   * is trimmed last (see ELASTIC_ORDER) and the reader is told when it was. A
   * reviewer that silently receives half a change will reject it for the half
   * it cannot see.
   */
  /*
   * The tail, not the head. An agent states what it built first and what it
   * could not build last, so a report clipped from the front keeps the summary
   * and drops the caveat — the one part of it that changes a verdict.
   */
  const REPORT_CHARS = 3000;
  const report = input.report.trim();
  const sections = {
    // Filled in below, once the rest of the prompt has been measured.
    SYMBOLS: '',
    REPORT: report.length > REPORT_CHARS
      ? `…${report.slice(-REPORT_CHARS)}`
      : report || '(the junior said nothing about what it did)',
    PATCH: input.patch || '(the gate recorded changes, but the diff came back empty)',
  };

  const render = (s: typeof sections): string =>
    fill(prompt('qa'), {
      REPO_ID: repo.id,
      STACK: repo.stack,
      TASK: taskBlock,
      BRIEF: task.brief ?? '(no brief — this task was dispatched on the planner instruction above)',
      FILES: annotateFiles(input.files, task.files_hint),
      TESTEDITS: renderTestEdits(input.adjustedTests),
      GATE: input.gateDetail,
      TRUNCATED: input.truncated
        ? 'WARNING: this patch was too long to show in full and has been CUT OFF. ' +
          'Judge only what you can see. Do NOT reject it for anything missing, ' +
          'absent, uncalled or unfinished — that part may simply be below the cut.'
        : 'This is the complete patch.',
      SYMBOLS: s.SYMBOLS,
      REPORT: s.REPORT,
      PATCH: s.PATCH,
    });

  const cost = brain.promptCost?.bind(brain) ?? ((t: string): number => t.length);

  /*
   * Ask for an index that fits, rather than one that has to be cut down.
   *
   * fitPrompt still stands behind this, but what it does to an oversized
   * SYMBOLS section is slice characters off the end - which ends a file's line
   * mid-name, says nothing about how many files went, and takes the same
   * amount from a repo of 60 files as from one of 600. apiSurface asked for a
   * budget it can meet does the cut properly: every path kept if the paths
   * fit, detail rationed by demand, and an honest count of whatever it could
   * not fit.
   *
   * Measured on run 16 (2026-08-21): both reviews came in over budget, by 5225
   * and 7397 chars, and the second lost 47% of its index this way. Rendering
   * the prompt once with no index at all says exactly how much room there is.
   */
  const SURFACE_MAX = 16_000;
  // Slack for the cost function being non-linear - agy doubles every quote on
  // the command line, and a test title in the index can carry them.
  const MARGIN = 500;
  const headroom = brain.maxPromptChars
    ? brain.maxPromptChars - cost(render(sections)) - MARGIN
    : SURFACE_MAX;
  /*
   * The files under review go first, so that if the index still has to give
   * something up it gives up the files nobody is asking about.
   */
  sections.SYMBOLS = await apiSurface(
    repo,
    Math.max(0, Math.min(SURFACE_MAX, headroom)),
    input.files,
  );

  const text = fitPrompt(render, sections, brain.maxPromptChars, cost, `review-${task.id}`);

  const accept = (draft: QaReview): string | null => {
    const issues = reviewIssues(draft, {
      changedFiles: input.files,
      hasBrief: Boolean(task.brief),
    });
    return issues.length ? issues.join('\n') : null;
  };

  return brain.ask(text, QaReviewSchema, `review-${task.id}`, accept);
}
