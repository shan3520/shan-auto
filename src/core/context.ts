import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import type { Repo } from '../schemas.js';
import type { Resolution } from '../ledger.js';
import { log } from '../logger.js';

/**
 * Compact "what already exists" summary for planner prompts.
 *
 * The planner used to receive only a list of filenames, so it happily proposed
 * work that was already done ("add a sleep utility" when `sleep` was already
 * exported from util.ts). Filenames are not enough — it needs the API surface.
 *
 * Full file contents would be ideal but blow the token budget on any real repo,
 * so this extracts just the declarations: cheap, deterministic, no model call,
 * and high signal for "does this thing exist yet".
 */

const PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
    /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm,
    /^\s*export\s+(?:interface|type|enum)\s+(\w+)/gm,
  ],
  /*
   * Ordered by what a reader of the surface is trying to find out, because the
   * budget is spent front-to-back and `+N more` cuts from the end.
   *
   * Measured 2026-08-21 against example-api: `app/api/stats.py` reached the
   * planner as `api_popular_searches, api_popular_documents,
   * get_collection_stats, +16 more`. Every route path and every response model
   * was inside the `+16`. The senior then wrote a brief saying "add it to the
   * existing response model (e.g. `SearchAnalyticsResponse` or similar)" — a
   * guess, because the real names were all in the part it could not see — and
   * the intern, given a guess, created a second model. The senior rejected its
   * own brief's consequence one step later.
   *
   * So: routes, then the models, then the handlers. The path is what two tasks
   * contend over; the model is what a change has to fit into; the handler name
   * is the one thing a reader can already infer from the other two.
   */
  py: [
    /*
     * The route a handler answers on, not just the name of the handler.
     *
     * Measured 2026-08-21, driving the system from zero. The surface listed
     * `api_unsearched_documents` as a bare name, so nothing downstream could
     * tell that `/api/stats/unsearched-documents` already existed. The planner
     * then split one idea into two milestones that each built the same
     * endpoint, and the reviewer — reading a diff whose siblings were all
     * unchanged, and a surface with no paths in it — had nothing to compare
     * against. example-api ended the run with three routes answering one
     * question, every gate green and every verdict "ship".
     *
     * A handler's name is chosen by whoever writes it and collides by
     * accident; the path is the thing two tasks actually contend over. It is
     * also the part a planner needs to see to know the work is already done.
     *
     * Kept to the HTTP-method decorators on purpose. Every decorator would
     * pull in validators, fixtures and caching wrappers, which cost surface
     * budget and answer no question anyone is asking here.
     */
    /^\s*@\w+\.(?:get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/gm,
    /^\s*class\s+(\w+)/gm,
    /^\s*def\s+(\w+)/gm,
  ],
  /*
   * What a TypeScript test file declares.
   *
   * The declaration patterns above find nothing in one — a test file exports
   * nothing — so `names.size === 0` and the file was skipped entirely. Python
   * never had the problem, because `def test_thing` is matched by its ordinary
   * `def` rule. That asymmetry is visible in the ledger: of 34 tasks dropped as
   * already-done, 12 were `kind: test` and 27 were in the TypeScript repo. The
   * planner proposed "Add unit tests for calculateBackoff" against a
   * src/util.test.ts it could see the NAME of but not the contents of.
   *
   * Titles rather than identifiers, because that is what a test declares. They
   * are prose and cost more per entry, so testTitles() caps them tighter than
   * the 40 identifiers allowed elsewhere.
   */
  // The optional `(...)` before the title is for `it.each([...])('...')`, which
  // is a call that returns the function that takes the title.
  tsTest: [/^\s*(?:describe|it|test)(?:\.\w+)*(?:\([^()]*\))?\s*\(\s*['"`]([^'"`\r\n]{3,70})/gm],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/gm, /^\s*type\s+(\w+)/gm],
  rs: [/^\s*pub\s+(?:async\s+)?fn\s+(\w+)/gm, /^\s*pub\s+(?:struct|enum|trait)\s+(\w+)/gm],
  java: [/^\s*(?:public|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/gm],
};

const EXT_LANG: Record<string, keyof typeof PATTERNS> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.js': 'ts',
  '.jsx': 'ts',
  '.mjs': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
};

const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.venv|__pycache__|target)\//;

/** A TypeScript test file declares titles, not exports. Extensions only — a `.ts` under `__tests__/` still counts. */
const IS_TS_TEST = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|test|tests)\//;

const PY_ROUTER = /APIRouter\s*\(([^)]*)\)/g;
const PY_PREFIX = /\bprefix\s*=\s*['"]([^'"]*)['"]/;

