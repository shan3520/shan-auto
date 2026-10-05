import type { AppConfig } from '../config.js';
import { fill, prompt } from '../config.js';
import type { BrainDriver, OriginatingIdea } from '../drivers/contracts.js';
import { fileTree } from '../git.js';
import type { Brief, Repo, TaskRow } from '../schemas.js';
import { BriefSchema } from '../schemas.js';
import { isTestPath } from './verifier.js';
import { truncate } from '../util.js';
import { apiSurface, hintedBodies } from './context.js';
import { fitPrompt } from './planner.js';

/**
 * The senior engineer's brief, rendered for the intern.
 *
 * agy decides everything in here; this module only turns its answer into the
 * XML the intern reads. Keeping the angle brackets on this side means the brief
 * is schema-validated and repairable before anyone sees it — see the note on
 * `BriefSchema` for why that matters more than having the model type "<" itself.
 */

/**
 * XML-escape model-authored text.
 *
 * Not cosmetic. A brief describing TypeScript generics or a shell redirect
 * contains `<` and `&` as a matter of course, and an unescaped one turns the
 * rest of the document into something the reader has to guess at — exactly the
 * class of silent corruption that a plan the intern "may not alter" cannot
 * afford. Quotes are escaped too so the same helper is safe in an attribute.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One `<tag>text</tag>`, indented, with the text escaped. */
function el(indent: string, tag: string, text: string): string {
  return `${indent}<${tag}>${esc(text.trim())}</${tag}>`;
}

/**
 * Phrases that make a `must_prove` worthless.
 *
 * Every one of these lets a model satisfy the brief without writing a test that
 * can fail. They are here because that is not hypothetical: the 2026-08-21
 * probe's brief said "follow the fixtures and session-handling style already
 * used in this file", and the models that obeyed it produced tests which pass
 * against a deliberately broken implementation. The ones that caught defects
 * were the ones that ignored the instruction.
 *
 * A style reference belongs in `implementation` steps, where copying a pattern
 * is the point. It must never be the thing a test is asked to demonstrate.
 */
const STYLE_TELLS =
  /\b(style|follow(?:ing|s)? the|same (?:as|way|shape)|like the (?:existing|other)|match(?:ing)? the (?:pattern|shape|style)|consistent with|mirror(?:ing)? the|in keeping with|as (?:used|done) (?:in|elsewhere))\b/i;

/**
 * Whether a `must_prove` states a property that could fail.
 *
 * The test is crude on purpose — it catches the phrasing that has actually
 * caused this, and it is a gate on the SENIOR's output, where a rejection costs
 * one repair round rather than a wasted intern run and a bad commit.
 */
export function provesNothing(mustProve: string): string | null {
  const t = mustProve.trim();
  if (STYLE_TELLS.test(t))
    return `describes a style to copy, not a defect the test must catch`;
  /*
   * "tests the function" restates the target and commits to nothing. A usable
   * must_prove names a wrong behaviour: a value, a boundary, an omission. The
   * cheapest reliable signal that one is present is that the sentence says what
   * would be WRONG, so require some word that can carry a failure.
   */
  /*
   * Matched with \w* rather than as fixed words: the prompt teaches "fails if
   * the 30-day cutoff is widened" as the model answer, and an exact \bfail\b
   * rejected it, which would have sent the senior round the repair loop for
   * writing precisely what it was told to write.
   */
  if (
    !/\b(fail\w*|wrong|incorrect|invalid|not|never|zero|empty|missing|omit\w*|outside|before|after|instead|exclud\w*|ignor\w*|count\w*|raise\w*|throw\w*|reject\w*|error\w*|duplicat\w*|stale|crash\w*)\b/i.test(
      t,
    )
  )
    return `does not say what would be wrong, so a test satisfying it need not be able to fail`;
  return null;
}

export interface BriefIssueOpts {
  /** Files the gate will let this task touch. A brief may not plan past it. */
  maxFiles: number;
  /**
   * The files the PLAN declared, which is what the gate judges the diff
   * against. The worker never sees this list — it works from the brief, which
   * the senior wrote separately — so a brief naming a file the plan did not
   * declare is a trap with nobody at fault: the worker does as it is told, and
   * the gate refuses the file it was not told about.
   */
  declared: string[];
}

/**
 * What is wrong with a brief, as sentences to hand back to the senior.
 *
 * Runs inside the brain's repair loop, like the planner's own `accept`: a brief
 * that plans work the gate would reject is cheaper to fix here, in one more
 * model call, than after an intern has spent ten minutes writing to it.
 */
