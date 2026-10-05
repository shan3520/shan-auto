import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { Repo } from '../schemas.js';
import { log } from '../logger.js';
import { escapeRegExp } from '../util.js';

/**
 * Rejects commits that add an export nothing calls.
 *
 * Measured on 2026-08-06: of 32 agent-authored commits, roughly two thirds added
 * working, tested code that no production code path ever invoked -
 * `generateSparklineSvg`, `writeWeeklyReport`, `exportLedgerToCsv`,
 * `getRecentVelocity` and others. The gate could not see it, because dead code
 * compiles and its unit tests pass.
 *
 * This closes that hole: a new export must be referenced from at least one
 * non-test file, or the task is rolled back.
 */

export interface DeadExport {
  file: string;
  symbol: string;
}

/** `export function foo`, `export const foo`, `export interface Foo`, ... */
const EXPORT_PATTERNS = [
  /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm,
  /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
  /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm,
  /^\s*export\s+(?:interface|type|enum)\s+(\w+)/gm,
];

/**
 * Exported symbol names in a source string, skipping any marked @public.
 *
 * Deliberately reads whole-file state rather than diff hunks. Diffing added lines
 * looked simpler but was wrong twice: a brand-new file is untracked so it has no
 * diff against HEAD at all, and merely editing the line of an existing export
 * shows up as an addition.
 */
export function exportedSymbols(src: string): Set<string> {
  const lines = src.split('\n');
  const optedOut = new Set<number>();
  lines.forEach((line, i) => {
    if (OPT_OUT.test(line)) {
      optedOut.add(i);
      optedOut.add(i + 1);
    }
  });

  const found = new Set<string>();
  lines.forEach((line, i) => {
    if (optedOut.has(i)) return;
    for (const re of EXPORT_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m?.[1]) found.add(m[1]);
    }
  });
  return found;
}

/**
 * Module-level `def foo` / `class Foo`, which is Python's version of an export.
 *
 * Anchored at column 0 on purpose: anything indented is a method or a nested
 * function, reached through the class or closure that holds it, and asking who
 * references it by name is the wrong question.
 */
const PY_PATTERNS = [/^(?:async\s+)?def\s+(\w+)/, /^class\s+(\w+)/];

/**
 * Public names a Python module defines.
 *
 * Two things are skipped, and both are false positives waiting to happen:
 *
 * A decorated definition is registered by the decorator, not called by name.
 * `@router.get("/clustered")` over `def get_clustered_queries` is the entire
 * FastAPI idiom, and example-api is a FastAPI project — flagging those would
 * reject every new endpoint the system ever writes, which is most of its work.
 *
 * A leading underscore says "not part of this module's surface". A `_helper`
 * used only by its own module is correct design, and demanding an outside
 * caller for it would be demanding worse code.
 */
export function pythonSymbols(src: string): Set<string> {
  const lines = src.split('\n');
  const found = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Walk back over a decorator stack and any blank lines inside it.
    let prev = i - 1;
    while (prev >= 0 && (lines[prev] ?? '').trim() === '') prev--;
    const decorated = prev >= 0 && (lines[prev] ?? '').trimStart().startsWith('@');
    if (decorated) continue;
    if (prev >= 0 && OPT_OUT.test(lines[prev] ?? '')) continue;

    for (const re of PY_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1] && !m[1].startsWith('_')) found.add(m[1]);
    }
  }
  return found;
}

/** Whichever notion of "public" this file's language has. */
export const publicSymbols = (src: string, file: string): Set<string> =>
  file.endsWith('.py') ? pythonSymbols(src) : exportedSymbols(src);

/**
 * Files whose exports are entry points: something outside the codebase calls
 * them, so "nothing references this" is expected and fine.
 */
const ENTRYPOINTS = [
  /(^|\/)src\/index\.ts$/,
  /(^|\/)scripts\//,
  /(^|\/)vitest\.config\.ts$/,
  // Python: run by the server, the migration tool or pytest, never imported.
  /(^|\/)main\.py$/,
  /(^|\/)manage\.py$/,
  /(^|\/)conftest\.py$/,
  /(^|\/)__init__\.py$/,
  /(^|\/)(alembic|migrations)\//,
];

const isTest = (f: string) => {
  const s = f.replace(/\\/g, '/');
  if (/\.test\.ts$|(^|\/)__tests__\//.test(s)) return true;
  // Kept behind the extension check so a TypeScript repo with a test/ directory
  // keeps whatever behaviour it had before Python was added here.
  return s.endsWith('.py') && /(^|\/)tests?\/|(^|\/)test_\w+\.py$|_test\.py$/.test(s);
};
const isEntrypoint = (f: string) => ENTRYPOINTS.some((re) => re.test(f.replace(/\\/g, '/')));

/** Opt out for a deliberately-unused export: put this on the line above it. */
const OPT_OUT = /@public|@entrypoint|eslint-disable.*no-unused/;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.shanauto',
  // Python and Next.js. A virtualenv holds every third-party package installed,
  // so walking it is both enormous and a source of accidental "references".
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.next',
  '.mypy_cache',
]);

const SOURCE_EXT = ['.ts', '.py'];

/** Repo-relative source paths, tracked or not. */
function walkSource(root: string, rel = '', out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkSource(root, child, out);
    } else if (SOURCE_EXT.some((x) => e.name.endsWith(x))) {
      out.push(child);
    }
  }
  return out;
}

const MAX_CACHE_ENTRIES = 8;

interface TreeCacheEntry {
  contents: Map<string, string>;
  /** Candidate files (non-test .ts files the gate has seen changed at this HEAD). */
  dirty: Set<string>;
}