/**
 * The path prefix every route in this file is mounted under, or '' if the file
 * does not say so unambiguously.
 *
 * A decorator carries only the tail. `app/api/unanswered_queries.py` builds its
 * router as `APIRouter(prefix="/api/unanswered-queries")` and then declares
 * `@router.get("/recent")`, so reading the decorators alone advertises
 * `/recent`, `/frequent`, `/clustered` — four paths that do not exist. That is
 * worse than listing nothing: a missing path leaves a planner uncertain, and a
 * wrong one leaves it confident.
 *
 * Only when the file constructs exactly one router, so there is exactly one
 * answer. Two routers means no way to tell which decorator belongs to which,
 * and the fragment is the honest thing to print. A router built with no prefix
 * counts as an answer too — it is the common case, and it is '' — so a file
 * mixing a prefixed and an unprefixed router falls back rather than guessing.
 */
function routerPrefix(src: string): string {
  const found = new Set<string>();
  for (const m of src.matchAll(PY_ROUTER)) found.add(PY_PREFIX.exec(m[1]!)?.[1] ?? '');
  return found.size === 1 ? [...found][0]!.replace(/\/$/, '') : '';
}

/**
 * What one file contributes to the surface: its declarations, or — for a
 * TypeScript test — the titles it declares.
 *
 * Returns an empty array for a file that declares nothing recognisable. The
 * caller still lists it: see apiSurface.
 */
function declarationsIn(rel: string, src: string, lang: keyof typeof PATTERNS): string[] {
  const testFile = lang === 'ts' && IS_TS_TEST.test(rel);
  // Routes are the only names that start with '/', so this touches nothing else.
  const prefix = lang === 'py' ? routerPrefix(src) : '';
  const mount = (n: string) => (prefix && n.startsWith('/') ? `${prefix}${n === '/' ? '' : n}` : n);

  const names = new Set<string>();
  for (const re of PATTERNS[lang]!) {
    for (const m of src.matchAll(re)) if (m[1]) names.add(mount(m[1]));
  }
  if (!testFile) return [...names].slice(0, 40);

  const titles = new Set<string>();
  for (const re of PATTERNS.tsTest!) {
    for (const m of src.matchAll(re)) if (m[1]) titles.add(m[1].trim());
  }
  // Titles are prose and run long, so fewer of them; any exported test helper
  // is still worth naming, and comes second because the titles say more.
  return [...[...titles].slice(0, 12), ...[...names].slice(0, 8)];
}

/**
 * As many of `names` as fit in `budget` chars, with an honest count of the rest.
 * Never exceeds the budget: the `+N more` tail is paid for by dropping names.
 */
function fit(names: string[], budget: number): string {
  const all = names.join(', ');
  if (all.length <= budget) return all;

  const kept: string[] = [];
  let used = 0;
  for (const n of names) {
    const cost = kept.length ? n.length + 2 : n.length;
    // 12 chars held back for the tail, whose width `+N more` never reaches at
    // any plausible file count.
    if (used + cost > budget - 12) break;
    kept.push(n);
    used += cost;
  }
  const rest = names.length - kept.length;
  return kept.length ? `${kept.join(', ')}, +${rest} more` : '';
}

/**
 * @param maxChars Budget for the whole summary. 6000 was too small to be
 * honest: example-api's surface came to 6084 and the old code responded by
 * dropping the last 45 files outright, which hid tests/repository/* entirely
 * and had the planner propose tests that were already written. Detail is now
 * rationed instead, so this trades description against prompt size, never
 * against knowing a file is there.
 *
 * 16000 is measured, not guessed. Listing every file costs more than listing
 * 47 of them: shanauto's full surface is 34.7k chars and example-api's 9.7k, most
 * of the difference being test titles. Sweeping the budget across both repos,
 * 16000 is where source files stop being rationed in practice — 58 of 60
 * complete for shanauto, 62 of 65 for example-api — while test entries still give
 * a few titles and an honest count of the rest. Actual cost is 13.2k and 9.6k;
 * the cap is a ceiling, not a target.
 *
 * @param focus Paths the prompt is actually about, when the caller knows.
 * Ordering only - nothing is added or removed by it. See the ranking below.
 */
