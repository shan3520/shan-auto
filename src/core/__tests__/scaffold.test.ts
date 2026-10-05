import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  scaffold,
  publishProject,
  registerRepo,
  tightenGate,
  validateId,
  checkTarget,
  type NewProject,
} from '../scaffold.js';
import { STACKS, stackById, hasTests, suggestedGate } from '../stacks.js';

/**
 * Starting a project from nothing.
 *
 * Until this existed ShanAuto could only CONTINUE a project — every repo it had
 * ever worked on was created by hand first: the folder, `git init`, the remote,
 * the spec and the repos.yaml entry. example-api's first commit is exactly that
 * hand-scaffold; the 32 after it are ShanAuto's.
 *
 * These drive the real filesystem and real git, because that is where every
 * fault in this area lives.
 */

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a git handle may still hold it on Windows */
    }
  }),
);

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'scaf-'));
  dirs.push(d);
  return d;
};

const project = (over: Partial<NewProject> = {}): NewProject => ({
  id: 'abc',
  path: join(scratch(), 'abc'),
  stack: stackById('python')!,
  branch: 'main',
  purpose: 'A tool that turns receipts into a monthly summary.',
  ...over,
});

describe('a project name has to work as a folder, a branch and a YAML key', () => {
  it.each([
    ['abc', null],
    ['my-tool', null],
    ['tool_2', null],
    ['', 'A project needs a name.'],
  ])('%s', (id, expected) => {
    const r = validateId(id);
    expected === null ? expect(r).toBeNull() : expect(r).toBe(expected);
  });

  it('refuses a name with a space rather than silently mangling it', () => {
    // "abc project" quietly becoming "abc-project" means the name on screen
    // never matches the folder on disk, and the owner reconciles it later.
    expect(validateId('abc project')).toMatch(/no spaces/);
  });

  it('refuses names Windows reserves, which cannot be created at all', () => {
    for (const bad of ['con', 'PRN', 'nul', 'com1']) {
      expect(validateId(bad), bad).toMatch(/reserves/);
    }
  });
});

describe('it never writes into somebody else\'s folder', () => {
  it('accepts a path that does not exist yet', () => {
    expect(checkTarget(join(scratch(), 'nope'))).toBeNull();
  });

  it('accepts an existing but empty folder', () => {
    expect(checkTarget(scratch())).toBeNull();
  });

  it('refuses a folder with anything in it', () => {
    /*
     * This function's job includes `git init` and a first commit. Running that
     * on top of an existing directory would sweep whatever is there into a
     * commit nobody asked for.
     */
    const d = scratch();
    writeFileSync(join(d, 'my-work.txt'), 'do not touch\n');
    expect(checkTarget(d)).toMatch(/already exists and is not empty/);
  });

  it('scaffold itself refuses, not just the pre-check', async () => {
    const d = scratch();
    writeFileSync(join(d, 'thing.txt'), 'x\n');
    await expect(scaffold(project({ path: d }))).rejects.toThrow(/not empty/);
    expect(readFileSync(join(d, 'thing.txt'), 'utf8'), 'untouched').toBe('x\n');
  });
});