export function briefIssues(brief: Brief, opts: BriefIssueOpts): string[] {
  const issues: string[] = [];

  const paths = [...brief.implementation.map((f) => f.path), ...brief.tests.map((t) => t.path)];
  for (const p of paths) {
    const t = p.trim();
    if (!t) continue;
    // A brief is a plan for THIS repo. Anything that escapes it is not a plan.
    if (/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(t) || t.split(/[\\/]/).includes('..'))
      issues.push(`"${t}" is not a path inside the repository; use a repo-relative path.`);
  }

  const touched = new Set(paths.map((p) => p.trim().replace(/\\/g, '/')).filter(Boolean));
  if (touched.size > opts.maxFiles)
    issues.push(
      `the brief plans ${touched.size} files but this task may only touch ${opts.maxFiles}. ` +
        `Cut it down to the files the objective actually needs.`,
    );

  /*
   * O21. Only test files, and that is not a half-measure: the gate's file rule
   * is TEST_TAMPER, which refuses an edit to an EXISTING test in a file the
   * task did not declare. An undeclared source file is not refused on those
   * grounds, so demanding one here would reject briefs the gate would have
   * accepted — trading a trap nobody has hit for rejections everybody would.
   *
   * Caught here rather than at the gate because here it costs one more model
   * call, and there it costs an intern's ten minutes and the work it wrote.
   */
  const declared = new Set(opts.declared.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean));
  const undeclaredTests = brief.tests
    .map((x) => x.path.trim().replace(/\\/g, '/'))
    .filter((x) => x && isTestPath(x) && !declared.has(x));
  if (undeclaredTests.length) {
    issues.push(
      `${undeclaredTests.join(', ')} ${undeclaredTests.length === 1 ? 'is a test file' : 'are test files'} ` +
        `the plan did not declare for this task. The gate refuses an edit to an ` +
        `existing test in a file the task never declared, so an intern told to ` +
        `touch ${undeclaredTests.length === 1 ? 'it' : 'them'} would have its work thrown away. ` +
        `Plan the tests in the declared file(s) — ${[...declared].join(', ') || 'none were declared'} — ` +
        `or leave them out.`,
    );
  }

  for (const t of brief.tests) {
    const why = provesNothing(t.must_prove);
    if (why)
      issues.push(
        `must_prove for "${t.path}" ${why}. Rewrite it as the specific defect the test ` +
          `has to catch — for example "fails if the 30-day cutoff is widened" or ` +
          `"fails if positive feedback is counted as a complaint" — never as a style to follow.`,
      );
  }

  return issues;
}

/** The brief as the intern receives it. */
export function renderBrief(brief: Brief): string {
  const out: string[] = ['<brief>'];

  out.push(el('  ', 'objective', brief.objective));
  out.push(el('  ', 'rationale', brief.rationale));

  if (brief.reuse.length) {
    out.push('  <reuse_existing_code>');
    for (const r of brief.reuse)
      out.push(
        `    <item path="${esc(r.path.trim())}"${r.symbol ? ` symbol="${esc(r.symbol.trim())}"` : ''}>` +
          `${esc(r.why.trim())}</item>`,
      );
    out.push('  </reuse_existing_code>');
  }

  out.push('  <implementation>');
  for (const f of brief.implementation) {
    out.push(`    <file path="${esc(f.path.trim())}" action="${f.action}">`);
    for (const s of f.steps) out.push(el('      ', 'step', s));
    out.push('    </file>');
  }
  out.push('  </implementation>');

  /*
   * Named `must_prove` in the output too, not `description`. The intern reads
   * the tag; a tag that says what the field is for is doing part of the work
   * that the authoring prompt would otherwise have to do alone.
   */
  out.push('  <tests>');
  for (const t of brief.tests) {
    out.push(`    <file path="${esc(t.path.trim())}">`);
    out.push(el('      ', 'must_prove', t.must_prove));
    out.push('    </file>');
  }
  out.push('  </tests>');

  if (brief.constraints.length) {
    out.push('  <constraints>');
    for (const c of brief.constraints) out.push(el('    ', 'rule', c));
    out.push('  </constraints>');
  }

  out.push(el('  ', 'acceptance', brief.acceptance));
  out.push('</brief>');
  return out.join('\n');
}

/**
 * Ask the senior for the brief on one task.
 *
 * Called at DISPATCH, not at plan time. Two reasons. The brief describes the
 * repo the intern will actually open, and earlier tasks in the same milestone
 * may have landed since planning, so a brief written at plan time can name a
 * helper that has since moved. And a task that never runs — deduped, blocked,
 * abandoned — costs nothing here, where a brief written for every planned task
 * would spend a model call on each.
 *
 * `briefIssues` runs inside the repair loop rather than after it, for the same
 * reason the planner validates inside `ask`: a brief that plans past the gate,
 * or asks for a test that cannot fail, is one more model call to fix here and a
 * wasted intern run plus a bad commit to fix anywhere else.
 */
