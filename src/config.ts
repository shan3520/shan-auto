import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  SystemSchema,
  DriversSchema,
  ReposFileSchema,
  type SystemConfig,
  type DriversConfig,
  type Repo,
} from './schemas.js';
import { repoRouting } from './core/router.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const p = (...parts: string[]) => join(ROOT, ...parts);

/**
 * Where this instance reads system.yaml, drivers.yaml and repos.yaml from.
 *
 * Defaults to the repo's own config/ directory. `SHANAUTO_CONFIG` redirects a
 * whole instance — including the config it boots from — so a subprocess test can
 * point at throwaway config instead of the real repos.yaml, which names the
 * operator's actual projects. The config is read once per process and cached;
 * the redirect matters at boot, not on every read.
 */
export function configDir(): string {
  return process.env.SHANAUTO_CONFIG ?? p('config');
}

/**
 * Where reports are written.
 *
 * Follows `SHANAUTO_DB`, so an instance pointed at another ledger writes its
 * output beside that ledger rather than into the real repo.
 *
 * This was `p('data','reports')` unconditionally. Reporter tests redirected the
 * DATABASE to a temp file and then wrote their output over the tracked
 * `data/reports/ledger.csv` and `weekly-*.md` — rebuilt from whatever was in
 * that empty temp database. Here the real database has rows so the files were
 * merely churned; in a fresh worktree, 135 rows of real history were replaced
 * by a header line. Five separate agents hit it in one afternoon, and a `git
 * add -A` after a test run would have committed the wipe.
 *
 * Derived rather than passed in on purpose: a defaulted parameter is only safe
 * while every caller remembers to pass it, and the cost of one forgetting is
 * losing real data. Tests already set SHANAUTO_DB to isolate themselves, so
 * this makes that one decision cover their writes too.
 */
export function reportsDir(): string {
  const db = process.env.SHANAUTO_DB;
  if (!db) return p('data', 'reports');
  // An in-memory ledger has no directory to sit beside.
  if (db === ':memory:') return join(tmpdir(), 'shanauto-reports');
  return join(dirname(db), 'reports');
}

/**
 * Root of this instance's writable data: the run journal and the brain/agent
 * artifacts, which the logger writes under `data/runs` and `data/artifacts`.
 *
 * Mirrors reportsDir() for the same reason: tests isolate themselves by setting
 * SHANAUTO_DB to a temp ledger, and that one decision should cover every write,
 * not just the reports. Before this existed the database and the reports went
 * to the temp dir while the run journal and artifacts kept landing in the real
 * `data/` — a test-suite run appended fixture lines to the real run log and
 * dropped adhoc artifacts into the real tree even though nothing else leaked.
 * An in-memory ledger gets a scratch dir, since it has no path to sit beside.
 */
export function dataRoot(): string {
  const db = process.env.SHANAUTO_DB;
  if (!db) return p('data');
  if (db === ':memory:') return join(tmpdir(), 'shanauto-data');
  return dirname(db);
}

/**
 * Where the run lock and the killswitch live.
 *
 * Follows SHANAUTO_DB, the way reportsDir() and dataRoot() do, so a redirected
 * instance locks ITS OWN run.lock instead of racing the real one in state/. The
 * lock file is what stops two runs from stepping on each other (SEC-5), so a
 * test that shared it with production would either block on a live run or take
 * over its lock. Production (no SHANAUTO_DB) resolves to the same state/ it
 * always has.
 */
export function stateRoot(): string {
  const db = process.env.SHANAUTO_DB;
  if (!db) return p('state');
  if (db === ':memory:') return join(tmpdir(), 'shanauto-state');
  return join(dirname(db), 'state');
}