export async function apiSurface(
  repo: Repo,
  maxChars = 16_000,
  focus: string[] = [],
): Promise<string> {
  let files: string[];
  try {
    const out = await simpleGit({ baseDir: repo.path }).raw(['ls-files']);
    files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return '(not a git repo yet)';
  }

  const entries: { rel: string; names: string[] }[] = [];
  for (const rel of files) {
    if (SKIP.test(rel)) continue;
    const lang = EXT_LANG[extname(rel).toLowerCase()];
    if (!lang) continue;

    let src: string;
    try {
      src = readFileSync(join(repo.path, rel), 'utf8');
    } catch {
      continue;
    }
    if (src.length > 400_000) continue; // generated/bundled

    /*
     * A recognised source file with nothing to extract still gets an entry, by
     * path alone. Skipping those is what made every TypeScript test file
     * invisible — the export patterns match nothing in one — and that is the
     * largest single source of already-done proposals in the ledger.
     */
    entries.push({ rel, names: declarationsIn(rel, src, lang) });
  }

  /*
   * Relevance ordering, when the caller says what the prompt is about.
   *
   * Every cut below falls on the END of this list. The path budget pops from
   * the back, and fitPrompt trims the rendered section from its tail. `git
   * ls-files` is alphabetical, so with no ordering the survivor is simply
   * whatever sorts first, and on 2026-08-21 that meant a reviewer judging a
   * change to app/api/*.py was handed 8446 of 15897 chars of index with
   * tests/* cut off the end - the half that would have told it whether the
   * change was already covered.
   *
   * Ranking the files the change touched first, then their directory
   * neighbours, then everything else, makes those cuts land on the files the
   * reader has no question about. Nothing is dropped that would not have been
   * dropped anyway; only the choice of which changes. The sort is stable, so
   * alphabetical order still holds inside each rank.
   */
  if (focus.length) {
    const touched = new Set(focus);
    const nearby = new Set([...touched].map((f) => dirname(f)));
    const rank = (rel: string): number => (touched.has(rel) ? 0 : nearby.has(dirname(rel)) ? 1 : 2);
    entries.sort((a, b) => rank(a.rel) - rank(b.rel));
  }

  /*
   * Paths first, detail second, and they are budgeted separately.
   *
   * The old code walked the list spending freely until it ran out, then stopped
   * dead. Because `git ls-files` is alphabetical that spent the whole budget on
   * whatever sorted first — for this repo, src/__tests__/ — and the files after
   * it did not exist as far as the planner was concerned. So: reserve every
   * path up front, and ration what is left.
   */
  let dropped = 0;
  let pathCost = entries.reduce((n, e) => n + e.rel.length + 1, 0);
  // The "N files omitted" line has to be paid for out of the same budget, or a
  // summary that admits to dropping files is bigger than one that hides it.
  const NOTE = 48;
  while (entries.length && pathCost + (dropped ? NOTE : 0) > maxChars) {
    // From the end, so what survives is a stable prefix rather than whichever
    // files happened to be cheap.
    pathCost -= entries.pop()!.rel.length + 1;
    dropped++;
  }

  // Whatever the note will cost is not available to spend on detail either.
  const reserved = pathCost + (dropped ? NOTE : 0);

  /*
   * Detail is rationed by demand, not by position.
   *
   * The equal-share loop this replaces passed its surplus FORWARD only: a file
   * that wanted less than its share handed the remainder to the files after it,
   * and a file that wanted more was cut to its share whatever the files after
   * it went on to leave unspent. `git ls-files` is alphabetical, so app/api/*
   * was always in front of the surplus and could never receive it.
   *
   * Measured 2026-08-21: example-api's complete surface is 14,949 chars against a
   * 16,000 cap — it FITS — and the old loop emitted 12,261 of it, truncating 21
   * files while leaving 3,739 chars of budget unspent. `app/api/stats.py` lost
   * every route path and every response model to a `+16 more` that the budget
   * would have paid for twice over.
   *
   * This is the standard water-fill: hand out an equal share, let anyone who
   * needs less take only what they need, and divide what they release among
   * those still short — repeatedly, cheapest demand first. Two properties
   * follow, and both are what the old loop lacked. If the whole surface fits,
   * every file is complete. If it does not, the cut falls on the files asking
   * for the most, wherever they sort.
   */
  const demands = entries
    .filter((e) => e.names.length > 0)
    // The ": " is part of what an entry costs, so it is part of what it asks for.
    .map((e) => e.names.join(', ').length + 2)
    .sort((a, b) => a - b);

  let cap = Infinity;
  let left = maxChars - reserved;
  for (const [i, want] of demands.entries()) {
    const share = Math.floor(left / (demands.length - i));
    // The first demand that outgrows an equal share is the water line: it and
    // every larger demand behind it get exactly this much.
    if (want > share) {
      cap = share;
      break;
    }
    left -= want;
  }

  let spent = 0;
  const lines = entries.map((e) => {
    if (e.names.length === 0) return e.rel;
    const detail = fit(e.names, cap - 2);
    if (!detail) return e.rel;
    spent += detail.length + 2; // the ": " as well
    return `${e.rel}: ${detail}`;
  });

  // Counted, not inferred: the old note said `files.length - lines.length`,
  // which included every non-source file in the repo and so overstated it.
  if (dropped) lines.push(`...(${dropped} more file(s) omitted; budget exhausted)`);
  const used = pathCost + spent;

  if (lines.length === 0) return '(no recognised source files yet)';
  log.debug(
    `api surface: ${lines.length} file(s), ${used} chars` +
      (dropped ? ` (${dropped} omitted)` : ''),
  );
  return lines.join('\n');
}