describe('what a new project looks like', () => {
  it('creates a git repo with a first commit', async () => {
    const proj = project();
    await scaffold(proj);

    const log = await execa('git', ['log', '--oneline'], { cwd: proj.path });
    expect(log.stdout).toContain('chore: start abc');
  });

  it('commits the seed files, because untracked files are invisible to the planner', async () => {
    /*
     * `fileTree` and `apiSurface` both read TRACKED files only. A project with
     * nothing committed reads as "(empty repo)" — so the planner would look at a
     * brand-new project and see nothing at all to work from.
     */
    const proj = project();
    await scaffold(proj);

    const files = await execa('git', ['ls-files'], { cwd: proj.path });
    expect(files.stdout.split('\n').sort()).toEqual([
      '.gitignore',
      'README.md',
      'docs/SPEC.md',
      // The stack's own marker. detectStacks reads these, and a project whose
      // stack cannot be detected is one validateTasks refuses work for.
      'pyproject.toml',
    ]);
  });

  it('commits a marker that makes this project its own stack', () => {
    /*
     * Measured on the first greenfield run, 2026-08-26. `sa new` wrote a
     * README, a .gitignore and a spec, and the decomposer's entire first
     * proposal came back rejected: "verify_cmd is a python check, but
     * example-receipts has no python project". True — nothing on disk said it
     * was one.
     */
    for (const stack of STACKS) {
      const seeded = stack.seed('demo');
      const paths = Object.keys(seeded);
      expect(paths.length, stack.id).toBeGreaterThan(0);
      expect(paths.some((p) => stack.markers.includes(p)), stack.id).toBe(true);
      for (const body of Object.values(seeded)) expect(body.length, stack.id).toBeGreaterThan(0);
    }
  });

  it('puts the project name in the files that carry a name', () => {
    // A package.json or a go.mod with the wrong module in it is worse than
    // none: every tool that reads it is then confidently wrong.
    for (const stack of STACKS) {
      const bodies = Object.values(stack.seed('my-project')).join('\n');
      if (/name|module/.test(bodies)) expect(bodies, stack.id).toContain('my-project');
    }
  });

  it('seeds nothing the floor cannot survive', async () => {
    /*
     * The floor has to pass on the repo `sa new` just made, marker included.
     * This is why the TypeScript seed is package.json alone and not the
     * tsconfig.json listed first in its markers: `tsc --noEmit` against a
     * tsconfig matching no files exits non-zero, which would fail the gate on
     * every task until the first .ts file landed.
     */
    const proj = project();
    await scaffold(proj);

    const { exitCode } = await execa(proj.stack.floor, {
      cwd: proj.path,
      shell: true,
      reject: false,
    });
    expect(exitCode).toBe(0);
  });

  it('writes the owner\'s own words into the project, where the planner reads them', async () => {
    const proj = project({ purpose: 'Turns receipts into a monthly summary.' });
    await scaffold(proj);
    expect(readFileSync(join(proj.path, 'docs', 'SPEC.md'), 'utf8')).toContain('receipts');
  });

  it('does not create a GitHub repository unless asked', async () => {
    const proj = project();
    const res = await scaffold(proj);
    expect(res.remote).toBeNull();
    expect(res.notes.join(' ')).toMatch(/stay on this machine/);
  });

  it('ignores the things no project should ever commit', async () => {
    const proj = project();
    await scaffold(proj);
    const ignore = readFileSync(join(proj.path, '.gitignore'), 'utf8');
    expect(ignore).toContain('.env');
    expect(ignore).toContain('__pycache__/');
  });
});

describe('the gate can pass on day one', () => {
  /*
   * The whole difficulty of starting a project: the gate is the guarantee, and
   * on an empty repo any check strict enough to be worth having fails before
   * the project exists.
   */
  it('every stack has a floor that passes on an empty repo', async () => {
    for (const stack of STACKS) {
      const proj = project({ id: 'x', path: join(scratch(), 'x'), stack });
      const res = await scaffold(proj);
      expect(res.verify_cmd).toBe(stack.floor);
    }
  });

  it('the python floor really does exit 0 on a fresh project', async () => {
    const proj = project({ stack: stackById('python')! });
    const res = await scaffold(proj);
    const run = await execa(res.verify_cmd, { cwd: proj.path, shell: true, reject: false });
    expect(run.exitCode, 'a gate that cannot pass blocks every task forever').toBe(0);
  });
});