function yaml<T>(rel: string, schema: { parse: (v: unknown) => T }): T {
  const file = join(configDir(), rel);
  if (!existsSync(file)) {
    /*
     * repos.yaml names absolute paths on the operator's own disk, so it is
     * gitignored and a fresh clone does not have one. That makes this the FIRST
     * thing anyone cloning this repo hits, and "Missing config file" alone
     * leaves them to guess that a tracked `.example` exists beside it.
     */
    if (existsSync(`${file}.example`)) {
      throw new Error(
        `Missing config file: ${file}\n` +
          `  It is gitignored, because it names paths on your own disk.\n` +
          `  Copy the tracked example and edit it:  cp config/${rel}.example config/${rel}`,
      );
    }
    throw new Error(`Missing config file: ${file}`);
  }
  try {
    return schema.parse(parseYaml(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`Invalid ${rel}: ${(err as Error).message}`);
  }
}

export interface AppConfig {
  system: SystemConfig;
  drivers: DriversConfig;
  repos: Repo[];
}

let cached: AppConfig | null = null;

/**
 * Projects listed in repos.yaml whose folder is not on disk.
 *
 * A missing folder used to THROW at boot, from the function every command calls
 * — so one moved or renamed folder took down `doctor`, `status` and the TUI
 * along with it, and the only screen that could have explained the problem was
 * the first casualty. Someone with three projects lost all three because of one.
 */
export let missingRepos: { id: string; path: string }[] = [];

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;
  const system = yaml('system.yaml', SystemSchema);
  const drivers = yaml('drivers.yaml', DriversSchema);
  const repos = yaml('repos.yaml', ReposFileSchema).repos.filter((r) => r.enabled);

  if (repos.length === 0) {
    throw new Error('config/repos.yaml has no enabled repos. Add at least one.');
  }
  /*
   * A missing folder disables that one project, not the whole system.
   *
   * This used to throw, at boot, from the function every command calls — so one
   * moved or renamed folder took down `doctor`, `status` and the TUI along with
   * it, and the only screen that could have explained the problem was the first
   * casualty. Someone with three projects lost all three because of one.
   *
   * Dropping it from the allowlist is the safe direction: the guardrail is that
   * nothing outside this list is ever touched, and a repo that is not in it
   * cannot be worked on by definition.
   */
  const present = repos.filter((r) => existsSync(r.path));
  /*
   * Recorded rather than logged. `logger` imports `p` from this module, so
   * importing it back here would be a cycle — and a cycle in the module every
   * command loads first is not worth a warning line. `doctor` and `status` read
   * this and say it properly; the console line below is the backstop so a
   * disabled project is never completely silent.
   */
  missingRepos = repos.filter((r) => !existsSync(r.path)).map((r) => ({ id: r.id, path: r.path }));
  for (const m of missingRepos) {
    console.warn(
      `[shanauto] Project "${m.id}" is switched off: its folder is missing (${m.path})`,
    );
  }
  if (present.length === 0) {
    throw new Error(
      `None of the projects in config/repos.yaml exist on disk. ` +
        `Restore a folder, or start a new project.`,
    );
  }

  const cfg: AppConfig = { system, drivers, repos: present };
  // repos.yaml names agents that only drivers.yaml can define, so the two files
  // can only be checked against each other here. Do it at boot: a mistyped agent
  // id should cost a startup error, not a run that spends quota before anyone
  // notices the wrong agent took the work.
  for (const r of repos) repoRouting(cfg, r.id);

  cached = cfg;
  return cached;
}

/** Guardrail: the system refuses to operate on any path not in the allowlist. */
export function resolveRepo(cfg: AppConfig, id: string): Repo {
  const repo = cfg.repos.find((r) => r.id === id);
  if (!repo) {
    throw new Error(
      `Repo "${id}" is not in the allowlist (config/repos.yaml). Refusing to touch it.`,
    );
  }
  return repo;
}

/**
 * Prefixed to every brain prompt. Its own file, so the rule is stated once
 * rather than copy-pasted into five templates that then drift apart.
 *
 * Why it exists: on 2026-08-08 agy, planning in its empty scratch dir, kept
 * reaching for `command` and `read_file`. Headless mode has nobody to ask, so
 * each call was auto-denied and returned nothing at all — 20-50s and a provider
 * request spent on empty output, repeatedly, until one planning pass ran out of
 * retries and died. Nothing in the prompts had ever told the model there were
 * no tools; the empty cwd was the only hint, and it read that as "go explore".
 *
 * The prompt is a request, not a constraint — brain.agy.ts detects the denial
 * in code as well.
 */
const PREAMBLE = '_no-tools';

/**
 * Load a brain prompt template. Names beginning with `_` are fragments and are
 * returned bare, which is also what stops the preamble prefixing itself.
 */
export function prompt(name: string): string {
  const body = readFileSync(p('config', 'prompts', `${name}.md`), 'utf8');
  // The `_` check is what terminates this recursion, as well as what lets a
  // fragment be loaded on its own.
  if (name.startsWith('_')) return body;
  return `${prompt(PREAMBLE).trim()}\n\n${body}`;
}

export function fill(tpl: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)),
    tpl,
  );
}
