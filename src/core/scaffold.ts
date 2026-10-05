import { execa } from 'execa';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir } from '../config.js';
import { writeFileSafe, escapeRegExp } from '../util.js';
import { log } from '../logger.js';
import { COMMON_IGNORE, type Stack } from './stacks.js';

/**
 * Start a project from nothing.
 *
 * Until now ShanAuto could only ever CONTINUE a project. Every repo it has
 * worked on was created by hand first — the folder, `git init`, the remote, the
 * spec, and the entry in repos.yaml — and only then handed over. example-api's very
 * first commit is that hand-scaffold; all 32 after it are ShanAuto's.
 *
 * Everything here is deliberately boring and reversible. It is the one place in
 * the system that creates things outside its own data directory, so:
 *
 *   - it never writes into a directory that already has anything in it;
 *   - it makes the GitHub remote only when explicitly asked, and private;
 *   - it appends to repos.yaml line-by-line, never re-serialising it, because
 *     that file is mostly comments explaining why each value is what it is.
 */

export interface NewProject {
  id: string;
  /** Absolute path to create. */
  path: string;
  stack: Stack;
  branch: string;
  /** One or two sentences from the owner about what this is for. */
  purpose: string;
}

export interface ScaffoldResult {
  path: string;
  verify_cmd: string;
  remote: string | null;
  /** Anything that did not work but did not justify stopping. */
  notes: string[];
}

/**
 * A project id that is safe as a folder name, a git branch and a YAML key.
 *
 * Rejected rather than silently mangled: "abc project" quietly becoming
 * "abc-project" means the name on screen never matches the folder on disk, and
 * the owner is the one who has to reconcile them later.
 */
export function validateId(id: string): string | null {
  if (!id.trim()) return 'A project needs a name.';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    return 'Use letters, numbers, dashes or underscores only — no spaces, and it must start with a letter or number.';
  }
  if (id.length > 64) return 'That name is too long (64 characters at most).';
  // Windows will not create these whatever permissions say.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
    return `"${id}" is a name Windows reserves. Pick another.`;
  }
  return null;
}

/** Is this directory safe to create a project in? */
export function checkTarget(path: string): string | null {
  if (!existsSync(path)) return null;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (e) {
    return `Cannot read ${path}: ${(e as Error).message}`;
  }
  if (entries.length === 0) return null;
  /*
   * Refuses rather than merges. A folder with files in it is somebody's work,
   * and this function's job includes `git init` and a first commit — doing that
   * on top of an existing directory would sweep whatever is there into a commit
   * nobody asked for.
   */
  return `${path} already exists and is not empty (${entries.length} item(s)). Pick a different name, or move that folder aside first.`;
}

function seedFiles(proj: NewProject): Record<string, string> {
  const ignore = [
    '# What must never be committed.',
    ...COMMON_IGNORE,
    '',
    `# ${proj.stack.label}`,
    ...proj.stack.ignore,
    '',
  ].join('\n');

  const readme = [
    `# ${proj.id}`,
    '',
    proj.purpose.trim() || 'A new project.',
    '',
    '## The check',
    '',
    'Nothing is committed to this project unless this command exits 0:',
    '',
    '```',
    proj.stack.floor,
    '```',
    '',
    'It starts as a syntax check because there is nothing here to test yet.',
    'Once real tests exist, ShanAuto will offer to tighten it — say yes.',
    '',
  ].join('\n');

  const spec = [
    `# ${proj.id} — what this is for`,
    '',
    proj.purpose.trim() || '_Not described yet._',
    '',
    '## What should exist when it is done',
    '',
    '_Fill this in as the shape becomes clear. ShanAuto reads this file when it',
    'plans work, so anything written here steers what gets built._',
    '',
    '## What it must not do',
    '',
    '_Constraints are worth more than features here — they are the part an',
    'automated worker cannot infer._',
    '',
  ].join('\n');

  /*
   * The stack's own marker goes in the first commit, beside the readme.
   *
   * Same reasoning as committing at all: `fileTree` and `apiSurface` read
   * tracked files, and `detectStacks` reads marker files. A project whose stack
   * cannot be detected is one `validateTasks` refuses to accept work for, so
   * without this the planner spends a brain call, has every task rejected, and
   * buys the next one back with a retry.
   */
  return {
    '.gitignore': ignore,
    'README.md': readme,
    'docs/SPEC.md': spec,
    ...proj.stack.seed(proj.id),
  };
}

/**
 * Create the folder, the git repo and the first commit.
 *
 * The first commit matters more than it looks: `fileTree` and `apiSurface` both
 * read TRACKED files only, so a project with nothing committed is invisible to
 * the planner — it would look at a brand-new repo and see `(empty repo)`.
 */
