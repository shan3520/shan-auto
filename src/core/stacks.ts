import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a new project is made of, and how its gate grows up.
 *
 * The gate is the whole guarantee: nothing is committed unless the project's own
 * check passes. On day one that is a problem, because an empty repo has no tests
 * to run and no build to break — any check strict enough to be worth having
 * fails before the project exists.
 *
 * example-api is the worked example, and the mistake is instructive. It was given
 * `python -m compileall`, correctly, on 2026-08-07 with a README and a spec. By
 * 2026-08-09 it had 27 tests across 10 files, three of them FAILING, and the
 * gate had been passing every one of them through for days — because nothing
 * ever revisited the decision. A floor chosen for an empty repo silently became
 * a ceiling on a real one.
 *
 * So a stack carries two commands, not one:
 *
 *   floor  — passes on an empty repo. Catches syntax errors, nothing more.
 *   full   — what the gate should be once there is something to check.
 *
 * `suggestedGate` picks between them by looking at what is actually on disk, and
 * `sa doctor` re-asks the question every time it runs. The upgrade is never
 * applied silently: it is the owner's gate, and tightening it can stop work.
 */

export interface Stack {
  id: string;
  /** Shown in the TUI, in the owner's words. */
  label: string;
  /** Gate for a repo with no code in it yet. Must pass on an empty directory. */
  floor: string;
  /** Gate once the project has tests worth running. */
  full: string;
  /** Files that say "this stack is in use here". */
  markers: string[];
  /** Directories a test suite would live in. */
  testDirs: string[];
  /** Seeded into .gitignore, on top of the shared entries. */
  ignore: string[];
  /**
   * The marker file a new project needs on day one, and what goes in it.
   *
   * Without this a scaffolded project is not, by its own rules, a project of
   * this stack at all. `detectStacks` looks for `markers`; `sa new` wrote a
   * README, a .gitignore and a spec and nothing else; so `validateTasks`
   * rejected every task it was given with "verify_cmd is a python check, but
   * <project> has no python project". Measured 2026-08-26 on the first
   * greenfield run: the decomposer's whole first proposal was thrown away and
   * a second brain call bought back one task.
   *
   * Keyed by path so a stack can need more than one. Takes the project id
   * because these files carry the name - a package.json or a go.mod with the
   * wrong module in it is worse than none.
   */
  seed: (id: string) => Record<string, string>;
}

export const STACKS: Stack[] = [
  {
    id: 'python',
    label: 'Python',
    floor: 'python -m compileall -q -x "(node_modules|[.]venv|[.]next)" .',
    full: 'python -m compileall -q -x "(node_modules|[.]venv|[.]next)" . && python -m pytest -q',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    testDirs: ['tests', 'test'],
    ignore: ['__pycache__/', '*.pyc', '.venv/', '.pytest_cache/'],
    // No [build-system]: nothing here installs the project, and naming a build
    // backend that is not present turns `pip install -e .` into a failure the
    // owner has to diagnose. The [project] table alone is what makes this a
    // Python project to every tool that looks.
    seed: (id) => ({
      'pyproject.toml': [
        '[project]',
        `name = "${id}"`,
        'version = "0.1.0"',
        'requires-python = ">=3.10"',
        '',
      ].join('\n'),
    }),
  },
  {
    id: 'typescript',
    label: 'TypeScript / Node',
    floor: 'npx --no-install tsc --noEmit',
    full: 'npx --no-install tsc --noEmit && npm test',
    markers: ['tsconfig.json', 'package.json'],
    testDirs: ['tests', 'test', 'src/__tests__'],
    ignore: ['node_modules/', 'dist/', '.next/'],
    /*
     * package.json only, deliberately, even though tsconfig.json is the first
     * marker listed. The floor is `npx --no-install tsc --noEmit`, and tsc with
     * a tsconfig that matches no files exits non-zero ("No inputs were found"),
     * which would fail the gate on every task until the first .ts file lands -
     * the exact failure the floor exists to avoid. package.json satisfies
     * detection on its own and stays out of the compiler's way.
     */
    seed: (id) => ({
      'package.json':
        JSON.stringify({ name: id, version: '0.1.0', private: true, type: 'module' }, null, 2) +
        '\n',
    }),
  },
  {
    id: 'javascript',
    label: 'JavaScript / Node',
    floor: 'node --check-all-js 2>/dev/null || node -e "process.exit(0)"',
    full: 'npm test',
    markers: ['package.json'],
    testDirs: ['tests', 'test'],
    ignore: ['node_modules/', 'dist/'],
    seed: (id) => ({
      'package.json':
        JSON.stringify({ name: id, version: '0.1.0', private: true, type: 'module' }, null, 2) +
        '\n',
    }),
  },
  {
    id: 'go',
    label: 'Go',
    floor: 'go build ./... 2>/dev/null || true',
    full: 'go build ./... && go test ./...',
    markers: ['go.mod'],
    testDirs: ['.'],
    ignore: ['bin/', '*.exe'],
    seed: (id) => ({ 'go.mod': `module ${id}\n\ngo 1.22\n` }),
  },
];