describe('a gate that grows up with the project', () => {
  /*
   * example-api is why this exists. It was given a syntax check on 2026-08-07,
   * correctly — an empty repo has nothing to test. By 2026-08-09 it had 27
   * tests, THREE OF THEM FAILING, and the gate had waved every one of them
   * through for days, because nothing ever revisited the decision.
   */
  const python = stackById('python')!;

  it('says nothing while there are no tests', () => {
    const d = scratch();
    const s = suggestedGate(d, python, python.floor);
    expect(s.upgrade).toBe(false);
  });

  it('notices the day tests appear', () => {
    const d = scratch();
    mkdirSync(join(d, 'tests'), { recursive: true });
    writeFileSync(join(d, 'tests', 'test_health.py'), 'def test_x(): assert True\n');

    const s = suggestedGate(d, python, python.floor);
    expect(s.upgrade).toBe(true);
    expect(s.command).toBe(python.full);
    expect(s.reason).toMatch(/would still be saved/);
  });

  it('finds tests nested a few levels down, as a real suite is', () => {
    const d = scratch();
    mkdirSync(join(d, 'tests', 'api'), { recursive: true });
    writeFileSync(join(d, 'tests', 'api', 'test_documents.py'), 'x\n');
    expect(hasTests(d, python)).toBe(true);
  });

  it('stops suggesting once the check already runs them', () => {
    const d = scratch();
    mkdirSync(join(d, 'tests'), { recursive: true });
    writeFileSync(join(d, 'tests', 'test_a.py'), 'x\n');
    expect(suggestedGate(d, python, python.full).upgrade).toBe(false);
  });

  it('leaves a stricter hand-written gate alone', () => {
    // It will suggest TIGHTENING and never LOOSENING. A gate someone chose by
    // hand is theirs; the job here is to notice a floor that stopped being
    // adequate, not to have opinions about a considered decision.
    const d = scratch();
    mkdirSync(join(d, 'tests'), { recursive: true });
    writeFileSync(join(d, 'tests', 'test_a.py'), 'x\n');
    const custom = 'ruff check . && python -m pytest -q --strict-markers';
    expect(suggestedGate(d, python, custom).upgrade).toBe(false);
  });

  it('is not fooled by a folder merely called "tests" with nothing in it', () => {
    const d = scratch();
    mkdirSync(join(d, 'tests'), { recursive: true });
    expect(hasTests(d, python)).toBe(false);
  });
});

describe('the allowlist entry', () => {
  function reposFile(): string {
    const d = scratch();
    const f = join(d, 'repos.yaml');
    writeFileSync(
      f,
      ['# ALLOWLIST', 'repos:', '  - id: existing', '    path: D:/x', '', '  # --- add your other projects below ---', '  # - id: tradebot', ''].join('\n'),
    );
    return f;
  }

  it('adds the project so the system is allowed to touch it', () => {
    const f = reposFile();
    const proj = project();
    registerRepo(proj, 'python -m compileall .', f);
    expect(readFileSync(f, 'utf8')).toMatch(/- id: abc/);
  });

  it('keeps the comments, which is why this is not a YAML round-trip', () => {
    // That file is mostly comments recording why each value is what it is,
    // including the note about ShanAuto never listing itself.
    const f = reposFile();
    registerRepo(project(), 'x', f);
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('# ALLOWLIST');
    expect(out).toContain('# --- add your other projects below ---');
    expect(out).toContain('- id: existing');
  });

  it('puts it above the examples, so that block stays where it is useful', () => {
    const f = reposFile();
    registerRepo(project(), 'x', f);
    const out = readFileSync(f, 'utf8');
    expect(out.indexOf('- id: abc')).toBeLessThan(out.indexOf('add your other projects below'));
  });

  it('refuses to add the same project twice', () => {
    const f = reposFile();
    registerRepo(project(), 'x', f);
    expect(() => registerRepo(project(), 'x', f)).toThrow(/already in/);
  });

  it('writes the path with forward slashes, which is what the rest of the file uses', () => {
    const f = reposFile();
    registerRepo(project({ path: 'D:\\repos\\xyz\\abc' }), 'x', f);
    expect(readFileSync(f, 'utf8')).toContain('path: "D:/repos/xyz/abc"');
  });
});