export async function scaffold(
  proj: NewProject,
  opts: { remote?: boolean; visibility?: 'private' | 'public' } = {},
): Promise<ScaffoldResult> {
  const notes: string[] = [];
  const path = resolve(proj.path);

  const blocked = checkTarget(path);
  if (blocked) throw new Error(blocked);

  mkdirSync(path, { recursive: true });

  const files = seedFiles(proj);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(path, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }

  const git = (...args: string[]) => execa('git', args, { cwd: path, reject: false, stdin: 'ignore' });

  await git('init', '-q', '-b', proj.branch);
  await git('add', '-A');
  const commit = await git('commit', '-qm', `chore: start ${proj.id}`);
  if (commit.exitCode !== 0) {
    /*
     * Almost always a missing user.name/user.email. Worth naming precisely: the
     * folder now exists with files in it, and a vague failure here leaves the
     * owner with a half-made project and no idea which half.
     */
    throw new Error(
      `Created ${path}, but the first commit failed:\n${commit.stderr || commit.stdout}\n` +
        `Set your git identity and commit by hand, or delete the folder and try again.`,
    );
  }

  let remote: string | null = null;
  if (opts.remote) {
    remote = await createRemote(proj, path, opts.visibility ?? 'private', notes);
  } else {
    notes.push('No GitHub repository was created — commits will stay on this machine.');
  }

  return { path, verify_cmd: proj.stack.floor, remote, notes };
}

/**
 * Give a project that already exists a GitHub repository, and push what it has.
 *
 * `scaffold` could always do this, at the one moment a project is born. Miss it
 * there - `sa new` without `--github`, or answering "not now" in the TUI - and
 * there was no route back from anywhere in the system. `doctor` has reported
 * `remote MISSING (commits stay local)` on every run since it was written, and
 * `hasRemote` had exactly one caller: that diagnostic line. The system could
 * see the state and had no button to leave it.
 *
 * Measured 2026-08-27: example-ledger, 8 commits of ShanAuto's own work, and
 * example-receipts, 7, sitting on one machine with nowhere to go. This is the whole
 * distance between building the work and the README's first promise, that
 * the system "pushes what survives": a project with no remote has nowhere to
 * push it.
 *
 * Refuses a project that already has one. Re-pointing `origin` at a new empty
 * repository is how work stops arriving where somebody is looking for it, and
 * nothing in here should be able to do that by accident.
 */
export async function publishProject(
  repo: { id: string; path: string },
  opts: { visibility?: 'private' | 'public' } = {},
): Promise<{ remote: string | null; notes: string[] }> {
  const notes: string[] = [];
  const path = resolve(repo.path);

  if (!existsSync(join(path, '.git'))) {
    notes.push(`${path} is not a git repository, so there is nothing to publish.`);
    return { remote: null, notes };
  }

  const remote = await createRemote(
    { id: repo.id } as NewProject,
    path,
    opts.visibility ?? 'private',
    notes,
  );
  return { remote, notes };
}

/**
 * Create the GitHub repository and push.
 *
 * Private unless asked otherwise. Creating a public repo publishes the owner's
 * work to the internet under their name, and that is not a default anything
 * should choose on someone's behalf.
 */
export async function createRemote(
  proj: NewProject,
  path: string,
  visibility: 'private' | 'public',
  notes: string[],
): Promise<string | null> {
  const gh = await execa('gh', ['--version'], { reject: false, stdin: 'ignore' });
  if (gh.exitCode !== 0) {
    notes.push('The GitHub CLI (gh) is not available, so no remote was created. The project works fine without one.');
    return null;
  }

  const res = await execa(
    'gh',
    ['repo', 'create', proj.id, `--${visibility}`, '--source', '.', '--remote', 'origin', '--push'],
    { cwd: path, reject: false, stdin: 'ignore' },
  );

  if (res.exitCode !== 0) {
    notes.push(`Could not create the GitHub repository: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
    notes.push('The project is still usable — commits will just stay on this machine.');
    return null;
  }

  const url = await execa('git', ['remote', 'get-url', 'origin'], { cwd: path, reject: false, stdin: 'ignore' });
  return url.exitCode === 0 ? url.stdout.trim() : `github: ${proj.id}`;
}

/**
 * Point one repo's `verify_cmd` at a stronger command, in place.
 *
 * The day a scaffolded project grows its first test, its gate stops being
 * adequate. `registerRepo` writes a syntax-only check because a stricter one
 * would fail every task before the project exists, and the comment it leaves
 * says `sa doctor` will offer to tighten it - which it does, by telling the
 * owner to edit this file by hand.
 *
 * That is a fine answer for someone who reads YAML and a dead end for the
 * person this is built for. It is also the exact fault already recorded against
 * example-api: `verify_cmd` was `python -m compileall`, the repo had 27 tests for
 * days with 3 of them failing, and the gate passed every one of them through.
 * A project built from an idea with nobody watching would reach that state on
 * its first task and stay there.
 *
 * Line-by-line for the same reason registerRepo appends rather than
 * re-serialising: this file is mostly comments explaining why each value is
 * what it is. Returns false when the repo has no entry or no verify_cmd line,
 * which the caller reports rather than swallowing - a gate that silently failed
 * to tighten is worse than one that never tried.
 */
export function tightenGate(
  repoId: string,
  command: string,
  file = join(configDir(), 'repos.yaml'),
): boolean {
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const idLine = new RegExp(`^\\s*-\\s*id:\\s*"?${escapeRegExp(repoId)}"?\\s*$`);
  const anyId = /^\s*-\s*id:/;

  const start = lines.findIndex((l) => idLine.test(l));
  if (start < 0) return false;

  // Only inside THIS repo's block. Scanning the whole file would rewrite the
  // first verify_cmd it found, which for the first repo in the list is a
  // different project's gate.
  for (let i = start + 1; i < lines.length; i++) {
    if (anyId.test(lines[i]!)) break;
    const m = /^(\s*)verify_cmd:/.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}verify_cmd: ${q(command)}`;
      writeFileSafe(file, lines.join(eol));
      return true;
    }
  }
  return false;
}