/**
 * Whole-tree source cache for the reference scan, keyed by the repo HEAD the
 * tree is based on.
 *
 * The gate runs findDeadExports once per task, and every task that adds a new
 * export walks every non-test .ts file to prove the export is referenced. For a
 * repo with hundreds of files, that walk is real overhead repeated per task.
 *
 * The key is deliberately not HEAD alone. A plain HEAD-keyed cache is unsound
 * here: a task that rolls back leaves the tree dirty at the same HEAD, and a
 * later task at that HEAD would be handed a stale tree — hiding a genuinely dead
 * export, which is exactly what this module must never do. So a hit requires the
 * current candidate set to be a subset of the files this cache entry has already
 * seen dirty, and those files are re-read from disk on every hit. Any modified
 * non-test .ts file is a candidate by definition, so the dirty set is exactly
 * the set of files that can have changed since the entry was built; everything
 * else in the tree is untouched and the cached copy stays valid.
 *
 * Bounded so a run that visits many SHAs cannot grow it forever.
 */
const treeCache = new Map<string, TreeCacheEntry>();

async function cachedTree(
  git: ReturnType<typeof simpleGit>,
  repo: Repo,
  candidates: string[],
): Promise<Map<string, string>> {
  const sha = await git.revparse(['HEAD']).catch(() => ''); // no commits yet
  const key = `${repo.id}@${sha}`;
  const hit = treeCache.get(key);

  if (hit && candidates.every((f) => hit.dirty.has(f))) {
    // Only the dirty files can have changed since build. Refresh them from
    // disk, so a rolled-back or re-modified file never serves stale contents.
    for (const f of hit.dirty) {
      try {
        hit.contents.set(f, readFileSync(join(repo.path, f), 'utf8'));
      } catch {
        hit.contents.delete(f); // deleted by an agent
      }
    }
    return hit.contents;
  }

  const contents = new Map<string, string>();
  for (const f of walkSource(repo.path)) {
    if (isTest(f)) continue;
    try {
      contents.set(f, readFileSync(join(repo.path, f), 'utf8'));
    } catch {
      /* deleted mid-run */
    }
  }
  treeCache.set(key, { contents, dirty: new Set(candidates) });
  if (treeCache.size > MAX_CACHE_ENTRIES) {
    const oldest = treeCache.keys().next().value;
    if (oldest !== undefined) treeCache.delete(oldest);
  }
  return contents;
}

/**
 * The symbol appears somewhere in this file other than its own `def`/`class`.
 *
 * A definition is not a use, so matching the whole file would make every symbol
 * reference itself and the check would never fire at all.
 */
function usedBesideItsDefinition(src: string, symbol: string, word: RegExp): boolean {
  const defines = new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${escapeRegExp(symbol)}\\b`);
  return src.split('\n').some((line) => !defines.test(line) && word.test(line));
}

export async function findDeadExports(repo: Repo, changedFiles: string[]): Promise<DeadExport[]> {
  const git = simpleGit({ baseDir: repo.path, maxConcurrentProcesses: 1 });

  const candidates = changedFiles.filter(
    (f) => SOURCE_EXT.some((x) => f.endsWith(x)) && !isTest(f) && !isEntrypoint(f),
  );
  // No source files in the diff, and no new exports, both return before the
  // whole-tree walk below ever runs.
  if (candidates.length === 0) return [];

  // New exports = what the file exports now, minus what it exported at HEAD.
  // A file absent from HEAD is brand new, so everything it exports is new.
  const added: DeadExport[] = [];
  for (const file of candidates) {
    let current: string;
    try {
      current = readFileSync(join(repo.path, file), 'utf8');
    } catch {
      continue; // deleted by the agent
    }
    const before = await git.show([`HEAD:${file.replace(/\\/g, '/')}`]).catch(() => '');
    const wasExported = publicSymbols(before, file);

    for (const symbol of publicSymbols(current, file)) {
      if (!wasExported.has(symbol)) added.push({ file, symbol });
    }
  }
  if (added.length === 0) return [];

  // Everything that could legitimately reference them: non-test source only.
  //
  // Walks the filesystem rather than `git ls-files`, because the file doing the
  // referencing is very often brand new and therefore untracked - which made this
  // report a wired-up export as dead. Cached by HEAD with a dirty-set guard (see
  // cachedTree) so repeat tasks on the same files do not pay for the walk.
  const contents = await cachedTree(git, repo, candidates);

  const dead: DeadExport[] = [];
  for (const { file, symbol } of added) {
    // SEC-6: symbol names are JS identifiers but may contain `$` (and are
    // interpolated here), so the metacharacters must be escaped or a symbol
    // like `$foo` becomes an end-anchor and nothing is ever found.
    const word = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const py = file.endsWith('.py');
    let referenced = false;
    for (const [f, src] of contents) {
      const own = f.replace(/\\/g, '/') === file.replace(/\\/g, '/');
      /*
       * A TypeScript export referenced only inside its own file is still dead as
       * far as the product is concerned.
       *
       * Python is not the same language about this. A Pydantic response model is
       * defined next to the endpoint that declares it and named nowhere else; so
       * is a dataclass, an Enum, an exception class. Requiring an outside
       * reference would reject them all, and the cost of a false positive here is
       * a correct change rolled back and an agent request burned re-deriving it.
       *
       * So for Python the bar is lower: used somewhere other than the line that
       * defines it. That still catches the thing this module exists for — a whole
       * new module nobody wired up, which is exactly what
       * app/services/query_similarity.py would have been on 2026-08-20.
       */
      if (own && !py) continue;
      if (own ? usedBesideItsDefinition(src, symbol, word) : word.test(src)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) dead.push({ file, symbol });
  }

  if (dead.length) {
    log.debug(`dead exports: ${dead.map((d) => `${d.symbol} (${d.file})`).join(', ')}`);
  }
  return dead;
}