export async function authorBrief(
  cfg: AppConfig,
  brain: BrainDriver,
  repo: Repo,
  task: TaskRow,
  /**
   * What this run has already committed into the files this task claims, or ''
   * when nothing has. Built by the executor, which is the only place that knows
   * - the symbol list below is read from the working tree and shows the result
   * of that commit without ever saying that it was one of ours, or what it was
   * for. See `priorWorkNote`.
   */
  landed = '',
  /**
   * The originating idea in the operator's own words, or null when the task
   * did not come from one. Rendered as its own block rather than folded into
   * the task block: it is the only text in this prompt that is not a model's
   * paraphrase, and it has to be legible as such.
   */
  idea: OriginatingIdea | null = null,
): Promise<Brief> {
  let hints: string[] = [];
  try {
    hints = JSON.parse(task.files_hint) as string[];
  } catch {
    hints = [];
  }

  const taskBlock = [
    `TITLE: ${task.title}`,
    `KIND: ${task.kind}`,
    `WHAT THE PLAN ASKS FOR: ${task.instruction}`,
    `ACCEPTANCE: ${task.acceptance}`,
    // Only when there is one. The brief author has no verdict to reach here,
    // so an absent declaration is absent rather than stated - unlike the
    // review, which has to tell "declared nothing" from "not shown".
    task.breaking ? `CHANGES EXISTING BEHAVIOUR: ${task.breaking}` : '',
    hints.length ? `FILES THE PLANNER EXPECTED: ${hints.join(', ')}` : '',
    `ROUGH SIZE: ~${task.est_lines ?? 20} meaningful lines`,
    // Last, because it is the only line here about the repo rather than about
    // the task, and it is read against the symbols above it.
    landed,
  ]
    .filter(Boolean)
    .join('\n');

  /*
   * The plan's own file list is the floor for this budget.
   *
   * `briefIssues` and the planner enforce the same limit from two sides, and on
   * 2026-08-23 that cost a task: the planner is allowed to exceed the cap when
   * a deletion compels extra files (see `removalTouches`), and a brief that
   * then named all of them was over budget here and would have been sent back
   * to be cut. Cutting it is the fault the planner had just finished
   * preventing. A brief that touches exactly what the plan declared is not
   * scope creep by definition — the guards have already judged that list.
   */
  const maxFiles = Math.max(cfg.system.limits.max_files_per_task, hints.length);
  const sections = {
    TREE: truncate(await fileTree(repo, 150), 4000),
    SYMBOLS: await apiSurface(repo),
    /*
     * O23. The brief author used to see a file tree and a list of the names
     * each file declares, and a name proves a thing exists and nothing else.
     * Run 21: a plan asserted that a one-line function fetched iteratively, the
     * brief promoted that guess to its objective, and the junior made the
     * sentence true rather than lose the attempt.
     *
     * Only the files this task will actually change — usually one to four —
     * rather than the repo, which is what makes this affordable inside a budget
     * the symbol index was already being halved to fit.
     */
    BODIES: await hintedBodies(repo, hints),
  };

  const render = (s: typeof sections): string =>
    fill(prompt('brief'), {
      REPO_ID: repo.id,
      REPO_PATH: repo.path,
      STACK: repo.stack,
      MAX_FILES: maxFiles,
      TASK: taskBlock,
      /*
       * A fill variable, not a `fitPrompt` section, and deliberately so.
       *
       * The trimmer exists to shrink the file tree and the symbol list when a
       * prompt runs long. This block is under a kilobyte and it is the only
       * thing here written by the person the work is for, so it is the last
       * thing that should be cut - which, as a section, is exactly what would
       * happen to it.
       */
      WHY: idea
        ? `THE COMPLAINT THIS CAME FROM - the operator's own words, not a paraphrase:\n` +
          `"${idea.title}"\n\n${idea.body.trim()}`
        : `THE COMPLAINT THIS CAME FROM: not recorded for this task.`,
      TREE: s.TREE,
      SYMBOLS: s.SYMBOLS,
      BODIES: s.BODIES,
    });

  const text = fitPrompt(render, sections, brain.maxPromptChars, brain.promptCost?.bind(brain), 'brief');

  /*
   * The objection text is what the model is shown on repair, so it names the
   * way out, not only the problem — the same rule the decompose gate follows.
   */
  const accept = (draft: Brief): string | null => {
    const issues = briefIssues(draft, { maxFiles, declared: hints });
    return issues.length ? issues.join('\n') : null;
  };

  return brain.ask(text, BriefSchema, `brief-${task.id}`, accept);
}
