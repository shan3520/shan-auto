import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DecomposeSchema, ShapeSchema, type NormalizedTask, type PlannedTask, type Repo } from '../schemas.js';
import { fill, prompt, p, resolveRepo, type AppConfig } from '../config.js';
import type { BrainDriver } from '../drivers/contracts.js';
import * as ledger from '../ledger.js';
import { fileTree, headSha, trackedRoots } from '../git.js';
import { apiSurface, findDuplicate, hintedBodies, repoSymbols, resolutionDigest } from './context.js';
import type { RepoSymbols } from './context.js';
import { readRecent } from './journal.js';
import { log } from '../logger.js';
import { ensureDir, today, truncate, untrusted } from '../util.js';
import { stackOfFile, stackSummary, type Stack } from './stacks.js';

export interface RawIdea {
  title: string;
  body: string;
  repo: string;
}

/** Parse ideas/inbox.md into discrete ideas. `repo: <id>` on any line pins the repo. */
export function parseInbox(cfg: AppConfig): RawIdea[] {
  const file = p('ideas', 'inbox.md');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const defaultRepo = cfg.repos[0]!.id;

  const ideas: RawIdea[] = [];
  for (const chunk of text.split(/^##\s+/m).slice(1)) {
    const lines = chunk.split('\n');
    const title = (lines.shift() ?? '').trim();
    const body = lines.join('\n').trim();
    /*
     * Say why an idea was dropped. Both of these were silent `continue`s, so an
     * idea someone had written could disappear between the inbox and the queue
     * with nothing on screen, in the log or in the journal to explain it. The
     * TUI now catches both before writing — this is for ideas typed straight
     * into the file.
     */
    if (!title) continue;
    if (body.length < 20) {
      log.warn(`Idea "${title}" is too short to plan from (${body.length} chars); skipping.`);
      continue;
    }
    if (title.toLowerCase().startsWith('example:')) {
      log.info(`Skipping "${title}" — titles starting "Example:" mark the samples in the file.`);
      continue;
    }

    const m = body.match(/^\s*repo:\s*([\w.-]+)\s*$/m);
    const repoId = m?.[1] ?? defaultRepo;
    const known = cfg.repos.some((r) => r.id === repoId);
    if (!known) {
      log.warn(`Idea "${title}" names unknown repo "${repoId}"; skipping. Add it to repos.yaml.`);
      continue;
    }
    ideas.push({ title, body: body.replace(/^\s*repo:.*$/m, '').trim(), repo: repoId });
  }
  /*
   * Text that no idea consumed.
   *
   * Everything above the first "## " is invisible to the loop above, and
   * archiveInbox then moves the whole file into the archive — so an idea typed
   * with one hash instead of two is never read, and the run reports "Nothing to
   * work on" while the file it just archived contained the work. Found on
   * 2026-08-20 driving a hand-written inbox.
   *
   * Every other way an idea can be dropped in here says so out loud. This was
   * the one that did not, and it is the only one where the operator cannot tell
   * "you asked for nothing" from "I could not see what you asked for".
   *
   * Not promoted to an idea automatically: a real inbox opens with "# Ideas",
   * and turning the document's own title into a job is a worse failure than
   * refusing to guess.
   */
  const stray = (text.split(/^##\s+/m)[0] ?? '')
    .replace(/^#\s+.*$/gm, '')
    .trim();
  if (stray.length >= 20) {
    log.warn(
      `ideas/inbox.md has ${stray.length} characters that are not part of any idea, ` +
        `so they will not be planned.`,
    );
    log.warn(`  An idea has to start with a line beginning "## " — two hashes and a space.`);
  }

  return ideas;
}

export function archiveInbox(): void {
  const file = p('ideas', 'inbox.md');
  if (!existsSync(file)) return;
  ensureDir(p('ideas', 'archive'));
  renameSync(file, join(p('ideas', 'archive'), `${today()}-${Date.now()}.md`));
}

/** Idea -> epics -> milestones. Stored unplanned; decomposition happens lazily. */
export async function shapeIdea(cfg: AppConfig, brain: BrainDriver, idea: RawIdea): Promise<number> {
  const repo = resolveRepo(cfg, idea.repo);
  const tree = await fileTree(repo, 120);

  /*
   * The shaper was the one planning step deciding WHAT to build while unable to
   * see what the repo already serves.
   *
   * `fileTree` is a list of paths. It says app/api/unanswered_queries.py exists
   * and nothing at all about the fact that it already answers "which questions
   * keep failing", grouped and counted, most frequent first. On 2026-08-21 that
   * produced an epic whose plan contained BOTH a new /api/stats/failed-searches
   * and a rewrite of the existing /api/unanswered-queries/frequent, from one
   * idea, in one pass.
   *
   * The decomposer and the reviewer have had the surface for a while. Both are
   * downstream of this decision: by the time either one could notice a
   * duplicate, the epic that asked for it is already in the ledger and the
   * milestones are already split on it. Deliberately a smaller budget than
   * theirs — this step has to RECOGNISE what exists, not implement against it.
   */
  const surface = await apiSurface(repo, 6000);

  const text = fill(prompt('shape'), {
    REPO_ID: repo.id,
    STACK: stackSummary(repo.path, repo.stack),
    TREE: truncate(tree, 4000),
    SURFACE: surface,
    IDEA: idea.body,
  });

  const out = await brain.ask(text, ShapeSchema, 'shape');
  const ideaId = ledger.addIdea(idea.title, idea.body, repo.id);

  let milestones = 0;
  out.epics.forEach((epic, ei) => {
    const epicId = ledger.addEpic(ideaId, repo.id, epic.title, epic.summary ?? '', ei);
    epic.milestones.forEach((ms, mi) => {
      ledger.addMilestone(epicId, repo.id, ms.title, ms.detail ?? '', ei * 100 + mi);
      milestones++;
    });
  });
  ledger.setIdeaStatus(ideaId, 'shaped');
  log.info(`Shaped "${idea.title}" -> ${out.epics.length} epic(s), ${milestones} milestone(s)`);
  return milestones;
}

/**
 * Mechanical validation of brain output. The model is told the rules; this is
 * where they are actually enforced, because a prompt is not a constraint.
 */
/**
 * A task whose whole content is declaring a type, interface or constant.
 *
 * These are how the 2026-08-06 dead-code problem started: the planner split one
 * feature into "define the type" / "write the helper" / "test the helper", each
 * landed as its own commit, and the task that would have *used* any of it never
 * got scheduled. The declaration belongs in the task that consumes it.
 *
 * The gate now rejects unreferenced exports anyway, so this just stops the
 * planner wasting a slot on work that is going to bounce.
 */
export function isDefinitionOnly(t: NormalizedTask): boolean {
  const declares =
    /^\s*(define|declare|add|create|introduce|export)\b.*\b(type|types|typing|interface|schema|enum|constant|signature)\b/i.test(
      t.title,
    );
  if (!declares) return false;

  // A big change that happens to mention "schema" is probably doing real work.
  const small = t.est_lines <= 15;
  // "…and use it in X" / "…and wire it into Y" is not declaration-only.
  const alsoUses = /\b(use|uses|using|wire|wires|integrat|call|calls|consume|apply)/i.test(
    `${t.title} ${t.instruction}`,
  );
  return small && !alsoUses;
}

/**
 * A task that removes or moves something, without checking the old thing is gone.
 *
 * The build passing does not prove a deletion happened. Dead code compiles, and
 * a duplicate left behind passes every test — so on 2026-08-08 a seven-task
 * consolidation committed 7 of 7, copied instead of moved, and left six files in
 * both `src/` and `app/`. The gate verifies that what exists works; it has no
 * way to notice that what should be gone is still there.
 *
 * So a removal task must assert in its own `verify_cmd` that the old thing is
 * GONE. That is checkable here, cheaply, before a provider request is spent.
 */

/**
 * Does `cmd` refer to `path` — as a path, not as a coincidence of letters?
 *
 * The old test split the path on slashes and asked whether the command contained
 * any segment longer than two characters. That is substring containment, and it
 * collides: `src/api/auth.py` was accepted as "checked" by
 * `python -m pytest tests/test_auth.py`, because the letters `auth.py` do appear
 * inside `test_auth.py`. Three relocation tasks committed on that collision, none
 * of them having checked the source path at all.
 *
 * So a reference is the full path, or the basename with nothing glued to its
 * front — `tests/test_auth.py` no longer answers for `src/api/auth.py`.
 */
/**
 * The spellings of `path` that a verify_cmd may legitimately use, longest first:
 * the path itself, its basename, then each ancestor directory. The ancestors are
 * there because proving the PARENT is gone proves everything under it is gone —
 * `Remove legacy src directory` checked `os.path.exists('src')`, and that is a
 * stronger assertion about `src/main.py` than naming the file would have been.
 */
function pathForms(path: string): string[] {
  const p = path.toLowerCase().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!p) return [];
  const segs = p.split('/').filter(Boolean);
  const forms = [p];
  const base = segs[segs.length - 1] ?? '';
  /* A basename is evidence only if it is a name rather than a fragment. Three
     characters is not: the old rule's floor let `api`, out of `src/api/auth.py`,
     be found in any word containing those letters. An ancestor has no such floor
     because it must be followed by a `/` or a quote to match at all. */
  if (base.length > 3) forms.push(base);
  for (let i = segs.length - 1; i >= 1; i--) forms.push(segs.slice(0, i).join('/'));
  return forms;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `cmd` names `path`, or -1. Boundary-anchored on both sides. */
function pathIndex(c: string, path: string): number {
  for (const form of pathForms(path)) {
    // Nothing glued to either end: `test_auth.py` must not answer for `auth.py`,
    // and `app.main` must not answer for `app/`.
    const m = new RegExp(`(^|[^\\w.\\-])${escapeRe(form)}(?![\\w.\\-])`).exec(c);
    if (m) return m.index + (m[1]?.length ?? 0);
  }
  return -1;
}

export function refersToPath(cmd: string, path: string): boolean {
  return pathIndex(cmd.toLowerCase().replace(/\\/g, '/'), path) >= 0;
}

/**
 * Does `cmd` assert that `path` is GONE, rather than merely mentioning it?
 *
 * Mentioning was the old bar, and it turned out to be no bar at all. `Relocate
 * main.py to app/main.py` (Tjuu2ucpja6) named `src/main.py`, `app/main.py` and
 * `tests/test_main.py`, and was verified with `python -c "from app.main import
 * create_app"`. That names the DESTINATION. It proves the new file works and
 * says nothing whatever about the old one, which is precisely the copy-instead-
 * of-move failure this guard exists to prevent — and it committed.
 *
 * Exactly one task in the whole ledger did it properly, and it is the shape
 * asked for here: `... and not os.path.exists('src/core/logging.py')`.
 */
export function assertsAbsence(cmd: string, path: string): boolean {
  const c = cmd.toLowerCase().replace(/\\/g, '/');
  const at = pathIndex(c, path);
  if (at < 0) return false;

  const before = c.slice(0, at);
  /* `not` and `!` are how the ledger spells it; `1 if` is the shape the rejection
     message below asks the agent to write, so it has to be accepted. There was a
     `false` alternative here too — no command anywhere spells it that way, and an
     alternative nothing reaches reads like coverage without being any. */
  const neg = /\bnot\b|!|\b1\s+if\b/g;
  let last = -1;
  for (let m = neg.exec(before); m; m = neg.exec(before)) last = m.index + m[0].length;
  if (last < 0) return false;

  const gap = before.slice(last);
  /*
   * Everything below asks the same question: does that negation apply to THIS
   * path, or is it just somewhere to the left of it?
   *
   * Forty characters covers every real spelling — `not os.path.exists(`,
   * `! test -f `, `sys.exit(1 if os.path.exists(` — and a command separator in
   * between means the negation belongs to a different command entirely.
   */
  if (gap.length > 40 || /[;&|]/.test(gap)) return false;
  /*
   * And a quote that closes before the path ends the negation's reach:
   * `pytest -k "not slow" tests/test_old.py` is a test SELECTOR, not a claim
   * that anything was deleted. The only quote allowed in the gap is the one
   * that opens the path itself, as in `os.path.exists('src/old.py')`.
   */
  return !/["'](?!$)/.test(gap);
}

export function isUncheckedRemoval(t: NormalizedTask): boolean {
  /*
   * Matched on the TITLE only, and that is deliberate rather than an oversight.
   *
   * Widening this to the instruction was tried and is wrong: across the ledger
   * it matches nine further tasks and every one is a false positive — `delete`
   * as an API method, `DELETE /documents` as an HTTP verb, `delete-orphan` as
   * SQLAlchemy cascade config, `remove repeating headers` as text processing,
   * `clean up the retry loop`, renaming a group row. Two are repair tasks whose
   * boilerplate literally reads "Do not delete, skip or weaken a test". Six of
   * the nine committed successfully. The title is the better signal precisely
   * because a task that removes a FILE says so in its title.
   */
  /*
   * A task whose main verb ADDS something is not a removal task, whatever words
   * turn up later in the title. `Implement Group DELETE endpoint with optional
   * hard-delete` (T79pw5wt9xe) is an HTTP verb and a database row, not a file —
   * and it is sitting in the backlog right now, so getting this wrong blocks
   * live work. The old rule let it past only by accident: the substring
   * collision above happened to match `groups.py`. Tightening the check without
   * this exclusion turned that accident into a rejection.
   */
  if (/^\s*(implement|add|create|introduce|build|support|write|extend)\b/i.test(t.title)) return false;

  const removes =
    /\b(remove|delete|drop|eliminate|purge|clean\s*up|get\s*rid\s*of)\b/i.test(t.title) ||
    /\b(relocate|move|rename|migrate)\b/i.test(t.title);
  if (!removes) return false;

  const cmd = t.verify_cmd ?? '';
  const paths = [...(t.claim?.paths ?? []), ...(t.files_hint ?? [])];

  /*
   * No paths is now a REJECTION, where it used to be a free pass.
   *
   * "Nothing named to check against" was treated as nothing to complain about,
   * which is backwards: a task that proposes to delete something and cannot say
   * what is the least verifiable task there is, and the escape was unconditional.
   * No real task has hit it yet — all ten in the ledger name paths — so this
   * closes a hole rather than changing observed behaviour.
   */
  if (paths.length === 0) return true;

  return !paths.some((p) => assertsAbsence(cmd, p));
}

/**
 * Sentence-ish pieces of an instruction, with backticked spans left whole.
 *
 * `.` is the sentence break and it is also in every filename, so a plain split
 * cuts `app/services/document_search.py` in half and leaves the backticks
 * unpaired — which silently unpairs every later one in the sentence too. That
 * is not a hypothetical: it is why the first version of `removalTouches` did
 * not flag the task it was written for.
 */
function clauses(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let tick = false;
  for (const c of text) {
    if (c === '`') tick = !tick;
    if (!tick && (c === '.' || c === ';' || c === '\n')) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Repo-relative, forward slashes, no leading `./` — how a files_hint is compared. */
function rel(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Files that would stop working if this task did what its instruction says.
 *
 * A deletion is atomic in a way nothing else here is. Every other kind of task
 * can be cut down to fit the file budget and still leave the repo green; a
 * symbol removal that leaves one caller behind leaves the build broken, and the
 * intern is then choosing between shipping that and editing a file it was not
 * sent to edit. On 2026-08-23 it chose the second and the gate — correctly —
 * threw the task away for tampering with a test it had not declared. The plan
 * was what made both options bad.
 *
 * Narrow on three counts, because `isUncheckedRemoval` records what happens
 * when removal language is read loosely: nine matches on the ledger's
 * instructions, nine false positives, `DELETE /documents` and `delete-orphan`
 * among them. Here the word has to sit in the same clause as a backticked
 * name, the name has to be an identifier this repo actually declares, and it
 * has to be declared in a file this task already claims. `remove the `limit`
 * parameter` survives all three: `limit` is declared nowhere.
 */
export function removalTouches(n: NormalizedTask, symbols: RepoSymbols): string[] {
  const claimed = new Set([...(n.claim?.paths ?? []), ...n.files_hint].map(rel));
  const out = new Set<string>();

  for (const clause of clauses(n.instruction)) {
    const verb = /\b(remove|delete|drop|eliminate|purge)\b/i.exec(clause);
    if (!verb) continue;
    /*
     * Only what is between the verb and the first preposition that turns the
     * next name into a place. "Remove the `offset` and `limit` parameters and
     * internal list slicing logic from `combine_scores`" is a task in the
     * ledger right now, and reading `combine_scores` as its object would demand
     * every caller of a function that is being kept.
     */
    const scope = clause
      .slice(verb.index + verb[0].length)
      .split(/\b(?:from|in|of)\b/i)[0]!;
    for (const m of scope.matchAll(/`([^`]+)`/g)) {
      const sym = m[1]!.trim().replace(/\(\s*\)$/, '');
      const home = symbols.declaredIn(sym);
      // Declared somewhere this task is already opening, or it is not this
      // task's to delete and the word meant something else.
      if (!home.some((f) => claimed.has(rel(f)))) continue;
      for (const user of symbols.usedIn(sym)) out.add(rel(user));
    }
  }
  return [...out];
}

/**
 * A task planned against a part of the repo that does not exist.
 *
 * On 2026-08-13 the decomposer planned five tasks against
 * `frontend/src/components/*.tsx` in a repo that is `app/ src/ tests/ alembic/`
 * and has no `frontend` at all. It had been given the real file tree and
 * hallucinated a UI anyway. What that cost is worth being precise about, because
 * none of it looked like a planning fault from the outside: agy opened
 * `SearchBar.tsx`, got "the system cannot find the path specified", tried to
 * search for the file, was refused the shell command, and exited with no output.
 * The message the operator got was about permissions, and the advice was to
 * widen an allow-list that was already correct.
 *
 * The check is deliberately per-task rather than per-path: a task may create new
 * files, and a feature that adds `frontend/x.tsx` alongside `app/api/y.py` is
 * ordinary work. It is a task rooted ENTIRELY in directories the repo has never
 * heard of that has stopped describing this codebase.
 *
 * The escape hatch is the one `isUncheckedRemoval` uses, for the same reason:
 * naming the new root in `verify_cmd`. Creating a genuinely new top-level area
 * is legitimate, but unattended it has to prove it happened — otherwise the
 * repo's own check passes on a task that wrote nothing, which is exactly how
 * four of those five would have been scored as successes.
 *
 * Returns the offending root(s), or null when the task is fine.
 */
export function phantomRoot(t: NormalizedTask, roots: Set<string>): string | null {
  // Empty means "cannot tell" (fresh or untracked repo), never "reject everything".
  if (roots.size === 0) return null;

  const paths = [...(t.claim?.paths ?? []), ...(t.files_hint ?? [])];
  if (paths.length === 0) return null; // nothing named to check

  const missing = new Set<string>();
  for (const path of paths) {
    // Leading `./` and `/` are noise. A bare leading dot is NOT: `.env.example`
    // and `.github` are real tracked roots and must survive intact.
    const root = path.replace(/^(?:\.[/\\]|[/\\])+/, '').split(/[/\\]/)[0]?.toLowerCase();
    if (!root) continue;
    if (roots.has(root)) return null; // one real anchor is enough
    missing.add(root);
  }
  if (missing.size === 0) return null;

  const cmd = (t.verify_cmd ?? '').toLowerCase();
  for (const root of missing) {
    if (cmd.includes(root)) return null; // the check names it, so it is checkable
  }
  return [...missing].join(', ');
}

/**
 * Strip dependency chains deeper than `maxDepth`.
 *
 * A dependency is a liability: a failed task freezes its entire downstream chain
 * for good. The planner chains far more eagerly than it needs to — it made
 * `Create vitest.config.ts` depend on other work — and eight failures on
 * 2026-08-06 deadlocked 38 of 59 queued tasks as a result.
 *
 * Truncating is safe. `depends_on` only controls scheduling order, and `ord`
 * already preserves the intended sequence.
 */
export function capDependencyDepth(tasks: NormalizedTask[], maxDepth = 2): NormalizedTask[] {
  const depth = (i: number, seen = new Set<number>()): number => {
    if (seen.has(i)) return 0;
    seen.add(i);
    const deps = tasks[i]?.depends_on ?? [];
    if (deps.length === 0) return 0;
    return 1 + Math.max(...deps.map((d) => (d < i ? depth(d, seen) : 0)));
  };

  return tasks.map((t, i) => {
    if (t.depends_on.length === 0) return t;
    if (depth(i) <= maxDepth) return t;
    log.warn(`"${t.title}": dependency chain deeper than ${maxDepth}, dropping its deps`);
    return { ...t, depends_on: [] };
  });
}

/** Caps, because these end up in a WHERE clause and a prompt digest. */
const MAX_CLAIM_ENTRIES = 12;

/**
 * Coerce whatever the model returned into a usable claim.
 *
 * The prompt asks for one, but a prompt is a request rather than a constraint,
 * so the shape is enforced here. When no claim is given, `files_hint` is a fair
 * proxy for the paths — that alone can only ever produce DRIFTED, which
 * dispatches anyway, so it cannot cost anything.
 */
export function normaliseClaim(t: {
  claim?: { paths?: string[]; symbols?: string[] };
  files_hint?: string[];
}): { paths: string[]; symbols: string[] } {
  const clean = (xs: unknown): string[] =>
    Array.isArray(xs)
      ? [...new Set(xs.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))].slice(
          0,
          MAX_CLAIM_ENTRIES,
        )
      : [];

  const paths = clean(t.claim?.paths);
  return {
    paths: paths.length ? paths : clean(t.files_hint),
    symbols: clean(t.claim?.symbols),
  };
}

/**
 * Drop one proposal, and keep the reason somewhere it outlives the console.
 *
 * The reason used to exist only as a log line. That is how "Relocate health
 * module" disappeared on 2026-08-08: every proposal for the milestone was
 * dropped, the milestone was closed, and the single record of why scrolled past
 * in a log nobody re-reads. Collected reasons are stored on the milestone, the
 * way a failed task keeps its `last_error` for `sa retry --failed` and
 * scripts/triage.ts to act on.
 */
function reject(into: string[], title: string, why: string): void {
  log.warn(`drop "${title}": ${why}`);
  into.push(`${title} — ${why}`);
}

/**
 * Does this task actually say what to do?
 *
 * `Tzyqrdo67z0` ("Initial Task", example-api) was planned on 2026-08-09 with the
 * instruction "Execute primary task specification according to project
 * guidelines." It spent two agent dispatches before a human read it on 08-12 and
 * wrote the diagnosis into `last_error` by hand. Four more got planned with the
 * same shape and two of those were COMMITTED, which is worse than failing: an
 * agent handed a restatement of the request invents something plausible, and the
 * gate has no way to notice the commit answers no actual question.
 *
 * Matched on the shape of the text rather than a blocklist of phrases: a
 * placeholder restates the request without adding anything to it, and names no
 * file, symbol or identifier the agent could act on.
 */
export function isPlaceholder(n: NormalizedTask): boolean {
  const instr = n.instruction.trim();

  // Anything genuinely specific mentions something concrete — a path, a
  // dotted name, a function call, a quoted identifier, or a backticked term.
  const namesSomething = /[`'"]|\w+\.\w+|\w+\/|\w+\(\)/.test(instr);
  if (namesSomething) return false;

  const GENERIC =
    /^(implement|execute|complete|perform|do)(\s|$).{0,88}$|as (described|specified|required)|according to (project )?(guidelines|spec)|primary task/i;

  return instr.length < 120 && GENERIC.test(instr);
}

/**
 * A task check that cannot possibly run in this project.
 *
 * Both real cases were in example-api, which is python and has no package.json.
 * `Tzyqrdo67z0` asked for `npm test`; `Tphmpi8y4pq` asked for a `node -e` script
 * reading `frontend/src/components/SearchBar.tsx`. Neither could have run, and
 * neither failure said so: the first was diagnosed by hand three days later, and
 * the second surfaced to the operator as BLOCKED — a permissions message about
 * an allow-list that was already correct.
 *
 * Only the unambiguous cases: a node script in a repo with no package.json, or
 * a python one where there is no python project at all. Anything subtler is
 * left alone — a wrong guess here rejects real work, which costs more than
 * letting an odd-looking command through to the gate.
 */
export function wrongToolForStack(verifyCmd: string, repo: Repo): string | null {
  /*
   * A leading `cd <dir> &&` moves the goalposts, so follow it.
   *
   * Both tests below anchor at the start of the command, and a `cd` prefix
   * walks straight past them. Measured 2026-08-20: the planner wrote
   * `cd frontend && npx tsc --noEmit` for example-api, whose frontend/ holds two
   * .tsx files and no package.json, no tsconfig.json and no node_modules. It
   * was accepted. Running it prints "This is not the tsc command you are
   * looking for" and exits 1, so the task could only ever burn its attempts —
   * while the SAME tool without the prefix was correctly rejected twice in the
   * same run.
   *
   * Where the command runs is where its tooling has to live, so that is where
   * to look. This keeps `cd frontend && npm test` valid the moment
   * frontend/package.json exists, rather than banning the shape outright.
   */
  const trimmed = verifyCmd.trim();
  const cd = /^cd\s+([^\s&|;]+)\s*&&\s*(.+)$/s.exec(trimmed);
  const subdir = cd ? cd[1]! : '';
  const base = subdir ? join(repo.path, subdir) : repo.path;
  const cmd = (cd ? cd[2]! : trimmed).trim().toLowerCase();
  // Where the check would run, so the message points at the right folder.
  const where = subdir ? `${repo.id}/${subdir}` : repo.id;

  /*
   * No folder, no opinion. Judging a project's stack means looking at its files,
   * so if the directory is not there this check has nothing to go on — and
   * "cannot tell" must never read as "wrong". Rejecting real work on a guess
   * costs more than letting an odd-looking command through to the gate.
   *
   * This deliberately also covers a `cd` into a directory that does not exist
   * yet: a task whose job is to scaffold that directory would otherwise be
   * rejected for the very absence it was written to fix.
   */
  if (!existsSync(base)) return null;

  const has = (f: string) => existsSync(join(base, f));

  // Written as (\s|$) rather than \b: a \b here once became a literal backspace
  // byte on its way into the file, and the regex then silently matched nothing.
  if (/^(npm|npx|yarn|pnpm|node)(\s|$)/.test(cmd) && !has('package.json')) {
    return `verify_cmd "${verifyCmd}" needs package.json, which ${where} does not have`;
  }
  if (
    /^(python|py|pytest)(\s|$)/.test(cmd) &&
    !has('pyproject.toml') && !has('requirements.txt') && !has('setup.py') && !has('tests')
  ) {
    return `verify_cmd "${verifyCmd}" is a python check, but ${where} has no python project`;
  }
  return null;
}

/**
 * Shells, and the ways a command asks one to run a file.
 *
 * `source` and `.` are here because they execute a file too; `cmd`, `pwsh` and
 * `powershell` because this runs on Windows and the same trick spells three
 * more ways.
 */
const SHELL_RUNNER = /^(bash|sh|zsh|dash|ksh|source|\.|cmd|cmd\.exe|powershell|pwsh)(\s|$)/;

/**
 * A check the agent under test is free to rewrite.
 *
 * Measured on the first greenfield run, 2026-08-26. `example-receipts` was created as a
 * python project and the decomposer gave seven of its eight tasks the same
 * check: `bash test_summary.sh`. The agent wrote `test_summary.sh`. So four
 * commits went in, unattended, each verified by a file its own author had just
 * edited — and the last of them rewrote that file 13KB long while the task it
 * was proving was still open.
 *
 * The rule is not new; only its reach is. `registerRepo` has said it since the
 * day scaffolding was written, about the repo's own gate: "It must NOT be a
 * script inside the repo: an agent can edit those, and a gate an agent can edit
 * is not a gate." Nothing said it about the check a TASK brings with it, and
 * the task's check is the one a model chooses.
 *
 * Both existing guards abstained, correctly by their own terms.
 * `wrongToolForStack` asks whether the command's tooling exists in the repo and
 * has no entry for `bash`, so it had no opinion. `gateCannotCheck` asks whether
 * anything can judge the FILES, and `.sh` belongs to no stack, so `code` came
 * back empty and it had no opinion either. Two guards built for stack-against-
 * stack mismatch, and a file of no known stack fell between them.
 *
 * Deliberately narrow in two ways:
 *
 *   - Only the TASK's check. The repo's `verify_cmd` is the operator's, chosen
 *     by hand in a file no agent may write to, and a project whose own
 *     convention is `./scripts/test.sh` is entitled to it.
 *   - Only shells. A test runner given a path — `pytest tests/x.py`, `python -m
 *     unittest test_x.py`, `go test ./...` — is tooling doing its job, and the
 *     file it loads is a test file, which is the thing being asked for. What is
 *     refused is handing a shell an arbitrary script and calling the result a
 *     verdict.
 */
/**
 * Constructs that do not survive the shell this machine actually uses.
 *
 * Deliberately tiny, and every entry measured on 2026-08-27 rather than assumed
 * from what "looks like Unix". `execa` runs a verify_cmd with `shell: true`,
 * which on Windows is `cmd.exe` — but Git's tools are on PATH here, so `ls`,
 * `rm`, `touch` and `grep` all run perfectly well. Rejecting a command for
 * looking POSIX would refuse work that would have passed.
 *
 * What is listed here is what was measured to break:
 *
 *   mkdir -p    cmd's mkdir has no `-p`, so it creates a directory literally
 *               NAMED `-p` and exits 0. The command therefore passes once,
 *               poisons the repo with a junk folder, and fails on every run
 *               after it with "A subdirectory or file -p already exists".
 *   /dev/null   does not exist; the redirect fails.
 *   export      not a cmd builtin.
 *   $(...)      cmd has no command substitution.
 */
const WRONG_SHELL: [RegExp, string][] = [
  [/(^|[&|;]\s*)mkdir\s+-p(\s|$)/i, '`mkdir -p` on Windows makes a directory called "-p" and then fails every run after the first'],
  [/\/dev\/null/, 'there is no /dev/null on Windows'],
  [/(^|[&|;]\s*)export\s+\w+=/i, '`export` is not a command on Windows'],
  [/\$\(/, 'cmd.exe has no $(...) command substitution'],
];

/**
 * A check that cannot run here, whatever the code does.
 *
 * Measured, on the first project ShanAuto built from a prompt through the TUI.
 * The decomposer gave "Add tick command and show completion in list" this gate:
 *
 *     mkdir -p todo tests && python -m compileall -q ... .
 *
 * `mkdir -p` is Unix. cmd.exe read `-p` as a directory name, made one, and
 * returned 0. The next attempt found it already there, failed, and the task
 * burned both attempts to a command that never reached Python — against code
 * nobody ever looked at. The operator asked for four things and got three.
 *
 * This is the third guard in this family and the narrowest. `wrongToolForStack`
 * asks whether the tooling exists in the repo; `gateCannotCheck` asks whether
 * anything could judge the files; this asks whether the shell can even parse
 * it. All three exist because a gate that cannot run is worse than no gate: it
 * fails honest work and says nothing about why.
 *
 * Platform is a parameter so the rule is testable from either side. On a POSIX
 * host every one of these is correct and nothing is rejected.
 */
export function wrongShellForHost(
  verifyCmd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;

  for (const [re, why] of WRONG_SHELL) {
    if (re.test(verifyCmd)) {
      return (
        `verify_cmd "${verifyCmd}" cannot run on this machine: ${why}. ` +
        `The check is run by cmd.exe, so write it the way it would be typed there ` +
        `— and prefer a command that only tests, since anything that creates ` +
        `directories has to work twice`
      );
    }
  }
  return null;
}

export function selfCertifying(verifyCmd: string): string | null {
  for (const part of splitTopLevel(verifyCmd)) {
    const cmd = part.trim();
    /*
     * No `cd` skip, unlike wrongToolForStack above. That one needs it because
     * it resolves the directory being changed into; here a `cd` part matches
     * neither test below, so skipping it was dead code - proved by deleting it
     * and watching every test still pass (mutant Q6, 2026-08-26).
     */
    // `./x.sh` and `.\x.ps1` name a file directly, without a shell in front.
    const direct = /^[.]{1,2}[\\/]/.test(cmd);
    if (direct || SHELL_RUNNER.test(cmd.toLowerCase())) {
      return (
        `verify_cmd "${verifyCmd}" runs a script from inside the repo, which the agent ` +
        `doing this task can edit — so it proves nothing. Name the test runner instead ` +
        `(for example "python -m pytest -q tests/test_x.py"), and put what the check ` +
        `must prove in the test file, not in a shell script`
      );
    }
  }
  return null;
}

/**
 * Tooling that can actually run code of a given stack, as the leading word of a
 * command. Head word only, the way wrongToolForStack does it: `[.]next` inside
 * example-api's compileall exclusion pattern matches a bare /next/ anywhere-search,
 * which would credit that gate with being able to check TypeScript.
 */
const GATE_TOOLS: Record<string, RegExp> = {
  python: /^(python3?|py|pytest|tox|nox|ruff|mypy|flake8)(\s|$)/,
  typescript: /^(npm|npx|yarn|pnpm|node|tsc|vitest|jest|eslint|next|vite)(\s|$)/,
  javascript: /^(npm|npx|yarn|pnpm|node|vitest|jest|eslint|next|vite)(\s|$)/,
  go: /^go(\s|$)/,
};

/**
 * Work that no check in this repo could judge.
 *
 * Run 18 committed and pushed 391 lines of TypeScript to example-api and called
 * both tasks clean successes. example-api's gate is
 * `python -m compileall ... && python -m pytest -q`; it collects 194 tests and
 * not one of them touches a .tsx file. There is no package.json and no
 * tsconfig.json anywhere in that repo, so there is no compiler, no linter and
 * no test runner for the two .tsx files it does contain. One of them is a test
 * file that has never been executed by anything.
 *
 * `wrongToolForStack` is the sibling of this and asks the mirror question: it
 * judges whether the COMMAND's tooling exists in the repo. It passed both of
 * those tasks, correctly — `python -c "..."` is a fine command in a python
 * repo. What nothing asked was whether that command could say anything about
 * the FILES being changed. Reading a .tsx file with python is not checking it.
 *
 * stackSummary already argues this doctrine for the neighbouring case, where
 * config names a toolchain the repo does not have: "A gate is the whole
 * guarantee here. Work that no gate can judge does not get planned." This is
 * the same rule for work whose source is already present and still ungated.
 *
 * Narrow in three deliberate ways, because rejecting real work costs more than
 * letting an odd task through:
 *
 *   - Both commands count. The repo gate always runs, and the task may add its
 *     own check on top; either one being able to run the code is enough.
 *   - A head word this table does not know credits every stack. "Cannot tell"
 *     must never read as "wrong", which is wrongToolForStack's rule too.
 *   - Only when EVERY code file in the hint is ungated. A task that touches
 *     .py and .tsx together is half judged, which is a weaker problem than
 *     this one, and refusing it would block ordinary cross-cutting work.
 */
export function gateCannotCheck(n: NormalizedTask, repo: Repo): string | null {
  const code = n.files_hint.map((f) => stackOfFile(f)).filter((s): s is Stack => !!s);
  if (code.length === 0) return null;

  const covered = new Set<string>();
  for (const part of [repo.verify_cmd, n.verify_cmd].flatMap(splitTopLevel)) {
    const cmd = part.trim().toLowerCase();
    if (/^cd(\s|$)/.test(cmd)) continue; // navigation, not tooling
    /*
     * Every tool the command names, not the first one the table happens to
     * list. `find` here let declaration order decide: python is declared first,
     * so a python command could never be seen to also match typescript, and
     * reverting the `^` anchor above to an anywhere-search changed nothing that
     * any test could observe — `node_modules` in example-api's exclusion pattern
     * matched, and the answer was discarded before it could be wrong out loud.
     */
    const hits = Object.entries(GATE_TOOLS).filter(([, re]) => re.test(cmd));
    // Something this table cannot name might check anything. No opinion.
    if (hits.length === 0) return null;
    for (const [id] of hits) covered.add(id);
  }
  /*
   * TypeScript and JavaScript are one ecosystem here, as they are in
   * phantomStacks: `npm test` names neither, and whatever it runs can check
   * both. Without this a .js file in a repo gated by `npx tsc` is rejected for
   * an ecosystem mismatch with itself.
   */
  if (covered.has('typescript')) covered.add('javascript');
  if (covered.has('javascript')) covered.add('typescript');
  if (code.some((s) => covered.has(s.id))) return null;

  const kinds = [...new Set(code.map((s) => s.label))].join(' and ');
  return (
    `every file this task changes is ${kinds} (${n.files_hint.slice(0, 3).join(', ')}), ` +
    `but nothing that would judge it can run ${kinds} — the repo's check is ` +
    `"${repo.verify_cmd}" and this task adds "${n.verify_cmd}". Neither could tell a ` +
    'working change from a broken one. Plan work the checks in this repo can actually ' +
    'verify'
  );
}

/**
 * Split a command on its top-level `&&` / `||`, leaving quoted text alone.
 *
 * A plain regex split would cut `python -c "assert a and b"` in half the moment
 * someone wrote `&&` inside the quoted program, and judge two fragments that are
 * not commands. Cheap to do properly, so it is done properly.
 */
export function splitTopLevel(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * A task check that restates the diff instead of testing it.
 *
 * `grep -q "better-sqlite3" package.json` is in the ledger as a real task check.
 * The task's job was to add that dependency, so the check passed the moment the
 * agent typed the line — and an unused native dependency reached main on the
 * strength of it. verifier.ts documents that commit as the reason the repo's own
 * check now always runs; this stops the same check being written in the first
 * place, one provider request earlier.
 *
 * The rule is narrow on purpose: reject only when the WHOLE check is a positive
 * presence assertion. Two forms are deliberately still allowed, because both
 * prove something the diff does not:
 *
 *   - absence (`! grep -q`, `grep -v`, `not in`, `sys.exit(1 if ... )`) — this is
 *     exactly what isUncheckedRemoval demands of a removal task, and a removal is
 *     the one thing a passing build genuinely cannot show.
 *   - composition (`... && pytest tests/x.py`) — the presence check is then just
 *     a fast precondition in front of a real one, which is how most of the
 *     example-api tasks are written and is fine.
 */
export function tautologicalCheck(verifyCmd: string): boolean {
  const cmd = verifyCmd.trim();

  /*
   * Composed with anything else, the presence test is a precondition, not the
   * check. Only `&&` and `||` count. `;` was in here too and was wrong: every
   * python one-liner in the ledger is `python -c "import sys; sys.exit(...)"`,
   * where the semicolon separates STATEMENTS inside the quoted program, not
   * shell commands — so the whole interpreter branch below was unreachable for
   * exactly the commands it was written for.
   *
   * But "composed" only earns the exemption when something in the composition
   * is a REAL check. This returned false for any `&&` at all until the from-zero
   * run of 2026-08-20 planned
   *
   *     test -f frontend/package.json && test -f frontend/vitest.config.ts
   *
   * and it sailed through — one tautology vouching for another. The single-part
   * spelling of the very same assertion was refused in the same pass, which is
   * how it was caught. Every part tautological means the whole thing is.
   */
  const parts = splitTopLevel(cmd);
  if (parts.length > 1) return parts.every((part) => tautologicalCheck(part));

  /*
   * An absence assertion proves a removal, which no build can prove. Keep it.
   *
   * `not exists` belongs here for the same reason `not in` already does: it is
   * the one question a presence test answers honestly. `? 1 : 0` is the same
   * assertion in JavaScript — the negation lives in the swapped branches rather
   * than in a word — and is the counterpart of the `exit(1 if` case beside it.
   */
  if (
    /(^|\s)!|(^|\s)-v(\s|$)|\bnot\s+in\b|\bexit\(1\s+if\b|\bsys\.exit\(1\s|\bnot\s+(\w+\.)*(exists|isfile|is_file)\s*\(|\?\s*1\s*:\s*0\b/i.test(
      cmd,
    )
  )
    return false;

  // `grep -q PATTERN FILE` and nothing more.
  if (/^!?\s*grep\b/.test(cmd)) return true;

  /*
   * The weakest spelling there is: assert the file exists.
   *
   * From-zero run, 2026-08-20. The same milestone was refused three times for
   * `node -e "existsSync(...)"` and for a substring one-liner, and then landed
   * `python -c "import os; assert os.path.exists('frontend/src/components/
   * UnansweredQueriesLeaderboard.tsx')"` — which passed every guard here and
   * queued three tasks whose gate proves only that a file with that name was
   * created. Nothing about the component would have had to work, and in a repo
   * whose gate is compileall + pytest, a .tsx file is invisible to both.
   *
   * A substring check at least asks what is IN the file. This asks less than
   * that, so it cannot be the thing the substring rule below refuses to accept.
   */
  if (/\b(os\.path\.)?(exists|isfile|is_file)\s*\(|\bexistssync\s*\(|(^|\s)(test|\[)\s+-[ef]\s|\btest-path\b/i.test(cmd))
    return true;

  /*
   * The interpreter one-liner spelling of the same thing: read a file, assert a
   * substring is in it.
   *
   * There was a third condition here — "and no test runner appears in the
   * command" — and mutation testing showed removing it changed nothing, on the
   * suite OR on a replay of all 182 real tasks. It was unreachable: the only
   * way a command both reads a file for a substring AND runs a suite is by
   * composing them, and composition already returned above. Kept as a comment
   * rather than as code, because an unreachable guard reads like protection
   * and is not.
   */
  const readsAFile = /\b(open\s*\(|readfilesync\s*\(|read_text\s*\()/i.test(cmd);
  /*
   * The first four alternatives name the read INSIDE the containment test, so
   * they see `'x' in open(f).read()` and `'x' in c.read()` and stop there.
   *
   * The read parked in a variable first walks past all of them, which is how
   * run 18 shipped two checks and run 19 shipped a third:
   *
   *     python -c "content = open('...SearchBar.tsx').read();
   *                assert 'items' in content, 'Frontend not updated'"
   *     python -c "import sys; src = open('f').read();
   *                sys.exit(0 if 'X' in src else 1)"
   *
   * Matching `assert` caught the first and not the second. Adding `sys.exit`
   * beside it would catch the second and not the fourth, and there is always a
   * fourth: this guard has been extended one spelling at a time three times.
   *
   * So ask the question the rule is actually about. The containment is a
   * tautology when it is the VERDICT - when finding the string is what decides
   * whether the command passes. That is why
   *
   *     python -c "c = open('f').read(); assert c.count('def ') >= 3;
   *                print('limit' in c)"
   *
   * is a real check despite containing a containment over a file read: the
   * containment is printed, and `print` decides nothing. The ways a one-liner
   * can decide are a closed set - it asserts, it throws, or it exits, under
   * whatever name - where the ways to spell a read are not. Match the closed
   * one. `raise SystemExit(...)` needs no alternative of its own: the exit
   * pattern is case-insensitive and matches the `SystemExit(` it raises.
   *
   * Statement-scoped for the same reason the `[^;]*` was: the verdict and the
   * containment have to be the same statement, or a `sys.exit` at the end of
   * the program would vouch for an `in` anywhere before it. Negations never
   * arrive here; `not in` and `exit(1 if` returned false above.
   */
  const verdictOn = (stmt: string) =>
    /\b(assert|throw)\b|\b\w*exit\s*\(/i.test(stmt) && /\bin\b/i.test(stmt);
  const assertsSubstring =
    /\bin\s+open\b|\.includes\s*\(|\bfind\s*\(|\bin\s+\w+\.read\(\)/i.test(cmd) ||
    cmd.split(';').some(verdictOn);

  return readsAFile && assertsSubstring;
}

/**
 * How a disputed premise is introduced to whoever reads the task next.
 *
 * Marked, so it cannot be mistaken for part of the plan it is disputing.
 */
export const DOUBT =
  'DISPUTED BY THE PLAN CHECK — a reader with the file contents in front of it ' +
  'says this premise does not hold. Check it against the code before you brief ' +
  'it, and if it is right, brief the work that is actually needed and say so: ';

const PlanCheckSchema = z.object({
  drop: z
    .array(z.object({ index: z.number().int().nonnegative(), why: z.string() }))
    .default([]),
});

/**
 * Ask whether the plan describes code that exists.
 *
 * O23's other half. The brief author reads the files it is planning against
 * now; the DECOMPOSER that wrote the plan still worked from a file tree and a
 * list of names, and a name proves a thing exists and nothing else. Run 21: a
 * job said "remove the iterative fetch" from a one-line function containing no
 * loop, the brief hardened that into its objective, and the junior made the
 * sentence true by hanging a value nothing reads.
 *
 * The issue recorded this as blocked on prompt budget — the whole repo will not
 * fit beside a decompose prompt. It does not have to. By this point the plan has
 * NAMED its files, so the question can be asked as a second, small pass about
 * one to four files, which is the same trade that made the brief affordable.
 *
 * Two lessons from the acceptance check, which made this exact mistake inside
 * its own fix earlier today: give the reader the CODE, and bias it towards
 * keeping. A wrong drop throws away work the operator asked for; a wrong keep
 * costs one task and the gate is still downstream of it.
 *
 * Never throws. A check that cannot run keeps every task, because this is a
 * second opinion on a plan that has already passed `validateTasks`.
 */
export async function dropTasksPlanningAgainstNothing(
  brain: BrainDriver,
  repo: Repo,
  milestone: { title: string; detail?: string | null },
  tasks: NormalizedTask[],
  rejected: string[],
): Promise<NormalizedTask[]> {
  if (!tasks.length) return tasks;

  const named = [...new Set(tasks.flatMap((x) => x.files_hint))].filter(Boolean);
  const bodies = await hintedBodies(repo, named);
  // Nothing readable to judge against is not a verdict. Say nothing.
  if (!bodies.trim()) return tasks;

  try {
    const answer = await brain.ask(
      fill(prompt('plancheck'), {
        MILESTONE: `${milestone.title}\n${milestone.detail ?? ''}`.trim(),
        TASKS: tasks
          .map((x, i) => `${i}. ${x.title}\n   ${x.instruction}\n   files: ${x.files_hint.join(', ')}`)
          .join('\n'),
        BODIES: bodies,
      }),
      PlanCheckSchema,
      'plancheck',
      /*
       * An unexplained drop is unusable: it removes work the operator asked for
       * and records no reason anyone could argue with. Same objection the
       * acceptance check makes about an unexplained shortfall.
       */
      (d) =>
        d.drop.every((x) => x.why.trim())
          ? null
          : 'every dropped job needs a `why` naming what the code actually does',
    );

    const dropped = new Set<number>();
    for (const d of answer.drop) {
      if (d.index < 0 || d.index >= tasks.length) continue;
      dropped.add(d.index);
      rejected.push(`drop "${tasks[d.index]!.title}": ${d.why.trim()}`);
      log.warn(`plan check dropped "${tasks[d.index]!.title}": ${d.why.trim()}`);
    }
    /*
     * Never everything — but never silently, either.
     *
     * A check that empties a plan wholesale has more likely misread one file
     * than caught four separate fictions, and the cost of being wrong that way
     * is the whole milestone. That reasoning is sound at four tasks and hollow
     * at one, where "one fiction" and "one misread" are equally likely — and
     * the first live run hit exactly that: a single-task milestone whose
     * premise the check correctly disputed, kept in full because dropping it
     * would have emptied the plan. Run 21, the case this exists for, was also a
     * single task.
     *
     * So the doubt travels with the work instead of being thrown away with it.
     * It is appended to the instruction, which is what the brief author is
     * shown as WHAT THE PLAN ASKS FOR — and that reader now has the file
     * bodies in front of it, so it is placed to settle the question rather than
     * inherit it. Nothing is lost either way: a doubt that turns out to be
     * wrong costs a paragraph, and one that is right stops the brief hardening
     * a guess into its objective.
     */
    if (dropped.size === tasks.length) {
      log.warn(
        `plan check disputes every task; keeping them, with the doubt attached for the brief.`,
      );
      const why = new Map(answer.drop.map((d) => [d.index, d.why.trim()]));
      return tasks.map((x, i) =>
        why.get(i) ? { ...x, instruction: `${x.instruction}

${DOUBT}${why.get(i)!}` } : x,
      );
    }
    return tasks.filter((_, i) => !dropped.has(i));
  } catch (e) {
    log.warn(`plan check skipped: ${(e as Error).message}`);
    return tasks;
  }
}

export function validateTasks(
  cfg: AppConfig,
  tasks: PlannedTask[],
  rejected: string[] = [],
  /** Top-level tracked entries, from git.trackedRoots. Empty = skip the check. */
  roots: Set<string> = new Set(),
  /*
   * Optional so existing callers and tests are unaffected. Without it the stack
   * check is skipped, which is the same behaviour as before — a check that
   * cannot be made is not a reason to reject work.
   */
  repo?: Repo,
  /**
   * What the repo declares and who names it, for the removal check below.
   * Optional on the same terms as `repo`: without it that check is skipped,
   * which is what a repo too large to index gets too.
   */
  symbols?: RepoSymbols | null,
): NormalizedTask[] {
  const maxFiles = cfg.system.limits.max_files_per_task;
  const kept: NormalizedTask[] = [];
  let docs = 0;

  for (const t of tasks) {
    const n: NormalizedTask = {
      title: t.title,
      kind: t.kind,
      instruction: t.instruction,
      acceptance: t.acceptance,
      files_hint: t.files_hint ?? [],
      verify_cmd: t.verify_cmd,
      depends_on: t.depends_on ?? [],
      est_lines: t.est_lines ?? 20,
      executor_hint: t.executor_hint ?? 'cli',
      // `|| undefined` and not `?? undefined`: a model that has nothing to
      // declare tends to send `""` rather than omit the field, and an empty
      // string would render as a DECLARED BREAKING line saying nothing.
      breaking: t.breaking?.trim() || undefined,
      claim: normaliseClaim(t),
    };

    /*
     * Files a deletion drags in do not count against the budget.
     *
     * The cap is there to stop a task growing scope it chose. A file that
     * references a symbol this task deletes is not scope it chose — it is the
     * same edit, and it has to land in the same commit or the build is broken
     * between them. Counting those against the cap is what forced the plan of
     * 2026-08-23 to name four of the five files it needed and leave the fifth
     * to be discovered by the agent.
     */
    const touches = symbols ? removalTouches(n, symbols) : [];
    const declaredHere = new Set(n.files_hint.map(rel));
    const compelled = new Set(touches);
    const chosen = n.files_hint.filter((f) => !compelled.has(rel(f)));
    if (chosen.length > maxFiles) {
      reject(rejected, n.title, `${n.files_hint.length} files > limit ${maxFiles}`);
      continue;
    }
    if (n.est_lines > 80) {
      reject(rejected, n.title, `est_lines ${n.est_lines} too large for one commit`);
      continue;
    }
    if (!n.verify_cmd.trim()) {
      reject(rejected, n.title, 'no verify_cmd');
      continue;
    }
    /*
     * Ordered before every content check below, because these two are about
     * whether the task can be worked on AT ALL. Both were diagnosed by hand,
     * days late, after the quota had already been spent — the whole point of
     * catching them here is that it costs nothing.
     */
    if (isPlaceholder(n)) {
      reject(rejected, n.title, 'placeholder task with no actual instruction');
      continue;
    }
    const mismatch = repo ? wrongToolForStack(n.verify_cmd, repo) : null;
    if (mismatch) {
      reject(rejected, n.title, mismatch);
      continue;
    }
    /*
     * Before gateCannotCheck rather than after: that guard reasons about which
     * stack the changed files belong to, and the case this catches is one where
     * they belong to none, so it reaches its "cannot tell, no opinion" exit and
     * lets the task through.
     */
    const selfCheck = selfCertifying(n.verify_cmd);
    if (selfCheck) {
      reject(rejected, n.title, selfCheck);
      continue;
    }
    /*
     * Before every guard that reasons about what the command MEANS: a command
     * the shell cannot parse has no meaning to reason about, and the failure it
     * produces is blamed on the agent's code rather than on the check.
     */
    const wrongShell = wrongShellForHost(n.verify_cmd);
    if (wrongShell) {
      reject(rejected, n.title, wrongShell);
      continue;
    }
    const ungated = repo ? gateCannotCheck(n, repo) : null;
    if (ungated) {
      reject(rejected, n.title, ungated);
      continue;
    }
    /*
     * Docs are exempt, and the exemption is the whole reason this is applied
     * here rather than inside tautologicalCheck.
     *
     * Replayed over the ledger, this guard flags 7 real tasks. Six are code or
     * config and every one deserves it — `grep -q "better-sqlite3"
     * package.json` is in there. The seventh is `Document ledger CSV export in
     * README.md`, checked with `grep -q "export-csv" README.md`, and rejecting
     * that would be wrong: for prose there is no test to write instead, so the
     * advice below is unfollowable and the task becomes unplannable. The harm
     * in the config cases is that the presence check stands in for a question
     * about code — is the dependency actually USED — that it cannot answer. A
     * README saying what it says raises no such question.
     */
    if (n.kind !== 'docs' && tautologicalCheck(n.verify_cmd)) {
      reject(
        rejected,
        n.title,
        `verify_cmd "${n.verify_cmd}" only asserts that the change was made, ` +
          'which the diff already shows — add the test or typecheck that proves it works',
      );
      continue;
    }
    if (isDefinitionOnly(n)) {
      reject(rejected, n.title, 'declaration-only task, fold it into the task that uses it');
      continue;
    }
    if (isUncheckedRemoval(n)) {
      reject(
        rejected,
        n.title,
        'a remove/move task must assert the OLD path is gone in its verify_cmd — ' +
          'naming the destination proves the new file works, not that the old one ' +
          `went away. Add a negative existence check, e.g. python -c "import os,sys; ` +
          `sys.exit(1 if os.path.exists('src/old.py') else 0)". Without it the gate ` +
          'cannot tell a move from a copy',
      );
      continue;
    }

    /*
     * A caller left out of the plan is a task that cannot be done honestly.
     *
     * Checked after the removal gate above and for the same reason: those two
     * are the whole of what makes a deletion different from an edit. This one
     * asks whether the plan named everything the deletion breaks; that one asks
     * whether the check can tell it happened.
     */
    const orphaned = touches.filter((f) => !declaredHere.has(f));
    if (orphaned.length) {
      const room = maxFiles * cfg.system.limits.scope_blowout_multiplier;
      reject(
        rejected,
        n.title,
        orphaned.length + n.files_hint.length > room
          ? `removing that leaves ${orphaned.length} file(s) still calling it ` +
              `(${orphaned.slice(0, 4).join(', ')}${orphaned.length > 4 ? ', ...' : ''}) — more ` +
              'than one commit can carry. Move the callers across first, in their own task, ' +
              'and delete it in a later one once nothing calls it'
          : `${orphaned.join(', ')} still reference(s) what this removes and ${
              orphaned.length > 1 ? 'are' : 'is'
            } not in files_hint. Add ${orphaned.length > 1 ? 'them' : 'it'}: the agent may only ` +
              'change files the plan declared, so a caller left out means it either leaves the ' +
              'build broken or edits a test it was not sent to edit, and the gate rejects the ' +
              'second as tampering',
      );
      continue;
    }
    const phantom = phantomRoot(n, roots);
    if (phantom) {
      reject(
        rejected,
        n.title,
        `every path is under "${phantom}", which this repo does not have — ` +
          'plan against the tree you were given, or name the new directory in verify_cmd',
      );
      continue;
    }
    if (n.kind === 'docs') {
      // Cap docs at 1 in 5 so the graph is not padded with README edits.
      if (docs >= Math.ceil(tasks.length / 5)) {
        reject(rejected, n.title, 'docs quota exceeded');
        continue;
      }
      docs++;
    }
    kept.push(n);
  }
  return kept;
}

/**
 * Drop proposals that restate work already done or queued.
 *
 * The prompt already tells the model not to do this, but a prompt is a request,
 * not a constraint — so it is enforced here too. Deterministic, and free.
 */
export function dedupe(
  tasks: NormalizedTask[],
  known: string[] | { title: string; paths: string[] }[],
  rejected: string[] = [],
): NormalizedTask[] {
  const kept: NormalizedTask[] = [];
  const seen: { title: string; paths: string[] }[] = known.map((k) =>
    typeof k === 'string' ? { title: k, paths: [] } : k,
  );

  for (const t of tasks) {
    const paths = t.files_hint ?? [];
    /*
     * A title clash is only a duplicate if the work touches the same files.
     *
     * Title similarity alone is too blunt for any job whose steps are
     * deliberately named alike. "Relocate logging module to app/core" and
     * "Relocate health module to app/core" share four of six words — 0.67,
     * over the 0.6 threshold — so the second was dropped as a duplicate of the
     * first, and a whole consolidation lost most of its steps to a check meant
     * to catch restated work.
     *
     * When either side lists no files there is nothing to compare, so the title
     * verdict stands: that is the old behaviour, and it is the safe direction.
     */
    const clash = seen.find((k) => {
      if (!findDuplicate(t.title, [k.title])) return false;
      if (paths.length === 0 || k.paths.length === 0) return true;
      return k.paths.some((p) => paths.includes(p));
    });

    if (clash) {
      reject(rejected, t.title, `duplicates existing "${clash.title}"`);
      continue;
    }
    kept.push(t);
    seen.push({ title: t.title, paths }); // also catches clashes within one batch
  }
  return kept;
}

/*
 * Trimmed first is trimmed cheapest. The journal and the resolution digest are
 * commentary; the API surface is the thing that tells the decomposer the work
 * already exists, and hiding it is what had the planner proposing a file move
 * that had happened weeks earlier. So the surface goes last.
 */
/*
 * Trimmed in this order, first to last, until the prompt fits.
 *
 * PATCH is last deliberately. It is the only section that IS the question
 * being asked: a review prompt missing its symbols still asks something
 * answerable, a review prompt missing its diff does not.
 */
const ELASTIC_ORDER = [
  'JOURNAL',
  /*
   * TREE moved above RESOLVED and COMPLETED on 2026-08-27, and the argument is
   * arithmetic rather than taste.
   *
   * `fitPrompt` below sets `keep = length - overage - 80`, so a section SMALLER
   * than the overage is emptied outright while a larger one is merely
   * shortened. COMPLETED runs 158-345 characters and TREE runs about 4,900.
   * Emptying COMPLETED therefore buys at most 345 characters and costs the
   * whole section; taking those same 345 out of TREE costs 7% of a file list,
   * which is the one section here that degrades gracefully - it is a list, and
   * a shorter list is still a list.
   *
   * Measured across the runs of 2026-08-26/27: COMPLETED was emptied to zero
   * nine times, RESOLVED fourteen (all of them the empty placeholder, so no
   * real loss), and TREE was never emptied once - only shortened, 4926 to 3157,
   * to 3288, to 3294. The order was spending the sections that cannot survive
   * partial loss in order to protect the only one that can.
   *
   * COMPLETED is also the section that tells the decomposer what has already
   * shipped, which is the same job the comment above credits the API surface
   * with - "hiding it is what had the planner proposing a file move that had
   * happened weeks earlier". It was being hidden first.
   */
  'TREE',
  'RESOLVED',
  'COMPLETED',
  'SYMBOLS',
  /*
   * Above SYMBOLS deliberately. The symbol index answers one question — does
   * this reinvent something — and on a repo of any size it is already being cut
   * in half to fit (58% on 2026-08-21). The junior's report answers whether the
   * change should be rejected at all, and it is three thousand characters
   * against sixteen thousand. Buying room out of the report first is how the
   * reviewer goes back to not being told why a brief step is missing.
   */
  'REPORT',
  /*
   * O23. BODIES is the source of the FILES THIS TASK WILL CHANGE, and it is
   * second-last to be cut for the same reason PATCH is last: it is the only
   * section in the brief prompt that shows what the code actually DOES.
   *
   * The finding it exists for is run 21, where a plan instructed a task to
   * remove an iterative fetch from a one-line function containing no loop, the
   * brief hardened that guess into its objective, and the junior — unable to
   * decline without losing the attempt — made the sentence true by hanging a
   * value nothing reads. Committed, reviewed "ship". Three prompts now forbid
   * the move and prompts were the whole of the guard, because every cheap
   * mechanical detector is a name scan and a name scan passes that exact
   * commit.
   *
   * Cutting this first would put the reader back where it started, holding a
   * list of names and asked what the things behind them do. SYMBOLS above it is
   * the name index for the WHOLE repo and answers a different, weaker question
   * — does this reinvent something — so it is the right thing to spend first.
   */
  'BODIES',
  'PATCH',
] as const;

/**
 * Fit a prompt to what the driver can actually deliver.
 *
 * Not a nicety: agy is spawned as a process and the prompt rides in argv, which
 * Windows caps at 32767 characters for the whole command line. At 32804 the
 * spawn failed with both streams empty and no exit code, which the loop read as
 * "the model returned nothing" and charged one of three attempts for. It hit
 * the first attempt of every model, because every repair prompt after it is
 * short enough to fit.
 *
 * Trimming is loud on purpose. A prompt quietly missing its API surface is the
 * defect this repo already fixed once; a warning naming what went and by how
 * much is the difference between noticing that and re-deriving it in August.
 */
export function fitPrompt<S extends Record<string, string>>(
  render: (sections: S) => string,
  sections: S,
  budget?: number,
  /*
   * What the assembled text costs the driver, when that is not simply its
   * length. Budgeting on `text.length` alone is what made 283542f trim a
   * decompose prompt to a "fitting" size that still could not be spawned:
   * every `"` in an argument becomes two characters on a Windows command line,
   * and this prompt is mostly JSON examples.
   */
  cost: (text: string) => number = (t) => t.length,
  /*
   * Which prompt this is, for the messages below. Three callers share this
   * now - decompose, the brief and the review - and a warning naming the
   * wrong one sends the reader to the wrong template.
   */
  label = 'decompose',
): string {
  let text = render(sections);
  let size = cost(text);
  if (!budget || size <= budget) return text;

  const trimmed: S = { ...sections };
  for (const name of ELASTIC_ORDER) {
    if (size <= budget) break;
    const current = trimmed[name];
    if (typeof current !== 'string' || current.length === 0) continue;
    // 80 covers truncate's own marker plus whatever framing the template wraps
    // the section in, so one pass per section is enough.
    const keep = Math.max(0, current.length - (size - budget) - 80);
    (trimmed as Record<string, string>)[name] = keep === 0 ? '' : truncate(current, keep);
    log.warn(
      `${label} prompt over budget by ${size - budget}: ` +
        `trimmed ${name} from ${current.length} to ${trimmed[name]!.length} chars`,
    );
    text = render(trimmed);
    size = cost(text);
  }

  if (size > budget) {
    // Nothing elastic left. Saying so beats handing the driver a command that
    // cannot be spawned and letting it come back as silence.
    throw new Error(
      `${label} prompt costs ${size} against a ${budget} budget (${text.length} chars) ` +
        `with every trimmable section already emptied; the fixed parts of the prompt do not fit.`,
    );
  }
  return text;
}

/** Decompose the next unplanned milestone into micro-tasks. */
export async function planNextMilestone(cfg: AppConfig, brain: BrainDriver): Promise<number> {
  const ms = ledger.nextUnplannedMilestone();
  if (!ms) {
    /*
     * Said to whoever is reading it. This is the same sentence quoted in
     * index.ts as the thing "Start working now" used to answer with — a file
     * path and an npm script, handed to the one person this interface exists to
     * keep away from both. Reading the inbox first fixed the cause; the
     * sentence was left, and a real run on 2026-08-15 printed it again on the
     * Working screen when the inbox was legitimately empty.
     */
    log.info('Nothing new to plan — everything described so far is already broken into jobs.');
    log.info('  Choose "Tell it what to build" if you want to add something.');
    return 0;
  }
  const repo = resolveRepo(cfg, ms.repo);
  const [minTasks, maxTasks] = cfg.system.backlog.tasks_per_milestone;

  const known = ledger.knownWork(repo.id);

  /*
   * Kept separate from the fill so they can be trimmed and re-rendered. These
   * are the elastic parts: everything else in the prompt is fixed cost.
   */
  const sections = {
    /*
     * Both caps used to bite. shanauto tracks 172 files over 4598 chars, so at
     * 150/4000 the decomposer saw neither the last 22 files nor the tail of the
     * ones it did see — which is why it planned "Create vitest.config.ts" for a
     * file that had existed for weeks. Set above both repos' current size
     * (example-api: 132 files, 3741 chars) with room to grow.
     */
    TREE: truncate(await fileTree(repo, 400), 12_000),
    SYMBOLS: await apiSurface(repo),
    /*
     * COMPLETED / RESOLVED / JOURNAL are model-authored (task titles come from
     * earlier brain calls, resolutions from LLM-written journal entries). They
     * are DATA for the decomposer, not instructions — a journal line that says
     * "ignore previous instructions" must not hijack the plan. Wrapped with
     * untrusted() (SEC-4) below so the prompt itself tells the model they are not.
     */
    COMPLETED: known.map((k) => `${k.title} (${k.paths.join(', ')})`).join('\n'),
    RESOLVED: resolutionDigest(ledger.recentResolutions(repo.id, 200)),
    // The ledger says what landed; the journal says how it went. The planner's
    // worst habit is re-proposing an approach that was already rejected, and
    // the rejection reason only exists here.
    JOURNAL: readRecent(2500),
  };

  const render = (s: typeof sections) =>
    fill(prompt('decompose'), {
      MIN_LINES: cfg.system.limits.min_insertions,
      MAX_FILES: cfg.system.limits.max_files_per_task,
      MIN_TASKS: minTasks,
      MAX_TASKS: maxTasks,
      REPO_ID: repo.id,
      REPO_PATH: repo.path,
      STACK: stackSummary(repo.path, repo.stack),
      DEFAULT_VERIFY: repo.verify_cmd,
      TREE: s.TREE,
      SYMBOLS: s.SYMBOLS,
      COMPLETED: untrusted('COMPLETED', s.COMPLETED),
      RESOLVED: untrusted('RESOLVED', s.RESOLVED),
      JOURNAL: untrusted('JOURNAL', s.JOURNAL),
      MILESTONE: `${ms.title}\n\n${ms.detail}`,
    });

  const text = fitPrompt(render, sections, brain.maxPromptChars, brain.promptCost?.bind(brain));

  // The tree the model was shown is truncated for the prompt; this is the whole
  // one, so a path is checked against the repo rather than against the excerpt.
  const roots = await trackedRoots(repo);
  /*
   * Read once, outside the repair loop. The loop can run four times and the
   * repo does not change while it does.
   */
  const symbols = repoSymbols(repo.path);

  /*
   * Validation runs INSIDE the brain loop, not after it.
   *
   * These guards are the only thing that can tell a usable proposal from a
   * well-formed worthless one, and running them after `ask` had returned meant
   * a milestone could be closed as unplannable on the first model's placeholder
   * output while the fallback model sat unused. Now each rejection goes back as
   * a repair prompt and, once a model's attempts are spent, on to the next
   * model - the same budget a malformed answer has always been given.
   *
   * The last attempt's verdict is the one that survives, which is what the
   * milestone's recorded reason should describe: the closest the brain got.
   */
  let rejected: string[] = [];
  let valid: NormalizedTask[] = [];
  let proposed = 0;
  let judged = false;
  let nothingToDo = '';

  const accept = (draft: { tasks: PlannedTask[]; nothing_to_do?: string }): string | null => {
    judged = true;
    proposed = draft.tasks.length;
    rejected = [];
    /*
     * The sanctioned "already built" verdict. The schema only lets an empty
     * array through with a reason attached, so this is a complete answer, not a
     * failure to answer: there is nothing to repair and no cause to spend the
     * fallback model re-asking a question that has been answered.
     */
    if (proposed === 0) {
      nothingToDo = (draft.nothing_to_do ?? '').trim();
      valid = [];
      return null;
    }
    valid = capDependencyDepth(
      dedupe(validateTasks(cfg, draft.tasks, rejected, roots, repo, symbols), known, rejected),
    );
    if (valid.length > 0) return null;
    return `none of the ${proposed} task(s) can be used:\n${truncate(rejected.join('\n'), 800)}`;
  };

  try {
    await brain.ask(text, DecomposeSchema, 'decompose', accept);
    /*
     * Outside `accept`, deliberately. That callback is synchronous and this
     * asks a model; putting it inside would mean a brain call per repair
     * attempt rather than one on the answer that was actually taken.
     */
    if (valid.length) {
      valid = await dropTasksPlanningAgainstNothing(brain, repo, ms, valid, rejected);
    }
  } catch (e) {
    /*
     * Only a verdict if the gate actually saw something. A quota error, a
     * timeout or a denied tool call is not the planner concluding anything
     * about this milestone and must not be recorded as one - that exact
     * conflation closed "Relocate health module" as satisfied once already.
     */
    if (!judged) throw e;
    log.warn(`brain[decompose] exhausted every model without a usable proposal: ${(e as Error).message}`);
  }

  if (valid.length === 0) {
    if (nothingToDo) {
      /*
       * Not `failed` - nothing failed - and not `satisfied`, which is terminal
       * and would let a model close real work on its own say-so. This is a
       * claim to be checked, so it lands where the operator will see it:
       * `stuckMilestones` selects by NOT live, so `sa status` picks this status
       * up without being taught the name, and prints the reasoning under a
       * heading that says what it is rather than calling it a failure.
       *
       * Requeueing is per id, not the blanket `sa retry --failed` - see
       * REQUEUEABLE_MILESTONE. Re-asking costs a model call and would arrive at
       * the same answer; disagreeing with it should mean someone read it.
       */
      const why = `the brain found no work left: ${truncate(nothingToDo, 800)}`;
      ledger.setMilestoneStatus(ms.id, ledger.ALREADY_BUILT_STATUS, why);
      log.warn(
        `Milestone "${ms.title}": ${why}\n` +
          `Nothing was planned because the brain says it is already built. ` +
          `Confirm that and the milestone is done; disagree and requeue it with: npm run sa -- retry ${ms.id}`,
      );
      return 0;
    }
    /*
     * "Everything I proposed was rejected" and "there is nothing left to do here"
     * are opposite conclusions, and until 2026-08-08 they shared one status.
     * `satisfied` is terminal — nextUnplannedMilestone never looks at such a
     * milestone again — so "Relocate health module" was closed as complete after
     * the duplicate check wrongly ate its only proposal, and the work had to be
     * found and re-entered by hand.
     *
     * `rejected` keeps the planner from re-asking the brain the same question on
     * every pass, but is not a claim the work is done: `sa status` lists these
     * with their reasons and `sa retry --failed` puts them back in the queue,
     * the same recovery path a failed task has.
     */
    const why = `all ${proposed} proposal(s) rejected\n${truncate(rejected.join('\n'), 1200)}`;
    ledger.setMilestoneStatus(ms.id, 'rejected', why);
    log.warn(
      `Milestone "${ms.title}": ${why}\n` +
        `Nothing was planned and the milestone is NOT done. Requeue it with: npm run sa -- retry --failed`,
    );
    return 0;
  }
  // The HEAD a task was planned against is the baseline the staleness check
  // measures "since" from. Captured here because it is meaningless later.
  const planHead = await headSha(repo);
  const ids = ledger.insertTasks(ms.id, repo.id, valid);
  ids.forEach((id, i) => {
    const c = valid[i]?.claim;
    if (c && (c.paths.length || c.symbols.length)) ledger.saveClaim(id, planHead, c.paths, c.symbols);
  });

  ledger.setMilestoneStatus(ms.id, 'planned');
  log.info(`Planned "${ms.title}" -> ${valid.length} task(s) (${proposed - valid.length} rejected)`);
  /*
   * No floor check here, deliberately.
   *
   * There was one until 2026-08-21: it warned whenever a milestone produced
   * fewer tasks than `backlog.tasks_per_milestone[0]`. It fired on ten
   * consecutive milestones — every milestone that had produced tasks since it
   * was added — because a floor of three was left behind by the 2026-08-07
   * change that made a task a complete change rather than a fragment. A warning
   * that has never once been silent is not telling the operator anything, and
   * this one told a non-technical operator that the planner was misbehaving
   * while it was doing exactly what it was designed to do.
   *
   * The two outcomes actually worth interrupting for are both handled above,
   * with real statuses rather than a log line: a milestone the brain says is
   * already built lands on ALREADY_BUILT_STATUS, and one whose every proposal
   * was rejected is kept live instead of being closed as satisfied. Between
   * those and "Planned X -> N task(s)", a short milestone is already visible.
   * What it is not any more is alarming.
   *
   * The backlog-growth worry the old warning carried is real but belongs to the
   * pass, not to one milestone: `plan` closes with the backlog delta and the
   * runway, and `run` refuses to start on a runway it considers too short.
   * MIN_TASKS is still sent to the model as the bottom of a range; it is
   * guidance for sizing, and decompose.md's "NEVER pad" outranks it.
   */
  return valid.length;
}

/**
 * How many milestones one planning pass will decompose.
 *
 * A bound on brain calls, not on ambition: each one is a slow round-trip
 * against a metered model, and an unbounded loop here would spend the day's
 * quota topping up a backlog nobody asked for.
 */
const MILESTONES_PER_PASS = 6;

/** Top up the backlog until it clears `min_ready`, or we run out of milestones. */
export async function refillBacklog(cfg: AppConfig, brain: BrainDriver): Promise<number> {
  let added = 0;
  let planned = 0;
  /*
   * Say which of the four ways this stopped: a full backlog, an empty queue, a
   * milestone that will not decompose, or the per-pass cap.
   *
   * They all used to be a bare `break`, so the pass ended in silence and the
   * only trace was the task count. On 2026-08-20 an idea produced seven
   * milestones, the cap decomposed six, and the seventh sat `unplanned` with
   * nothing on screen, in the log or in the journal to say it existed — the
   * operator saw "Backlog: +6 task(s)" and had no way to tell a full backlog
   * from a truncated pass. parseInbox already learned this lesson one layer up
   * ("Say why an idea was dropped"); this is the same fix for the layer below.
   */
  for (; planned < MILESTONES_PER_PASS; planned++) {
    const ready = ledger.readyTasks().length + (ledger.countByStatus().pending ?? 0);
    if (ready >= cfg.system.backlog.min_ready) {
      log.info(`Backlog is full (${ready} ready, min ${cfg.system.backlog.min_ready}); stopping.`);
      return added;
    }
    const target = ledger.nextUnplannedMilestone();
    const n = await planNextMilestone(cfg, brain);
    if (n === 0) {
      /*
       * A milestone that queued nothing is not the end of the queue.
       *
       * This used to `return`. On 2026-08-20 an idea shaped into five
       * milestones: three planned, the fourth had every proposal rejected, and
       * the pass stopped there. The fifth was never attempted and never
       * mentioned — not in the log, not in `status` — while the operator read
       * "Backlog: +3 task(s)" as a finished job.
       *
       * planNextMilestone has already written a status on the one it gave up on
       * (`rejected`, or `nothing-to-do`), so the head of the queue has moved and
       * carrying on reaches new work rather than retrying the same milestone.
       */
      const next = ledger.nextUnplannedMilestone();
      // Genuinely nothing left. planNextMilestone said so; do not talk over it.
      if (!next) return added;
      if (target && next.id === target.id) {
        /*
         * The head did NOT move, so another attempt would decompose the same
         * milestone again and spend the same model calls doing it. Stop and say
         * which one, rather than spending the cap on a loop.
         */
        log.warn(
          `"${next.title}" is still unplanned after a pass that queued nothing for it. ` +
            `Stopping rather than retrying it in a loop — run \`npm run plan\` again, or ` +
            `reword the milestone if it keeps refusing to decompose.`,
        );
        return added;
      }
      continue;
    }
    added += n;
  }

  // `unplanned` is a LIVE status, so stuckMilestones() deliberately excludes it;
  // asking for the next one is the honest way to tell whether any are left.
  const more = ledger.nextUnplannedMilestone();
  log.warn(
    `Attempted ${planned} milestone(s) this pass — the per-pass cap. ` +
      (more
        ? `At least one is still unplanned ("${more.title}"). Run \`npm run plan\` again to continue.`
        : `Nothing is left unplanned.`),
  );
  return added;
}

/**
 * How much runway is left, in days at the current target.
 *
 * Counts only tasks that can actually still run. Including deadlocked chains made
 * this report 3 days when 1 day of work was reachable, which in turn stopped the
 * planner topping up a backlog that was really almost empty.
 *
 * Reported to a tenth of a day rather than floored. Flooring made any backlog
 * below one day's target read "~0 day(s)": on the night of 2026-08-08 it said 0
 * for hours with 16 tasks queued and running, so the number was read as noise
 * and stopped being read at all. Zero now means one thing only — there is no
 * reachable work left.
 */
export function runwayDays(cfg: AppConfig): number {
  const reachable = ledger.reachableBacklog();
  if (reachable <= 0) return 0;
  const days = reachable / Math.max(1, cfg.system.daily_target);
  // A tenth of a day is the floor on what gets reported, so that "some work
  // left" can never render as the empty answer.
  return Math.max(0.1, Math.round(days * 10) / 10);
}