export function stackById(id: string): Stack | undefined {
  return STACKS.find((s) => s.id === id);
}

/** Shared with every stack: things no project should ever commit. */
export const COMMON_IGNORE = ['.env', '.env.*', '!.env.example', '.DS_Store', '*.log'];

/** Does this directory hold anything a test runner would pick up? */
export function hasTests(repoPath: string, stack: Stack): boolean {
  const looksLikeTest = (name: string) =>
    /(^|[._-])tests?([._-]|$)|\.(test|spec)\./i.test(name);

  for (const dir of stack.testDirs) {
    const full = join(repoPath, dir);
    if (!existsSync(full)) continue;
    let found = false;
    const walk = (d: string, depth: number): void => {
      if (found || depth > 3) return;
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const e of entries) {
        if (found) return;
        if (e === 'node_modules' || e === '.git' || e === '.venv') continue;
        const p = join(d, e);
        let isDir = false;
        try {
          isDir = statSync(p).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(p, depth + 1);
        else if (looksLikeTest(e)) found = true;
      }
    };
    walk(full, 0);
    if (found) return true;
  }
  return false;
}

export interface GateSuggestion {
  /** What the gate should be, given what is on disk right now. */
  command: string;
  /** Why — in the owner's words, for a screen they will actually read. */
  reason: string;
  /** True when the current command is weaker than it should be. */
  upgrade: boolean;
}

/**
 * Should this repo's gate be stronger than it is?
 *
 * Deliberately conservative in one direction only: it will suggest tightening a
 * gate and never suggest loosening one. A gate someone chose by hand is theirs,
 * and the job here is to notice the day a floor stopped being adequate — not to
 * have opinions about a considered decision.
 */
export function suggestedGate(repoPath: string, stack: Stack, current: string): GateSuggestion {
  const tests = hasTests(repoPath, stack);

  if (!tests) {
    return {
      command: current,
      reason: 'no tests here yet, so the check can only look for broken syntax',
      upgrade: false,
    };
  }

  // Already running the suite — by the full command, or by any command of the
  // owner's own that mentions the test runner.
  const runner = stack.full.replace(stack.floor, '').trim();
  const alreadyRuns = current === stack.full || (runner.length > 0 && current.includes(runner.replace(/^&&\s*/, '')));

  if (alreadyRuns) {
    return { command: current, reason: 'the check already runs the tests', upgrade: false };
  }

  return {
    command: stack.full,
    reason:
      'this project has tests now, but its check only looks for broken syntax — ' +
      'so a change that breaks a test would still be saved',
    upgrade: true,
  };
}