/**
 * Compact account of what has recently been resolved, for the planner prompt.
 *
 * The API surface says what exists; this says what *happened*, including work
 * that landed by hand while a task for it sat queued. Deduped by claim_key so a
 * piece of work described three different ways occupies one line.
 *
 * Capped hard: this is prepended to a prompt on roughly seven calls a day, and
 * an uncapped digest would grow without bound as the ledger fills.
 */
export function resolutionDigest(resolutions: Resolution[], maxChars = 2000): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let used = 0;

  for (const r of resolutions) {
    // recentResolutions returns newest first, so the first sighting wins.
    const key = r.claim_key ?? `${r.kind}:${r.commit_sha ?? r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const what = [...(r.symbols ?? []), ...(r.paths ?? [])].slice(0, 4).join(', ');
    if (!what) continue;

    const why = r.reason ? ` — ${r.reason.split('\n')[0]!.slice(0, 60)}` : '';
    const entry = `- ${what}${why}`;

    if (used + entry.length + 1 > maxChars) {
      lines.push('- ...(older resolutions omitted)');
      break;
    }
    lines.push(entry);
    used += entry.length + 1;
  }

  return lines.length ? lines.join('\n') : '(nothing resolved yet)';
}

/* ------------------------------------------------------------------ dedupe */

const STOPWORDS = new Set([
  'add','create','implement','update','write','make','set','setup','new','a','an','the',
  'to','for','of','in','on','and','with','support','function','helper','util','utility',
]);

function normalise(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Drop proposals that restate work already in the ledger. Deterministic and
 * free — no second model call to decide whether two tasks are the same.
 */
export function findDuplicate(title: string, existing: string[], threshold = 0.6): string | null {
  const a = normalise(title);
  if (a.size === 0) return null;
  for (const other of existing) {
    if (jaccard(a, normalise(other)) >= threshold) return other;
  }
  return null;
}

/* ---------- what a deletion would break ---------- */

/**
 * Where a repo's identifiers are declared, and which files name them.
 *
 * One question this answers that nothing else could: if a task deletes
 * `search_documents`, which files stop working? On 2026-08-23 a task was
 * planned to delete exactly that, its plan named four files, and a fifth
 * imported the symbol. The intern had to either leave the build broken or edit
 * a test it had not been sent to edit; it chose the second and the gate threw
 * the whole task away as tampering. Neither half of that was wrong. The plan
 * was.
 */
export interface RepoSymbols {
  /** Files whose source declares this identifier. */
  declaredIn(symbol: string): string[];
  /** Files that name it anywhere, the declaration included. */
  usedIn(symbol: string): string[];
}

const IDENT = /^[A-Za-z_]\w*$/;

/** Directories with no source of this project's own in them. */
const PRUNE = new Set(['node_modules', 'dist', 'build', 'vendor', '__pycache__', 'target', 'venv']);

/**
 * Source paths under `root`, or null if there are more than the index will hold.
 *
 * Walks and prunes rather than reading the tree whole: `readdirSync` with
 * `recursive` descends into `node_modules` before anything can filter it out,
 * and this runs inside the planner's repair loop where a stall is paid for on
 * every attempt.
 */
function sourceFiles(root: string, maxFiles: number): string[] | null {
  const out: string[] = [];
  const walk = (rel: string): boolean => {
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      // One unreadable directory is not a reason to abandon the whole index.
      return true;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || PRUNE.has(e.name)) continue;
        if (!walk(child)) return false;
      } else if (e.isFile() && EXT_LANG[extname(e.name).toLowerCase()]) {
        if (out.length >= maxFiles) return false;
        out.push(child);
      }
    }
    return true;
  };
  return walk('') ? out : null;
}

/**
 * Index the source of `repoPath`, or null when it cannot be indexed in full.
 *
 * Null rather than a partial answer, deliberately. Every caller uses this to
 * ask "what else references this", and a half-read repo answers that with a
 * silence indistinguishable from "nothing does". A check that cannot be made is
 * not a reason to reject work — but it must not become a reason to accept it.
 */
export function repoSymbols(
  repoPath: string,
  /*
   * What the index will read before it gives up. A repo past either bound is
   * one this check has no useful opinion about, and spending a minute of every
   * planning round to find that out is worse than not asking.
   */
  maxFiles = 4000,
  maxBytes = 12_000_000,
): RepoSymbols | null {
  const files = sourceFiles(repoPath, maxFiles);
  if (!files) return null;

  const sources: { rel: string; src: string }[] = [];
  const declared = new Map<string, string[]>();
  let held = 0;

  for (const rel of files) {
    const lang = EXT_LANG[extname(rel).toLowerCase()]!;
    let src: string;
    try {
      src = readFileSync(join(repoPath, rel), 'utf8');
    } catch {
      continue;
    }
    held += src.length;
    if (held > maxBytes) return null;
    sources.push({ rel, src });

    for (const re of PATTERNS[lang]!) {
      for (const m of src.matchAll(re)) {
        const name = m[1];
        if (!name) continue;
        const at = declared.get(name);
        if (at) at.push(rel);
        else declared.set(name, [rel]);
      }
    }
  }

  return {
    declaredIn: (symbol) => declared.get(symbol) ?? [],
    usedIn: (symbol) => {
      if (!IDENT.test(symbol)) return [];
      /*
       * `\b` on both sides, which is what keeps `search_documents` from
       * matching `search_documents_paginated`: an underscore is a word
       * character, so there is no boundary between the two.
       */
      const re = new RegExp(`\\b${symbol}\\b`);
      return sources.filter((f) => re.test(f.src)).map((f) => f.rel);
    },
  };
}

/**
 * The current contents of the files a task is planned to change.
 *
 * Bounded twice over: only the planner's own file list, and a per-file cap, so
 * one large file cannot crowd out the rest. Missing and unreadable files are
 * SAID rather than skipped — "this file does not exist yet" is exactly the fact
 * a brief author needs to know before it writes `action: "modify"`, and an
 * absence reads as "not shown to you" as easily as "not there".
 */
export async function hintedBodies(
  repo: Repo,
  hints: string[],
  /**
   * How much of each file to show.
   *
   * Was a flat 2,500, and that number produced a false verdict on 2026-08-31:
   * `cli.py` was 7,393 characters, `report_expenses` sat at line 125, and the
   * acceptance check was shown the first third of the file before reporting the
   * report command's budget handling as absent. It was present, and it worked
   * when the command was run by hand. Two finished milestones were reopened.
   *
   * A cap that hides the end of a file is worse than no evidence at all: a
   * reader given two thirds of something does not know which third it is
   * missing. 8,000 covers an ordinary source file whole. Callers that cannot
   * afford that pass their own — the ones inside `fitPrompt`, where BODIES is
   * an elastic section trimmed on purpose rather than by accident.
   */
  perFile = 8000,
): Promise<string> {
  const PER_FILE = perFile;
  const out: string[] = [];
  for (const rel of hints.slice(0, 6)) {
    const full = join(repo.path, rel);
    if (!existsSync(full)) {
      out.push(`--- ${rel}\n(does not exist yet — this task would create it)`);
      continue;
    }
    try {
      const body = readFileSync(full, 'utf8');
      /*
       * Said loudly when it happens, and said as the rule that follows from it.
       * "… (truncated)" is a footnote, and a footnote is what the acceptance
       * check read past on 2026-08-31 before reporting a feature absent from
       * the two thirds of a file it had not been shown. What a reader needs is
       * not that the text was cut but that it cannot conclude absence from it.
       */
      out.push(
        `--- ${rel}\n` +
          (body.length > PER_FILE
            ? `${body.slice(0, PER_FILE)}\n` +
              `>>> CUT OFF HERE. ${body.length - PER_FILE} more characters of ${rel} ` +
              `were not shown to you. Nothing can be concluded to be ABSENT from ` +
              `this file on the strength of what you can see.`
            : body),
      );
    } catch {
      out.push(`--- ${rel}\n(exists but could not be read)`);
    }
  }
  return out.join('\n\n');
}