describe('tightening a gate that has been outgrown', () => {
  /*
   * The other half of "a gate that grows up with the project" above. That
   * suite proves the SUGGESTION is right; until this existed, acting on it
   * meant the owner opening repos.yaml and editing a line by hand.
   *
   * For a project ShanAuto builds from an idea with nobody watching, that is
   * the whole gap: the first task writes tests, the gate stays a syntax check,
   * and broken tests ship for as long as the project lives. Which is precisely
   * what happened to example-api for three days.
   */
  const full = 'python -m compileall -q . && python -m pytest -q';

  function reposFile(eol = '\n'): string {
    const d = scratch();
    const f = join(d, 'repos.yaml');
    writeFileSync(
      f,
      [
        '# ALLOWLIST — every value here was chosen for a reason.',
        'repos:',
        '  - id: first',
        '    path: D:/x/first',
        '    # This project keeps a syntax-only check on purpose.',
        '    verify_cmd: "python -m compileall -q ."',
        '    enabled: true',
        '',
        '  - id: second',
        '    path: D:/x/second',
        '    # Starts as a syntax check because there is nothing here to test yet.',
        '    verify_cmd: "python -m compileall -q ."',
        '    enabled: true',
        '',
        '  # --- add your other projects below ---',
        '',
      ].join(eol),
    );
    return f;
  }

  it('points the named project at the stronger command', () => {
    const f = reposFile();
    expect(tightenGate('second', full, f)).toBe(true);

    const out = readFileSync(f, 'utf8');
    expect(out).toContain(`verify_cmd: "${full}"`);
  });

  it('changes that project and no other', () => {
    /*
     * The one that would have been silently wrong. A scan for the first
     * `verify_cmd:` in the file rewrites whichever project happens to be listed
     * first - someone else's gate, loosened or tightened without being asked,
     * while the project that grew the tests keeps its old one.
     */
    const f = reposFile();
    tightenGate('second', full, f);

    const out = readFileSync(f, 'utf8');
    const first = out.slice(out.indexOf('- id: first'), out.indexOf('- id: second'));
    expect(first).toContain('verify_cmd: "python -m compileall -q ."');
    expect(first).not.toContain('pytest');
  });

  it('keeps the comments that say why each value is what it is', () => {
    const f = reposFile();
    tightenGate('second', full, f);

    const out = readFileSync(f, 'utf8');
    expect(out).toContain('# ALLOWLIST — every value here was chosen for a reason.');
    expect(out).toContain('# This project keeps a syntax-only check on purpose.');
    expect(out).toContain('# --- add your other projects below ---');
  });

  it('keeps the indentation, so the file still parses', () => {
    const f = reposFile();
    tightenGate('second', full, f);
    expect(readFileSync(f, 'utf8')).toMatch(/^ {4}verify_cmd: /m);
  });

  it('quotes the command, which contains YAML-special characters', () => {
    // `&&` unquoted is not a string the loader will hand back intact.
    const f = reposFile();
    tightenGate('second', full, f);

    const parsed = readFileSync(f, 'utf8')
      .split('\n')
      .find((l) => l.includes('pytest'));
    expect(parsed?.trim()).toBe(`verify_cmd: "${full}"`);
  });

  it('writes back the line endings it found', () => {
    // repos.yaml is hand-edited on Windows; rewriting it LF-only turns every
    // line of somebody's file into a diff.
    const f = reposFile('\r\n');
    tightenGate('second', full, f);

    const raw = readFileSync(f, 'utf8');
    expect(raw.split('\r\n').length).toBeGreaterThan(10);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('says so rather than pretending, when the project is not listed', () => {
    const f = reposFile();
    expect(tightenGate('nobody', full, f)).toBe(false);
  });

  it('says so rather than pretending, when the entry has no check at all', () => {
    const d = scratch();
    const f = join(d, 'repos.yaml');
    writeFileSync(f, ['repos:', '  - id: bare', '    path: D:/x/bare', ''].join('\n'));

    expect(tightenGate('bare', full, f)).toBe(false);
  });

  it('does not reach into the next project when its own entry has no check', () => {
    // The scan has to stop at the next `- id:`. Running on would tighten the
    // following project instead and report success for the wrong repo.
    const d = scratch();
    const f = join(d, 'repos.yaml');
    writeFileSync(
      f,
      [
        'repos:',
        '  - id: bare',
        '    path: D:/x/bare',
        '  - id: next',
        '    path: D:/x/next',
        '    verify_cmd: "python -m compileall -q ."',
        '',
      ].join('\n'),
    );

    expect(tightenGate('bare', full, f)).toBe(false);
    expect(readFileSync(f, 'utf8')).not.toContain('pytest');
  });
});

/*
 * Finding AW, 2026-08-27. A project could be given a GitHub repository at the
 * moment it was created and never afterwards.
 *
 * `scaffold` takes `{ remote: true }` and calls `createRemote`. Miss that -
 * `sa new` without `--github`, or "not now" in the TUI - and there was no route
 * back from anywhere in the system. `doctor` reported `remote MISSING (commits
 * stay local)` on every run, and `hasRemote` had exactly one caller: that
 * diagnostic line. The state was visible and unreachable, which is the same
 * shape as the milestone stall and the blocked-jobs screen before it.
 *
 * The cost, measured: example-ledger held 8 commits of ShanAuto's own work and
 * example-receipts 7, none of it anywhere but one hard disk - against a project whose
 * package.json calls it an "Autonomous daily GitHub contribution system".
 */
describe('publishing a project that already exists', () => {
  it('refuses a folder that is not a git repository', async () => {
    // Nothing to push, and `gh repo create --source .` would make a repository
    // out of whatever happened to be sitting in that folder.
    const d = scratch();
    const { remote, notes } = await publishProject({ id: 'nope', path: d });

    expect(remote).toBeNull();
    expect(notes.join(' ')).toMatch(/not a git repository/);
  });

  it('says why, rather than failing silently', async () => {
    const d = scratch();
    const { notes } = await publishProject({ id: 'nope', path: d });
    expect(notes.length).toBeGreaterThan(0);
  });

  it('is private unless asked otherwise', () => {
    /*
     * Read off the source rather than by calling `gh`, which would create a
     * real repository under whoever is logged in. The default is the whole
     * safety property: creating a PUBLIC repo publishes the owner's work to the
     * internet under their name, and no default should choose that.
     */
    const src = readFileSync(join(process.cwd(), 'src/core/scaffold.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function publishProject'));
    expect(body.slice(0, 900)).toMatch(/opts\.visibility \?\? 'private'/);
  });

  it('asks gh for the visibility it was given, not a hardcoded one', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/scaffold.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function createRemote'));
    expect(body.slice(0, 1200)).toContain('`--${visibility}`');
  });

  it('pushes what the project already has, rather than creating an empty repo', () => {
    // `--source . --push` is what carries the existing commits up. Without it
    // the repository exists, the graph stays empty, and the work is still only
    // on one machine — which is the entire bug this closes.
    const src = readFileSync(join(process.cwd(), 'src/core/scaffold.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function createRemote'));
    expect(body.slice(0, 1200)).toContain("'--source', '.'");
    expect(body.slice(0, 1200)).toContain("'--push'");
    expect(body.slice(0, 1200)).toContain("'--remote', 'origin'");
  });

  it('carries on with a working local project when gh is missing', async () => {
    /*
     * Not having the GitHub CLI is an ordinary state, not a failure. The
     * project still builds, still commits, still passes its gate; only the
     * publishing is unavailable, and the note says so in those terms.
     */
    const src = readFileSync(join(process.cwd(), 'src/core/scaffold.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function createRemote'));
    expect(body).toMatch(/is not available.*no remote was created/s);
    expect(body).toMatch(/works fine without one/);
  });
});

/*
 * The default that was backwards, 2026-08-27.
 *
 * `--github` was opt-in, on the reasoning that creating a repository publishes
 * something under the owner's name. True, and it still made the wrong thing the
 * default for a program whose package.json describes it as an "Autonomous daily
 * GitHub contribution system". Two projects — 8 commits and 7 — were built to a
 * working state and stranded on one disk because the flag went unpassed.
 *
 * Read off the source rather than run, because exercising it would create a
 * real repository under whoever is logged in. What is pinned is the polarity:
 * absence of a flag now means publish, and only `--no-github` declines.
 */
describe('a new project is published by default', () => {
  const cli = (): string => readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

  it('asks for a remote unless told not to', () => {
    const src = cli();
    expect(src).toContain("remote: !rest.includes('--no-github')");
    // The old polarity must not creep back alongside it.
    expect(src).not.toContain("remote: rest.includes('--github')");
  });

  it('keeps it private, which is the part that must never flip', () => {
    const body = cli();
    const call = body.slice(body.indexOf('const result = await scaffold(proj'));
    expect(call.slice(0, 200)).toContain("visibility: 'private'");
  });

  it('tells the operator how to decline, not how to opt in', () => {
    // `.` rather than a negated newline class: JavaScript's dot already stops
    // at a line break without the `s` flag, and it survives a heredoc.
    expect(cli()).toMatch(/Usage: sa new.*--no-github/);
  });
});