/**
 * What is ACTUALLY in this repo, as opposed to what config says is in it.
 *
 * `markers` has described "files that say this stack is in use here" since this
 * module was written, and until 2026-08-20 nothing ever read it. The stack came
 * from a hand-typed line in `config/repos.yaml` instead — and a hand-typed fact
 * drifts the moment a project changes shape, silently, with nothing to catch it.
 *
 * example-api is the worked example. Its config says
 * `stack: python + fastapi + next.js`. There is no package.json anywhere in the
 * repo and the `frontend/` directory is empty. That string went straight into
 * the planning prompt as fact, so every pass invented React components for a
 * project that cannot build, run or test one: milestones that would not
 * decompose, tasks whose only possible check was "does a file with this name
 * exist", and roughly six wasted model calls per pass.
 *
 * Nobody should have to keep a config file in sync with something that can be
 * observed. This observes it.
 *
 * Two grades of answer, because they mean different things to a planner:
 *
 *   toolchain — a manifest is here. Work of this kind can be built and tested.
 *   source    — code of this kind is here, but nothing to install or run it
 *               with. example-api is exactly this for Python: `app/` and `tests/`
 *               full of .py, and no requirements.txt at all.
 *
 * Looks one level down as well as at the root, because `frontend/package.json`
 * is the ordinary shape of a repo with a UI attached.
 */
export interface DetectedStack {
  stack: Stack;
  /** '' for the repo root, otherwise the subdirectory it was found in. */
  at: string;
  evidence: 'toolchain' | 'source';
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'dist', '.next', '__pycache__', 'build', 'vendor']);

/** File extensions that say "code of this kind lives here". */
const SOURCE_EXT: Record<string, string[]> = {
  python: ['.py'],
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs'],
  go: ['.go'],
};

/** Is there a file with one of these extensions within `depth` levels of `dir`? */
function hasSource(dir: string, exts: string[], depth: number): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    const full = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) dirs.push(full);
    else if (exts.some((x) => e.toLowerCase().endsWith(x))) return true;
  }
  if (depth <= 0) return false;
  return dirs.some((d) => hasSource(d, exts, depth - 1));
}

function stacksAt(dir: string, sourceDepth: number): Omit<DetectedStack, 'at'>[] {
  const has = (f: string) => existsSync(join(dir, f));
  let hits = STACKS.filter((s) => s.markers.some(has));
  // package.json alone matches both node stacks; tsconfig.json decides which.
  if (hits.some((s) => s.id === 'typescript') && hits.some((s) => s.id === 'javascript')) {
    hits = has('tsconfig.json')
      ? hits.filter((s) => s.id !== 'javascript')
      : hits.filter((s) => s.id !== 'typescript');
  }
  const out: Omit<DetectedStack, 'at'>[] = hits.map((stack) => ({ stack, evidence: 'toolchain' as const }));

  for (const s of STACKS) {
    if (out.some((o) => o.stack.id === s.id)) continue;
    const exts = SOURCE_EXT[s.id];
    if (exts && hasSource(dir, exts, sourceDepth)) out.push({ stack: s, evidence: 'source' });
  }
  return out;
}

export function detectStacks(repoPath: string): DetectedStack[] {
  if (!existsSync(repoPath)) return [];
  const found: DetectedStack[] = stacksAt(repoPath, 2).map((s) => ({ ...s, at: '' }));

  let entries: string[] = [];
  try {
    entries = readdirSync(repoPath);
  } catch {
    return found;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    const full = join(repoPath, e);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    // Only a manifest earns a subdirectory its own entry. Source alone would
    // just re-report the root's own code one folder further in.
    for (const s of stacksAt(full, -1)) {
      if (s.evidence !== 'toolchain') continue;
      if (!found.some((f) => f.stack.id === s.stack.id && f.at === e)) found.push({ ...s, at: e });
    }
  }
  return found;
}

/**
 * Words an owner writes in `stack:` that imply an ecosystem, so a declared
 * framework can be checked against what is on disk. Deliberately short: it only
 * has to cover the frameworks someone would plausibly name.
 */