/**
 * Add the project to the allowlist.
 *
 * Appended as text rather than through a YAML round-trip, for the same reason
 * `writeSetting` edits line by line: that file is mostly comments recording why
 * each value is what it is, including the note about ShanAuto never listing
 * itself. Re-serialising would throw all of it away.
 */
export function registerRepo(
  proj: NewProject,
  verify_cmd: string,
  /*
   * `configDir()`, not `p('config', ...)`. Everything else in the system reads
   * its config through SHANAUTO_CONFIG; these two wrote to the repo's own
   * directory regardless, so an instance pointed at throwaway config still
   * edited the real repos.yaml - the file that names the operator's actual
   * projects. Caught by the first test to exercise tightenGate through the CLI.
   */
  file = join(configDir(), 'repos.yaml'),
): void {
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';

  // SEC-11: the id is interpolated into a RegExp, so its regex metacharacters
  // (`.` in particular — ids allow dots) must be escaped. The optional quotes
  // tolerate a previously-written quoted id.
  if (new RegExp(`^\\s*-\\s*id:\\s*"?${escapeRegExp(proj.id)}"?\\s*$`, 'm').test(raw)) {
    throw new Error(`"${proj.id}" is already in ${file}.`);
  }

  // SEC-11: the values are written into a hand-edited YAML file that is parsed
  // again by the loader, so YAML-special characters (a Windows drive `D:` in
  // path, `&&` in verify_cmd, `#` in a branch) must not be able to break out of
  // their scalar. Double-quote them and escape embedded quotes.
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  const entry = [
    '',
    `  - id: ${proj.id}`,
    `    path: ${q(proj.path.replace(/\\/g, '/'))}`,
    `    branch: ${q(proj.branch)}`,
    `    stack: ${q(proj.stack.id)}`,
    /*
     * Worded to stay true after the gate is tightened, not only before it.
     *
     * The old text said "Starts as a syntax check ... `sa doctor` watches for
     * the day real tests appear and offers to tighten it", and a run has done
     * the tightening itself since 2026-08-27. Worse, `tightenGate` rewrites the
     * verify_cmd line and nothing else — so example-ledger ended up with a comment
     * announcing a syntax check directly above a command that runs pytest.
     * A comment that describes one of two states goes stale the moment the
     * other one arrives.
     */
    '    # The gate: nothing is committed here unless this command exits 0.',
    '    #',
    '    # A new project starts on a syntax check, because anything stricter',
    '    # would fail every task before the project exists. The first run that',
    '    # finds real tests replaces the line below with one that runs them,',
    '    # and says so while it does it.',
    '    #',
    '    # That only ever happens while the line is EXACTLY as written at setup.',
    '    # Edit it and it is yours — nothing will change it again.',
    '    #',
    '    # It must NOT be a script inside the repo: an agent can edit those, and a',
    '    # gate an agent can edit is not a gate.',
    `    verify_cmd: ${q(verify_cmd)}`,
    '    enabled: true',
    '    weight: 1',
  ].join(eol);

  /*
   * Inserted before the commented-out examples at the end rather than appended,
   * so the "add your other projects below" block stays where it is useful.
   */
  const marker = raw.indexOf('  # --- add your other projects below ---');
  const next = marker >= 0 ? raw.slice(0, marker) + entry + eol + eol + raw.slice(marker) : raw + entry + eol;

  writeFileSafe(file, next);
  log.info(`Added "${proj.id}" to ${file}`);
}