const IMPLIES: Record<string, string[]> = {
  python: ['python', 'py', 'fastapi', 'django', 'flask', 'pytest'],
  typescript: ['typescript', 'ts', 'next', 'next.js', 'nextjs', 'react', 'vue', 'svelte', 'angular', 'node', 'npm'],
  javascript: ['javascript', 'js'],
  go: ['go', 'golang'],
};

/**
 * Ecosystems the config claims that are nowhere on disk at all.
 *
 * Source without a manifest does NOT count as missing. example-api's Python is
 * exactly that — real code, no requirements.txt — and calling it a phantom
 * would be a louder lie than the one this exists to catch. That repo's gate
 * runs pytest and passes, so the toolchain plainly works; what is absent is the
 * declaration of it, which is a different and much smaller problem.
 */
export function phantomStacks(repoPath: string, declared: string): string[] {
  const words = new Set(
    declared
      .toLowerCase()
      .split(/[^a-z0-9.+#-]+/)
      .filter(Boolean),
  );
  const present = new Set(detectStacks(repoPath).map((d) => d.stack.id));
  // typescript and javascript are one ecosystem here: a repo with a package.json
  // can host either, so neither is "missing" while the other is there.
  if (present.has('typescript')) present.add('javascript');
  if (present.has('javascript')) present.add('typescript');

  const missing: string[] = [];
  for (const [id, hints] of Object.entries(IMPLIES)) {
    if (present.has(id)) continue;
    const named = hints.filter((h) => words.has(h));
    if (named.length > 0) missing.push(named[0]!);
  }
  return missing;
}

/**
 * What kind of code is this file, by its extension?
 *
 * The same table `detectStacks` uses to decide that source is present, asked
 * about one path instead of a directory. Undefined for anything that is not
 * source — .md, .json, .yaml, a bare directory name — because a planner guard
 * has no business having an opinion about those.
 */
export function stackOfFile(path: string): Stack | undefined {
  const lower = path.toLowerCase();
  for (const [id, exts] of Object.entries(SOURCE_EXT)) {
    if (exts.some((x) => lower.endsWith(x))) return stackById(id);
  }
  return undefined;
}

/**
 * The STACK line handed to the planner: what is on disk, plus an explicit
 * warning about anything config claims that the repo does not have.
 *
 * The declared value is still shown, because it is the owner's intent and that
 * carries real information — "next.js" may well mean "I want a frontend". What
 * it must not do any longer is read as a statement of present fact, which is how
 * the planner came to write tasks for a toolchain that was never there.
 */
export function stackSummary(repoPath: string, declared: string): string {
  const found = detectStacks(repoPath);
  const describe = (d: DetectedStack) =>
    `${d.stack.label}${d.at ? ` in ${d.at}/` : ''}` +
    (d.evidence === 'source' ? ' (source only — no manifest to install or pin dependencies)' : '');
  const observed =
    found.length === 0
      ? 'nothing recognisable — no project files found on disk'
      : found.map(describe).join(', ');

  const lines = [`declared in config: ${declared}`, `actually on disk: ${observed}`];

  const phantom = phantomStacks(repoPath, declared);
  if (phantom.length > 0) {
    lines.push(
      /*
       * This used to end "...the first task must be to create it", and the
       * planner took the invitation: the 2026-08-20 re-run spent two of five
       * tasks standing up a Next.js toolchain, and neither could be verified,
       * because the test runner they were installing is the thing that would
       * have had to judge them. Both checks came back as `test -f package.json`.
       *
       * A gate is the whole guarantee here. Work that no gate can judge does not
       * get planned, and standing up a new toolchain inside someone's existing
       * project is their decision to make, not a side effect of an idea.
       */
      `WARNING: config names ${phantom.map((x) => `"${x}"`).join(', ')}, but there is no such ` +
        `project in this repo — no code, no build, no test runner, no way to check that kind of ` +
        `work. Do NOT plan any task for it, INCLUDING setting it up: until that toolchain exists ` +
        `there is no check that could judge the result, and creating one is the owner's decision. ` +
        `Plan only work the checks already in this repo can actually verify.`,
    );
  }
  return lines.join('\n');
}
