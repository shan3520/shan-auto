import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  isPlaceholder,
  wrongToolForStack,
  gateCannotCheck,
  tautologicalCheck,
  splitTopLevel,
  validateTasks,
  isUncheckedRemoval,
  refersToPath,
  assertsAbsence,
  removalTouches,
  selfCertifying,
  fitPrompt,
  wrongShellForHost} from '../planner.js';
import { repoSymbols, type RepoSymbols } from '../context.js';
import type { AppConfig } from '../../config.js';
import type { NormalizedTask, PlannedTask, Repo } from '../../schemas.js';

/**
 * The three plan-time guards, all of which exist because the same task got past
 * planning and cost a provider request before anyone could say what was wrong
 * with it. Every case below that is marked "real" is taken from the ledger.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: string[]): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'sa-guard-'));
  dirs.push(dir);
  for (const f of files) {
    if (f.endsWith('/')) mkdirSync(join(dir, f), { recursive: true });
    else writeFileSync(join(dir, f), '');
  }
  return { id: 'r1', path: dir, branch: 'main', stack: 'x', verify_cmd: 'true', enabled: true, weight: 1 } as Repo;
}

function task(over: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    title: 'Add health endpoint',
    kind: 'feature',
    instruction: 'Change app/api/health.py to return name.',
    acceptance: 'it responds',
    files_hint: [],
    verify_cmd: 'pytest -q',
    depends_on: [],
    est_lines: 20,
    executor_hint: 'cli',
    claim: { paths: [], symbols: [] },
    ...over,
  } as NormalizedTask;
}

describe('isPlaceholder: a task that restates the request', () => {
  it('catches the one that burned two dispatches', () => {
    // Tzyqrdo67z0, example-api, planned 2026-08-09. Two attempts, then diagnosed
    // by hand on 08-12 — the text of that diagnosis is still in last_error.
    expect(
      isPlaceholder(task({ instruction: 'Execute primary task specification according to project guidelines.' })),
    ).toBe(true);
  });

  it.each([
    // All real: two of these were COMMITTED, which is the worse outcome.
    'Implement a test case for daily commit ceiling limit enforcement in allocator.',
    'Implement test for scope blowout detection in verifier.',
    'Implement the actual pacing logic that utilizes PacingConfig settings.',
  ])('catches %s', (instruction) => {
    expect(isPlaceholder(task({ instruction }))).toBe(true);
  });

  it('leaves a real instruction alone, even a short one', () => {
    for (const instruction of [
      'Change app/api/health.py to return name instead of app_name.',
      'Implement the feature in src/auth/login.ts.',
      'Implement settings.PROJECT_NAME lookup.',
      'Do the primary task in `router.ts`.',
    ]) {
      expect(isPlaceholder(task({ instruction })), instruction).toBe(false);
    }
  });

  it('leaves a long instruction alone even with no path in it', () => {
    // Length is the tell: a placeholder is short because there is nothing in it.
    const instruction =
      'Implement a background worker that reads the queue, retries failed jobs with ' +
      'exponential backoff, and gives up after five attempts, recording the reason each time.';
    expect(isPlaceholder(task({ instruction }))).toBe(false);
  });

  it('leaves a long instruction alone even when it says "as described"', () => {
    /*
     * This is the case the 120-char bound is FOR, and the only one. The
     * `^implement|execute|...` branch caps itself at 88 characters, so dropping
     * the bound changes nothing there — a mutation removing it survived the
     * whole suite until this test existed. The "as described" / "according to
     * spec" / "primary task" branches have no cap of their own, and detailed
     * real instructions do end with a phrase like this.
     */
    const instruction =
      'Rework the queue consumer so it drains messages in order, applies backpressure ' +
      'when the worker pool is saturated, and retires poison messages as described';
    expect(instruction.length).toBeGreaterThan(120);
    expect(isPlaceholder(task({ instruction }))).toBe(false);
  });
});

describe('wrongToolForStack: a check that cannot run here', () => {
  it('rejects npm test where there is no package.json', () => {
    // Tzyqrdo67z0 again: `npm test` planned for example-api, which is python.
    expect(wrongToolForStack('npm test', repoWith(['pyproject.toml']))).toMatch(/package\.json/);
  });

  it('rejects the node -e check that surfaced as a permissions problem', () => {
    // Tphmpi8y4pq. What reached the operator was BLOCKED — advice to widen an
    // allow-list that was already correct.
    const cmd = `node -e "const fs=require('fs'); process.exit(fs.readFileSync('frontend/src/components/SearchBar.tsx','utf8').includes('group_id') ? 0 : 1)"`;
    expect(wrongToolForStack(cmd, repoWith(['app/', 'tests/']))).toMatch(/package\.json/);
  });

  it('rejects a python check where there is no python project', () => {
    expect(wrongToolForStack('python -m pytest -q', repoWith(['package.json']))).toMatch(/no python project/);
  });

  it('allows each where the project really is that stack', () => {
    expect(wrongToolForStack('npm test', repoWith(['package.json']))).toBeNull();
    expect(wrongToolForStack('python -m pytest -q', repoWith(['pyproject.toml']))).toBeNull();
    expect(wrongToolForStack('pytest -q', repoWith(['tests/']))).toBeNull();
  });

  it('says nothing about commands it cannot judge', () => {
    // A wrong guess here rejects real work, which costs more than letting an
    // odd-looking command through to the gate.
    const r = repoWith([]);
    expect(wrongToolForStack('make check', r)).toBeNull();
    expect(wrongToolForStack('cargo test', r)).toBeNull();
    expect(wrongToolForStack('./scripts/verify.sh', r)).toBeNull();
  });

  it('has no opinion when the folder is not there', () => {
    // "cannot tell" must never read as "wrong", or a repo that is not cloned
    // yet rejects every task planned for it.
    const gone = { id: 'r1', path: join(tmpdir(), 'sa-guard-does-not-exist') } as Repo;
    expect(wrongToolForStack('npm test', gone)).toBeNull();
    expect(wrongToolForStack('python -m pytest', gone)).toBeNull();
  });
});

describe('gateCannotCheck: work no check here could judge', () => {
  const gated = (verify_cmd: string, files: string[]) =>
    ({ ...repoWith(files), verify_cmd }) as Repo;

  it('rejects the two commits run 18 pushed unchecked', () => {
    // b5b81d1d and 2a5f7e3d, example-api: 391 lines of TypeScript into a repo
    // whose gate is compileall + pytest and which has no package.json at all.
    const repo = gated('python -m compileall -q . && python -m pytest -q', ['app/', 'tests/']);
    const n = task({
      files_hint: ['frontend/src/components/SearchBar.tsx'],
      verify_cmd: `python -c "content = open('frontend/src/components/SearchBar.tsx').read()"`,
    });
    expect(gateCannotCheck(n, repo)).toMatch(/TypeScript/);
  });

  it('names the repo check, so the reason is actionable', () => {
    const repo = gated('python -m pytest -q', ['tests/']);
    const why = gateCannotCheck(task({ files_hint: ['ui/App.tsx'] }), repo)!;
    expect(why).toContain('python -m pytest -q');
    expect(why).toContain('ui/App.tsx');
  });

  it('allows work the repo check can run', () => {
    expect(gateCannotCheck(task({ files_hint: ['app/api/health.py'] }), gated('pytest -q', ['tests/']))).toBeNull();
    expect(
      gateCannotCheck(task({ files_hint: ['src/core/planner.ts'], verify_cmd: 'npm test' }), gated('npm test', ['package.json'])),
    ).toBeNull();
  });

  it('accepts a task check that reaches the code the repo check cannot', () => {
    // The task may add its own check on top of the gate, and either one being
    // able to run the code is enough. This is how a python repo that grows a
    // frontend stops being blocked the day it has a runner for it.
    const repo = gated('python -m pytest -q', ['tests/']);
    const n = task({ files_hint: ['ui/App.tsx'], verify_cmd: 'cd ui && npx vitest run' });
    expect(gateCannotCheck(n, repo)).toBeNull();
  });

  it('still judges a gate that changes directory first', () => {
    // `cd api && pytest` is an ordinary shape, and a leading cd is navigation
    // rather than a check this table cannot name. Reading it as the latter
    // switches the guard off for every gate written that way.
    const repo = gated('cd api && python -m pytest -q', ['api/']);
    expect(gateCannotCheck(task({ files_hint: ['ui/App.tsx'] }), repo)).toMatch(/TypeScript/);
  });

  it('treats typescript and javascript as one ecosystem', () => {
    /*
     * `tsc` is the one entry in the table that belongs to typescript alone -
     * every other node tool is listed under both, because `npm test` names
     * neither and whatever it runs can check either. So a gate that is nothing
     * but a typecheck is where a .js file would otherwise be rejected for an
     * ecosystem mismatch with itself. phantomStacks makes the same union for
     * the same reason.
     */
    const repo = gated('tsc --noEmit', ['package.json']);
    expect(gateCannotCheck(task({ files_hint: ['src/util.js'] }), repo)).toBeNull();
    expect(gateCannotCheck(task({ files_hint: ['src/util.ts'] }), repo)).toBeNull();
  });

  it('says nothing about a command it cannot name', () => {
    // "Cannot tell" must never read as "wrong" — wrongToolForStack's rule, for
    // the same reason: a wrong guess here rejects real work.
    for (const cmd of ['make check', './scripts/verify.sh', 'cargo test'])
      expect(gateCannotCheck(task({ files_hint: ['ui/App.tsx'] }), gated(cmd, [])), cmd).toBeNull();
  });

  it('says nothing about a task with no code in its hint', () => {
    const repo = gated('pytest -q', ['tests/']);
    expect(gateCannotCheck(task({ files_hint: [] }), repo)).toBeNull();
    expect(gateCannotCheck(task({ files_hint: ['README.md', 'config/repos.yaml'] }), repo)).toBeNull();
  });

  it('leaves a half-judged task alone', () => {
    // .py and .tsx together is a weaker problem than this one, and refusing it
    // would block ordinary cross-cutting work.
    const repo = gated('pytest -q', ['tests/']);
    expect(gateCannotCheck(task({ files_hint: ['app/api/search.py', 'ui/App.tsx'] }), repo)).toBeNull();
  });

  it('is not fooled by a path inside the gate command', () => {
    // example-api's real gate excludes "[.]next", which an anywhere-search for
    // `next` reads as a Next.js build and credits with checking TypeScript.
    const repo = gated('python -m compileall -q -x "(node_modules|[.]venv|[.]next)" .', ['tests/']);
    expect(gateCannotCheck(task({ files_hint: ['ui/App.tsx'] }), repo)).toMatch(/TypeScript/);
  });
});

describe('tautologicalCheck: a check that restates the diff', () => {
  it('catches the one that let an unused dependency onto main', () => {
    // Real, and already cited in verifier.ts: the task's job was to add
    // better-sqlite3, so grepping for it passed by construction.
    expect(tautologicalCheck('grep -q "better-sqlite3" package.json')).toBe(true);
  });

  it.each([
    'grep -q "exportLedgerToCsv" src/ledger.ts',
    'grep -q "vitest" package.json',
    'grep -q "constructor" src/ledger.ts',
  ])('catches %s', (cmd) => {
    expect(tautologicalCheck(cmd)).toBe(true);
  });

  it('catches the interpreter spelling of the same thing', () => {
    expect(
      tautologicalCheck(`python -c "import sys; sys.exit(0 if 'count' in open('app/api/groups.py').read() else 1)"`),
    ).toBe(true);
    expect(
      tautologicalCheck(`node -e "process.exit(require('fs').readFileSync('a.ts','utf8').includes('x') ? 0 : 1)"`),
    ).toBe(true);
  });

  it('keeps an absence check, because no build can prove a removal', () => {
    // isUncheckedRemoval exists to DEMAND this shape. Rejecting it here would
    // leave removal tasks with no legal way to be verified at all.
    expect(tautologicalCheck('! grep -q "app_name" app/api/health.py')).toBe(false);
    expect(tautologicalCheck('grep -v "old_helper" src/util.ts')).toBe(false);
    expect(
      tautologicalCheck(`python -c "import sys; sys.exit(1 if 'app_name' in open('app/api/health.py').read() else 0)"`),
    ).toBe(false);
  });

  it('keeps a presence check that is composed with a real one', () => {
    // The common example-api shape: a fast precondition in front of the suite.
    expect(
      tautologicalCheck(
        `python -c "import sys; sys.exit(0 if 'count' in open('app/api/groups.py').read() else 1)" && python -m pytest -q tests/api/test_groups.py`,
      ),
    ).toBe(false);
    expect(tautologicalCheck('grep -q "vitest" package.json && npm test')).toBe(false);
  });

  it('keeps ordinary checks', () => {
    for (const cmd of [
      'npm test',
      'npm run typecheck',
      'python -m pytest tests/test_health.py',
      'npx vitest run src/core/__tests__/allocator.test.ts',
      `python -c "from app.main import create_app"`,
    ]) {
      expect(tautologicalCheck(cmd), cmd).toBe(false);
    }
  });

  it('catches the weakest spelling: the file exists', () => {
    /*
     * From-zero run, 2026-08-20. The milestone was refused three times for the
     * shapes above and then landed this one, which every guard here allowed. It
     * queued three tasks whose gate proved only that a file of that name had
     * been created — and in a repo gated by compileall + pytest, a .tsx file is
     * invisible to both, so nothing about the component had to work.
     */
    expect(
      tautologicalCheck(
        `python -c "import os; assert os.path.exists('frontend/src/components/UnansweredQueriesLeaderboard.tsx')"`,
      ),
    ).toBe(true);
    expect(tautologicalCheck(`node -e "process.exit(require('fs').existsSync('a.tsx') ? 0 : 1)"`)).toBe(true);
    expect(tautologicalCheck('test -f app/models/audit.py')).toBe(true);
    expect(tautologicalCheck(`python -c "import os; assert os.path.isfile('app/models/audit.py')"`)).toBe(true);
  });

  it('keeps a NON-existence check, for the same reason it keeps an absence one', () => {
    // "the file is gone" is the one question a presence test answers honestly,
    // and isUncheckedRemoval demands exactly this shape of a move task.
    expect(tautologicalCheck(`python -c "import os; assert not os.path.exists('app/old_search.py')"`)).toBe(false);
    expect(tautologicalCheck(`node -e "process.exit(require('fs').existsSync('a.ts') ? 1 : 0)"`)).toBe(false);
  });

  it('keeps an existence check standing in front of a real one', () => {
    expect(tautologicalCheck('test -f dist/bundle.js && npm test')).toBe(false);
    expect(
      tautologicalCheck(`python -c "import os; assert os.path.exists('app/models/audit.py')" && python -m pytest -q`),
    ).toBe(false);
  });
});

/*
 * Run 18 planned both of these and both were accepted. They assert that a
 * string appears in a file the task itself writes: `next` occurs in the shipped
 * component as `next-button`, `handleNext` and `nextPage`, so the check was
 * satisfied by the agent having typed the word.
 *
 * Every alternative in the substring rule named the read INSIDE the containment
 * test, so parking it in a variable first walked past all of them.
 */
describe('the substring tautology with the read in a variable', () => {
  it('catches both of the checks run 18 wrote', () => {
    expect(
      tautologicalCheck(
        `python -c "content = open('frontend/src/components/SearchBar.tsx').read(); assert 'items' in content, 'Frontend not updated'"`,
      ),
    ).toBe(true);
    expect(
      tautologicalCheck(
        `python -c "content = open('frontend/src/components/SearchBar.tsx').read().lower(); assert 'next' in content and 'previous' in content"`,
      ),
    ).toBe(true);
  });

  it('still allows the absence form, which proves a removal', () => {
    expect(
      tautologicalCheck(`python -c "c = open('src/old.py').read(); assert 'legacy_handler' not in c"`),
    ).toBe(false);
  });

  it('still allows it as a precondition in front of a real check', () => {
    expect(
      tautologicalCheck(
        `python -c "c = open('app/api/search.py').read(); assert 'limit' in c" && python -m pytest tests/api -q`,
      ),
    ).toBe(false);
  });

  it('still needs the file read, not just an assertion with in', () => {
    /*
     * The rule is about restating a diff by finding a string in the file the
     * task just wrote. An `assert ... in ...` over objects the command built by
     * importing real code is a different thing entirely, and every other test
     * here happens to read a file, so nothing was watching this half.
     */
    expect(
      tautologicalCheck(
        `python -c "from app.api import routes; assert 'search' in [r.path for r in routes.ROUTES]"`,
      ),
    ).toBe(false);
  });

  /*
   * Run 19, the third spelling. The read is in a variable and the containment
   * is handed to sys.exit, so neither `in open(...)` nor `assert ... in ...`
   * sees it - and the gate it produced proves only that the task wrote the
   * string it was told to write.
   */
  it('catches the containment handed to sys.exit', () => {
    expect(
      tautologicalCheck(
        `python -c "import sys; src = open('app/api/search.py').read(); sys.exit(0 if 'limit' in src else 1)"`,
      ),
    ).toBe(true);
  });

  it('catches it however the verdict is spelled', () => {
    // The point of matching on the verdict rather than on the verb is that
    // this list is closed. If a fourth spelling of "make the command fail"
    // turns up, it belongs here; a fourth spelling of "read a file" does not
    // need anything.
    const spellings = [
      `python -c "import sys; c = open('a.py').read(); sys.exit(0 if 'x' in c else 1)"`,
      `python -c "c = open('a.py').read(); raise SystemExit(0 if 'x' in c else 1)"`,
      `node -e "const c = require('fs').readFileSync('a.ts','utf8'); if (!('x' in c)) throw new Error('no')"`,
      `python -c "c = open('a.py').read(); exit(0 if 'x' in c else 1)"`,
      `python -c "import os; c = open('a.py').read(); os._exit(0 if 'x' in c else 1)"`,
    ];
    for (const cmd of spellings) expect(tautologicalCheck(cmd), cmd).toBe(true);
  });

  it('leaves a containment alone when it decides nothing', () => {
    /*
     * The same shape as the tautology above and a real check: the verdict is
     * the line count, and the containment is printed for a human to read. This
     * is the case the old `assert`-matching rule was built around, and it is
     * why the new rule matches the verdict rather than dropping the verb
     * altogether - without it, this is refused.
     */
    expect(
      tautologicalCheck(
        `python -c "c = open('app/api/search.py').read(); assert c.count('def ') >= 3; print('limit' in c)"`,
      ),
    ).toBe(false);
  });

  it('does not let a verdict in one statement vouch for an in in another', () => {
    // `sys.exit` is the last statement and the containment is two before it.
    // A whole-command match would read them as one assertion; they are not.
    expect(
      tautologicalCheck(
        `python -c "import sys; c = open('a.py').read(); print('x' in c); sys.exit(0 if c.count('def ') >= 3 else 1)"`,
      ),
    ).toBe(false);
  });

  it('does not reach across a statement boundary for an unrelated in', () => {
    /*
     * The assertion here is about SIZE, and the `in` belongs to a print two
     * statements later. `[^;]*` stops at the semicolon so the two are never
     * read as one; without it this legitimate check is rejected as a tautology.
     *
     * The command has to read a file, or `readsAFile` is false and the regex is
     * never consulted at all - which is how the first version of this test came
     * to pass whatever the rule said.
     */
    expect(
      tautologicalCheck(
        `python -c "c = open('app/api/search.py').read(); assert c.count('def ') >= 3; print('limit' in c)"`,
      ),
    ).toBe(false);
  });
});

describe('isUncheckedRemoval: a move you cannot tell from a copy', () => {
  const move = (over: Partial<NormalizedTask>) =>
    task({ title: 'Relocate main.py to app/main.py', ...over });

  it('catches the relocation that verified its own destination', () => {
    // Tjuu2ucpja6, committed. `from app.main import create_app` proves the NEW
    // file works and says nothing about src/main.py, which is the whole failure.
    expect(
      isUncheckedRemoval(
        move({
          verify_cmd: `python -c "from app.main import create_app"`,
          files_hint: ['src/main.py', 'app/main.py', 'tests/test_main.py'],
        }),
      ),
    ).toBe(true);
  });

  /*
   * Path lists copied from the ledger rows, not trimmed to the interesting one.
   * That matters: each of these commands DOES name one of the task's paths — its
   * test file — and being named was the entire old bar. The mutation that swaps
   * `assertsAbsence` back for a mention survived until these carried the real
   * lists.
   */
  it.each([
    [
      'Relocate auth API module to app/api',
      'python -m pytest tests/test_auth.py',
      ['src/api/auth.py', 'app/api/auth.py', 'src/main.py', 'tests/test_auth.py'],
    ],
    [
      'Relocate health API module',
      'python -m pytest tests/test_health.py',
      ['src/api/health.py', 'app/api/health.py', 'src/main.py', 'tests/test_health.py'],
    ],
    [
      'Relocate provider_keys API module to app/api',
      'python -m pytest tests/api/test_provider_keys.py -q',
      ['src/api/provider_keys.py', 'app/api/provider_keys.py', 'src/main.py', 'tests/api/test_provider_keys.py'],
    ],
  ])('catches %s, which committed', (title, verify_cmd, files_hint) => {
    expect(isUncheckedRemoval(task({ title, verify_cmd, files_hint }))).toBe(true);
  });

  it('accepts the one task in the ledger that did it properly', () => {
    // Ti1t2owdt16 — the shape the rejection message now asks for.
    const cmd =
      `python -c "import os, sys; sys.exit(0 if os.path.exists('app/core/logging.py') ` +
      `and not os.path.exists('src/core/logging.py') else 1)"`;
    expect(
      isUncheckedRemoval(
        task({
          title: 'Relocate logging module to app/core',
          verify_cmd: cmd,
          files_hint: ['src/core/logging.py', 'app/core/logging.py'],
        }),
      ),
    ).toBe(false);
  });

  it('rejects a removal that names no paths at all', () => {
    // Used to be an unconditional free pass: "nothing named to check against"
    // was read as nothing to complain about. A task that proposes to delete
    // something and cannot say what is the least verifiable task there is.
    expect(isUncheckedRemoval(task({ title: 'Remove the legacy helpers', files_hint: [] }))).toBe(true);
  });

  it('leaves an HTTP DELETE endpoint alone', () => {
    // T79pw5wt9xe, PENDING right now: "Implement Group DELETE endpoint with
    // optional hard-delete" is a verb and a database row, not a file. Blocking
    // it would stall live backlog work.
    expect(
      isUncheckedRemoval(
        task({
          title: 'Implement Group DELETE endpoint with optional hard-delete',
          verify_cmd: 'python -m pytest -q tests/api/test_groups.py',
          files_hint: ['app/api/groups.py', 'tests/api/test_groups.py'],
        }),
      ),
    ).toBe(false);
  });

  it('leaves a task that removes nothing alone', () => {
    expect(isUncheckedRemoval(task({ title: 'Add health endpoint', verify_cmd: 'pytest -q' }))).toBe(false);
  });
});

describe('refersToPath: letters in common are not a check', () => {
  it('no longer lets a test file answer for the source it tests', () => {
    // Three relocations committed on exactly this collision: `auth.py` appears
    // inside `test_auth.py`, so the guard believed the source was checked.
    expect(refersToPath('python -m pytest tests/test_auth.py', 'src/api/auth.py')).toBe(false);
    expect(refersToPath('python -m pytest tests/test_health.py', 'src/api/health.py')).toBe(false);
  });

  it('still finds a real reference, by full path or by basename', () => {
    expect(refersToPath(`not os.path.exists('src/api/auth.py')`, 'src/api/auth.py')).toBe(true);
    expect(refersToPath(`test -f auth.py`, 'src/api/auth.py')).toBe(true);
    expect(refersToPath(`ls src\\api\\auth.py`, 'src/api/auth.py')).toBe(true);
  });

  it('does not read a dotted module path as a filesystem path', () => {
    // Tjuu2ucpja6's own verify_cmd. `app.main` is an import, and an import
    // proves nothing about whether a file still sits on disk.
    expect(refersToPath('python -c "from app.main import create_app"', 'app/api/health.py')).toBe(false);
  });

  it('does not match a directory whose name is only a prefix of another', () => {
    expect(refersToPath('python -m pytest srcutils/test_x.py', 'src/main.py')).toBe(false);
  });

  it('does not let a short directory name be found inside an unrelated path', () => {
    expect(refersToPath('python -m pytest tests/api/test_x.py', 'src/api/auth.py')).toBe(false);
    // Same letters, same slashes, different directory: `tests/api` is not
    // `src/api`, and a three-letter basename is too little to tell them apart.
    expect(refersToPath('python -m pytest tests/api/test_x.py', 'src/api/')).toBe(false);
  });

  it('will not match on a stub of a name', () => {
    // The old floor was "any segment over two characters", which let `api`
    // match anything containing the letters a-p-i.
    expect(refersToPath('python -m pytest tests/rapid.py', 'src/api/')).toBe(false);
  });
});

describe('assertsAbsence: gone, not merely mentioned', () => {
  const moved = `python -c "import os, sys; sys.exit(0 if os.path.exists('app/core/logging.py') and not os.path.exists('src/core/logging.py') else 1)"`;

  it('tells the source from the destination in the same command', () => {
    expect(assertsAbsence(moved, 'src/core/logging.py')).toBe(true);
    expect(assertsAbsence(moved, 'app/core/logging.py')).toBe(false);
  });

  it.each([
    `! test -f src/old.py`,
    `python -c "import os,sys; sys.exit(1 if os.path.exists('src/old.py') else 0)"`,
    `test ! -e src/old.py`,
  ])('accepts %s', (cmd) => {
    expect(assertsAbsence(cmd, 'src/old.py')).toBe(true);
  });

  it('does not read an unrelated negation elsewhere as an absence check', () => {
    // `-k "not slow"` must not certify that anything was deleted.
    expect(assertsAbsence('python -m pytest -k "not slow" tests/test_old.py', 'tests/test_old.py')).toBe(false);
  });

  it('does not let a negation reach across a command separator', () => {
    // The `!` belongs to the first command. The second merely names the path.
    expect(assertsAbsence('test ! -f app/new.py && python -m pytest src/old.py', 'src/old.py')).toBe(false);
  });

  it('does not let a negation reach across half a line of unrelated arguments', () => {
    const far = 'test ! -f app/some/long/destination/path.py -a -f src/old.py';
    expect(assertsAbsence(far, 'src/old.py')).toBe(false);
  });

  it('accepts an absence check on a parent directory', () => {
    // Tighter than naming the file: if `src` is gone, so is everything in it.
    const cmd = `python -c "import os,sys; sys.exit(1 if os.path.exists('src') else 0)"`;
    expect(assertsAbsence(cmd, 'src/main.py')).toBe(true);
  });

  it('is false when the path is not referred to at all', () => {
    expect(assertsAbsence('npm run typecheck', 'src/old.ts')).toBe(false);
  });
});

describe('validateTasks actually applies them', () => {
  const cfg = {
    system: { limits: { max_files_per_task: 4 } },
  } as unknown as AppConfig;

  const proposal = (over: Partial<PlannedTask> = {}): PlannedTask =>
    ({
      title: 'Add health endpoint',
      kind: 'feature',
      instruction: 'Change app/api/health.py to return name.',
      acceptance: 'it responds',
      files_hint: [],
      verify_cmd: 'pytest -q',
      depends_on: [],
      est_lines: 20,
      executor_hint: 'cli',
      ...over,
    }) as PlannedTask;

  it('drops a placeholder and says why', () => {
    const rejected: string[] = [];
    const kept = validateTasks(
      cfg,
      [proposal({ instruction: 'Execute primary task specification according to project guidelines.' })],
      rejected,
    );
    expect(kept).toHaveLength(0);
    expect(rejected.join()).toMatch(/placeholder/);
  });

  it('drops work no check in the repo could judge, and only with the repo', () => {
    const repo = { ...repoWith(['tests/']), verify_cmd: 'pytest -q' } as Repo;
    const p = proposal({ files_hint: ['frontend/src/components/SearchBar.tsx'], verify_cmd: 'pytest -q' });
    const without: string[] = [];
    expect(validateTasks(cfg, [p], without, new Set())).toHaveLength(1);
    expect(without).toEqual([]);
    const withRepo: string[] = [];
    expect(validateTasks(cfg, [p], withRepo, new Set(), repo)).toHaveLength(0);
    expect(withRepo.join()).toMatch(/TypeScript/);
  });

  it('drops a wrong-stack check only when it was given the repo', () => {
    const repo = repoWith(['pyproject.toml']);
    const withRepo: string[] = [];
    expect(validateTasks(cfg, [proposal({ verify_cmd: 'npm test' })], withRepo, new Set(), repo)).toHaveLength(0);
    expect(withRepo.join()).toMatch(/package\.json/);

    // Omitting the repo must not change any existing caller's behaviour.
    const withoutRepo: string[] = [];
    expect(validateTasks(cfg, [proposal({ verify_cmd: 'npm test' })], withoutRepo)).toHaveLength(1);
    expect(withoutRepo).toHaveLength(0);
  });

  it('drops a task that gates itself with a script it will write', () => {
    /*
     * Through validateTasks, not by calling the guard directly. Deleting the
     * call from the pipeline left every other test in this file green - mutant
     * Q7, and the same shape as M10/M11 and N12-N14 before it: the rule was
     * proven, and nothing proved anyone applied it.
     */
    const rejected: string[] = [];
    const kept = validateTasks(
      cfg,
      [proposal({ verify_cmd: 'bash test_summary.sh' })],
      rejected,
    );

    expect(kept).toHaveLength(0);
    expect(rejected.join()).toMatch(/runs a script from inside the repo/);
  });

  it('needs no repo to make that call, unlike the stack guards', () => {
    // wrongToolForStack and gateCannotCheck both go quiet without a repo,
    // because both reason about what is on disk. This one reads the command
    // and nothing else, so a caller that omits the repo is still protected -
    // which matters, because that is the caller the run-27 tasks went through.
    const rejected: string[] = [];
    expect(validateTasks(cfg, [proposal({ verify_cmd: './check.sh' })], rejected)).toHaveLength(0);
    expect(rejected.join()).toMatch(/runs a script from inside the repo/);
  });

  it('keeps a task whose check names a real runner', () => {
    const rejected: string[] = [];
    expect(
      validateTasks(cfg, [proposal({ verify_cmd: 'python -m pytest -q tests/test_x.py' })], rejected),
    ).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it('drops a tautological check and says what to write instead', () => {
    const rejected: string[] = [];
    const kept = validateTasks(
      cfg,
      [proposal({ verify_cmd: 'grep -q "better-sqlite3" package.json' })],
      rejected,
    );
    expect(kept).toHaveLength(0);
    expect(rejected.join()).toMatch(/diff already shows/);
  });

  it('exempts a docs task, which has no test to write instead', () => {
    // T9br2odsz0a, real: `grep -q "export-csv" README.md`. The only one of the
    // seven the guard flags that it should not — there is no suite that can
    // prove a README paragraph, so rejecting it makes the task unplannable.
    const rejected: string[] = [];
    const kept = validateTasks(
      cfg,
      [proposal({ kind: 'docs', verify_cmd: 'grep -q "export-csv" README.md' })],
      rejected,
    );
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('keeps a task all three guards are happy with', () => {
    const rejected: string[] = [];
    const kept = validateTasks(cfg, [proposal()], rejected, new Set(), repoWith(['tests/']));
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });
});

/*
 * From-zero re-run, 2026-08-20. `tautologicalCheck` returned false for any
 * command containing `&&`, on the reasoning that a presence test composed with
 * a real check is a precondition rather than the check. True — but nothing
 * verified the other half was real, so the planner landed
 *
 *     test -f frontend/package.json && test -f frontend/vitest.config.ts
 *
 * two tautologies vouching for one another, in the same pass that refused the
 * single-part spelling of the identical assertion. Caught by reading the queued
 * tasks after planning, not by the suite.
 */
describe('a composition of nothing but presence tests', () => {
  it('is still tautological, however many parts it has', () => {
    expect(tautologicalCheck('test -f frontend/package.json && test -f frontend/vitest.config.ts')).toBe(true);
    expect(
      tautologicalCheck('test -f a.tsx && test -f b.tsx && test -f c.tsx'),
    ).toBe(true);
  });

  it('is caught in the exact spelling the planner produced', () => {
    const live = 'test -f frontend/src/app/admin/analytics/page.tsx && test -f frontend/src/app/admin/analytics/page.test.tsx';
    expect(tautologicalCheck(live)).toBe(true);
  });

  it('still lets a presence test stand in front of a REAL check', () => {
    // The whole point of the exemption, and it has to survive the fix.
    expect(tautologicalCheck('test -f tests/test_x.py && python -m pytest -q tests/test_x.py')).toBe(false);
    expect(tautologicalCheck('grep -q foo app.py && npm test')).toBe(false);
  });

  it('keeps an absence assertion exempt even when composed', () => {
    expect(tautologicalCheck('test -f new.py && ! test -f old.py')).toBe(false);
  });
});

describe('splitTopLevel', () => {
  it('splits on the operators a shell would', () => {
    expect(splitTopLevel('a && b')).toEqual(['a', 'b']);
    expect(splitTopLevel('a || b && c')).toEqual(['a', 'b', 'c']);
  });

  it('leaves && inside quotes alone, so a program is not cut in half', () => {
    expect(splitTopLevel('pytest -k "a && b"')).toEqual(['pytest -k "a && b"']);
    expect(splitTopLevel("python -c 'x && y'")).toEqual(["python -c 'x && y'"]);
  });

  it('drops the empty pieces a trailing operator leaves behind', () => {
    expect(splitTopLevel('a && ')).toEqual(['a']);
  });
});

/*
 * Run 12 planned Tp9l0zbr6pl: change /api/unanswered-queries/frequent from a
 * bare list to `{data, message}`. That endpoint was committed, had tests, and
 * the task's own instruction included rewriting them to match. Nothing in the
 * plan, the kind, or the brief said the shape was moving, and the one gate that
 * could have caught it — TEST_TAMPER — exempts a test file the planner
 * declared, which this one was.
 *
 * The fix is a declaration, so these are about the declaration surviving intact
 * from the model's answer to the row in the database.
 */
describe('a task that changes what already works says so', () => {
  const planned = (over: Partial<PlannedTask> = {}): PlannedTask =>
    ({
      title: 'Return frequent queries in an envelope',
      kind: 'feature',
      instruction: 'Change app/api/unanswered.py to wrap the list in {data, message}.',
      acceptance: 'the endpoint returns an object with a data key',
      files_hint: [],
      verify_cmd: 'pytest -q',
      depends_on: [],
      est_lines: 20,
      executor_hint: 'cli',
      ...over,
    }) as PlannedTask;

  const cfg = { system: { limits: { max_files_per_task: 8 } } } as unknown as AppConfig;
  const keep = (t: PlannedTask): NormalizedTask[] => validateTasks(cfg, [t], [], new Set<string>());

  it('carries the declaration through to the task that gets dispatched', () => {
    const out = keep(planned({ breaking: 'callers that index the response break' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.breaking).toBe('callers that index the response break');
  });

  it('leaves a task that declares nothing with nothing', () => {
    expect(keep(planned())[0]!.breaking).toBeUndefined();
  });

  /*
   * Models answer an optional field with "" far more often than they omit it,
   * and an empty string is not the same value downstream: the review renders
   * `DECLARED BREAKING:` followed by nothing, which reads as a declaration that
   * says nothing rather than as no declaration at all.
   */
  it('treats an empty or blank declaration as no declaration', () => {
    for (const blank of ['', '   ', '\n\t'])
      expect(keep(planned({ breaking: blank }))[0]!.breaking, JSON.stringify(blank)).toBeUndefined();
  });

  it('does not reject the task for declaring one', () => {
    // The whole point is that saying so is free. A guard that punished the
    // declaration would teach the planner to stop making it.
    const rejected: string[] = [];
    const out = validateTasks(cfg, [planned({ breaking: 'the response shape changes' })], rejected, new Set<string>());
    expect(rejected).toEqual([]);
    expect(out).toHaveLength(1);
  });
});

/*
 * The index the removal guard reads. Its bounds matter as much as its answers:
 * past either one it returns null and the guard above it stops asking, and a
 * guard that has quietly stopped asking is the failure this project keeps
 * finding in its own code.
 */
describe('repoSymbols', () => {
  const treeWith = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-index-'));
    dirs.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return dir;
  };

  const RAGFORGE = {
    'app/services/document_search.py':
      'def search_documents(docs, q):\n    return []\n\ndef search_documents_paginated(docs, q, page):\n    return []\n',
    'app/api/search.py': 'from app.services.document_search import search_documents\n',
    'tests/db/test_search_logs.py': 'from app.services.document_search import search_documents\n',
    'tests/services/test_hybrid.py': 'from app.services.hybrid import combine_scores\n',
  };

  it('says where a name is declared and everywhere it is named', () => {
    const sym = repoSymbols(treeWith(RAGFORGE))!;
    expect(sym).not.toBeNull();
    expect(sym.declaredIn('search_documents')).toEqual(['app/services/document_search.py']);
    expect(sym.usedIn('search_documents').sort()).toEqual([
      'app/api/search.py',
      'app/services/document_search.py',
      'tests/db/test_search_logs.py',
    ]);
  });

  it('does not read a longer name as this one', () => {
    /*
     * The whole guard turns on this. `search_documents_paginated` is the
     * function being kept, and a substring match would report every file that
     * uses it as a file broken by deleting `search_documents`.
     */
    const sym = repoSymbols(treeWith({ 'a/b.py': 'search_documents_paginated(x)\n' }))!;
    expect(sym.usedIn('search_documents')).toEqual([]);
    expect(sym.usedIn('search_documents_paginated')).toEqual(['a/b.py']);
  });

  it('never compiles a lookup that is not an identifier', () => {
    // `.*` matches every file ever written. The caller filters too; this is the
    // half that cannot be forgotten.
    const sym = repoSymbols(treeWith({ 'a/b.py': 'def anything():\n    pass\n' }))!;
    expect(sym.usedIn('.*')).toEqual([]);
    expect(sym.usedIn('')).toEqual([]);
  });

  it('stays out of directories that hold other people code', () => {
    const sym = repoSymbols(
      treeWith({
        'app/real.py': 'def helper():\n    pass\n',
        'node_modules/pkg/index.js': 'export function helper() {}\n',
        '.venv/lib/thing.py': 'def helper():\n    pass\n',
        // Not in any skip list by name — pruned for the dot, like .git.
        '.pytest_cache/v/thing.py': 'def helper():\n    pass\n',
        'dist/bundle.js': 'export function helper() {}\n',
      }),
    )!;
    expect(sym.usedIn('helper')).toEqual(['app/real.py']);
  });

  it('reads only what it can parse declarations out of', () => {
    const sym = repoSymbols(
      treeWith({ 'app/a.py': 'def helper():\n    pass\n', 'README.md': 'call helper() first\n' }),
    )!;
    expect(sym.usedIn('helper')).toEqual(['app/a.py']);
  });

  it('gives up rather than answer from half a repo', () => {
    /*
     * Null, not a partial index. Every caller asks "what else references this",
     * and a repo read halfway answers that with a silence that reads exactly
     * like "nothing does" — which would turn this guard off in precisely the
     * large repos where a removal has the most callers to miss.
     */
    const tree = treeWith({ 'a/one.py': 'def x():\n    pass\n', 'a/two.py': 'def y():\n    pass\n' });
    expect(repoSymbols(tree, 1)).toBeNull();
    expect(repoSymbols(tree, 4000, 4)).toBeNull();
    expect(repoSymbols(tree)).not.toBeNull();
  });
});

/*
 * Run 20, task Txx94bp0tzs. The plan said to delete `search_documents` and
 * named four files; a fifth imported it. The agent could leave the build broken
 * or edit a test it had not been sent to edit, and the gate rejected it for the
 * second. Everything downstream behaved correctly. The plan was the fault.
 */
describe('a removal has to name the files that still call the thing', () => {
  const index = (decl: Record<string, string[]>, uses: Record<string, string[]>): RepoSymbols => ({
    declaredIn: (s) => decl[s] ?? [],
    usedIn: (s) => uses[s] ?? [],
  });

  // What the tree actually contains, taken from example-api on 2026-08-23.
  const search = index(
    { search_documents: ['app/services/document_search.py'] },
    {
      search_documents: [
        'app/api/search.py',
        'app/services/document_search.py',
        'tests/db/test_search_logs.py',
        'tests/services/test_document_search.py',
      ],
    },
  );

  const REAL =
    'In `app/api/search.py`, update `search_user_documents` to call ' +
    '`search_documents_paginated`. In `app/services/document_search.py`, drop the ' +
    '`search_documents` function. Update all related tests in `tests/api/test_search.py` ' +
    'and `tests/services/test_document_search.py` to assert the paginated response.';

  const HINT = [
    'app/api/search.py',
    'app/services/document_search.py',
    'tests/api/test_search.py',
    'tests/services/test_document_search.py',
  ];

  const task = (over: Partial<NormalizedTask> = {}): NormalizedTask =>
    ({ instruction: REAL, files_hint: HINT, ...over }) as NormalizedTask;

  it('finds the caller the plan left out, past the dots in a filename', () => {
    /*
     * The path in the same sentence is the whole difficulty. Split the
     * instruction on '.' and `document_search.py` comes apart, every backtick
     * after it pairs with the wrong one, and the symbol is never seen — which
     * is how the first version of this guard read the very task it was written
     * for and found nothing.
     */
    expect(removalTouches(task(), search)).toContain('tests/db/test_search_logs.py');
  });

  it('ignores a name this repo does not declare', () => {
    // Real, from the same run: `offset` and `limit` are parameters. A guard
    // that demanded every file naming `limit` would reject half the backlog.
    const bare = index({}, { limit: ['app/api/search.py'], offset: ['app/api/search.py'] });
    const n = task({ instruction: 'Remove the `offset` and `limit` parameters from the query.' });
    expect(removalTouches(n, bare)).toEqual([]);
  });

  it('does not read the place a removal happens as the thing removed', () => {
    /*
     * Also real, and in the backlog right now: task Tgo15zd4vh2 removes two
     * parameters FROM `combine_scores`, which it is keeping. Reading the
     * function as the object of the verb demanded every one of its callers.
     */
    const hybrid = index(
      { combine_scores: ['app/services/hybrid_search.py'] },
      { combine_scores: ['app/api/search.py', 'app/services/hybrid_search.py'] },
    );
    const n = task({
      instruction:
        'Remove the `offset` and `limit` parameters and internal list slicing logic from ' +
        '`combine_scores` in `app/services/hybrid_search.py`.',
      files_hint: ['app/services/hybrid_search.py'],
    });
    expect(removalTouches(n, hybrid)).toEqual([]);
  });

  it('leaves alone a symbol declared somewhere this task never opens', () => {
    // Not this task's to delete, whatever the sentence says.
    const elsewhere = index(
      { search_documents: ['vendor/other/search.py'] },
      { search_documents: ['app/api/search.py', 'vendor/other/search.py'] },
    );
    expect(removalTouches(task(), elsewhere)).toEqual([]);
  });

  it('keeps a filename whole when it stands next to the symbol', () => {
    /*
     * The dot in `document_search.py` is inside a name, and cutting the
     * sentence there leaves every backtick after it paired with the wrong one —
     * so the symbol is never seen at all. That is the fault the first version
     * of this guard shipped with, and no unit test found it: the ledger did.
     */
    const n = task({ instruction: "Delete `document_search.py`'s `search_documents` function." });
    expect(removalTouches(n, search)).toContain('tests/db/test_search_logs.py');
  });

  it('reads every preposition that turns the next name into a place', () => {
    // Three spellings of the same sentence, and `combine_scores` is the place
    // in all three.
    const hybrid = index(
      { combine_scores: ['app/services/hybrid_search.py'] },
      { combine_scores: ['app/api/search.py', 'app/services/hybrid_search.py'] },
    );
    for (const prep of ['from', 'in', 'of']) {
      const n = task({
        instruction: `Remove the \`offset\` parameter ${prep} \`combine_scores\`.`,
        files_hint: ['app/services/hybrid_search.py'],
      });
      expect(removalTouches(n, hybrid), prep).toEqual([]);
    }
  });

  it('does not carry a verb from one sentence into the next', () => {
    /*
     * Sentences are separated for a reason: a removal in one says nothing
     * about a name in another. Read whole, this instruction removes a file and
     * keeps the function, and demanding every caller of the function would be
     * a rejection with no way out.
     */
    const n = task({
      instruction: 'Delete the stray fixture file. Update `search_documents` to take a page.',
    });
    expect(removalTouches(n, search)).toEqual([]);
  });

  it('reads a name written as a call', () => {
    // `drop the `search_documents()` helper` is the same instruction with the
    // parentheses a brief habitually types.
    const n = task({ instruction: 'In app/services, drop the `search_documents()` helper.' });
    expect(removalTouches(n, search)).toContain('tests/db/test_search_logs.py');
  });

  it('needs a verb that actually removes something', () => {
    const n = task({ instruction: 'Update `search_documents` to take a page and a page size.' });
    expect(removalTouches(n, search)).toEqual([]);
  });

  describe('and validateTasks acts on it', () => {
    const cfg = {
      system: { limits: { max_files_per_task: 4, scope_blowout_multiplier: 2 } },
    } as unknown as AppConfig;

    const proposal = (over: Partial<PlannedTask> = {}): PlannedTask =>
      ({
        title: 'Refactor search to use pagination exclusively',
        kind: 'refactor',
        instruction: REAL,
        acceptance: 'the endpoint returns a page',
        files_hint: HINT,
        verify_cmd: 'pytest -q',
        depends_on: [],
        est_lines: 30,
        executor_hint: 'cli',
        ...over,
      }) as PlannedTask;

    it('rejects the plan and names the file to add', () => {
      const rejected: string[] = [];
      const kept = validateTasks(cfg, [proposal()], rejected, new Set<string>(), undefined, search);
      expect(kept).toHaveLength(0);
      expect(rejected.join()).toContain('tests/db/test_search_logs.py');
      expect(rejected.join()).toMatch(/files_hint/);
    });

    it('accepts it once that file is declared, over the cap or not', () => {
      /*
       * Five files where the limit is four. The limit exists to stop a task
       * taking on scope it chose; a file that breaks when the symbol goes is
       * not scope it chose, and rejecting this is what forced the four-file
       * plan that failed.
       */
      const rejected: string[] = [];
      const kept = validateTasks(
        cfg,
        [proposal({ files_hint: [...HINT, 'tests/db/test_search_logs.py'] })],
        rejected,
        new Set<string>(),
        undefined,
        search,
      );
      expect(rejected).toEqual([]);
      expect(kept).toHaveLength(1);
    });

    it('recognises a declared file however the plan spelled the path', () => {
      /*
       * No plan in 46 tasks has written a Windows path or a leading `./`, but
       * files_hint is a language model's prose, not this project's own code.
       * Spelling one of these two ways is the difference between accepting the
       * task and telling the operator to add a file that is already there.
       */
      const rejected: string[] = [];
      const kept = validateTasks(
        cfg,
        [proposal({ files_hint: [...HINT, '.\\tests\\db\\test_search_logs.py'] })],
        rejected,
        new Set<string>(),
        undefined,
        search,
      );
      expect(rejected).toEqual([]);
      expect(kept).toHaveLength(1);
    });

    it('still counts the files the task chose for itself', () => {
      /*
       * The exemption is for the fallout, not for the task. Four of the nine
       * below reference the symbol; the other five are this task's own idea,
       * and five is past the limit whatever else is going on.
       */
      const rejected: string[] = [];
      const kept = validateTasks(
        cfg,
        [
          proposal({
            files_hint: [
              ...HINT,
              'tests/db/test_search_logs.py',
              'app/api/routes.py',
              'app/api/a.py',
              'app/api/b.py',
              'app/api/c.py',
            ],
          }),
        ],
        rejected,
        new Set<string>(),
        undefined,
        search,
      );
      expect(kept).toHaveLength(0);
      expect(rejected.join()).toMatch(/limit 4/);
    });

    it('says so when the fallout is too large for one commit', () => {
      const many = Array.from({ length: 9 }, (_, i) => `app/callers/c${i}.py`);
      const wide = index(
        { search_documents: ['app/services/document_search.py'] },
        { search_documents: ['app/services/document_search.py', ...many] },
      );
      const rejected: string[] = [];
      const kept = validateTasks(
        cfg,
        [proposal({ files_hint: ['app/services/document_search.py'] })],
        rejected,
        new Set<string>(),
        undefined,
        wide,
      );
      expect(kept).toHaveLength(0);
      expect(rejected.join()).toMatch(/more than one commit can carry/);
      // And it says what to do instead, which is the only reason to reject here
      // rather than let the agent discover it.
      expect(rejected.join()).toMatch(/own task/);
    });

    it('has no opinion when there is no index', () => {
      // A repo too large to index, or one that cannot be read. Same rule as the
      // stack checks above: a question that cannot be asked is not an answer.
      const rejected: string[] = [];
      expect(validateTasks(cfg, [proposal()], rejected, new Set<string>())).toHaveLength(1);
      expect(rejected).toEqual([]);
    });
  });
});

/*
 * Finding AT, from the first project ShanAuto built from nothing.
 *
 * `example-receipts` was created as a python project. The decomposer gave seven of its
 * eight tasks the same check - `bash test_summary.sh` - and the agent doing the
 * work wrote `test_summary.sh`. Five commits went in unattended, each verified
 * by a file its own author had just edited, and the last dispatch rewrote that
 * file to 13KB while the task it was meant to be proving was still open.
 *
 * The rule was already written down, one scope too narrow. `registerRepo` has
 * said since scaffolding existed, about the REPO's gate: "It must NOT be a
 * script inside the repo: an agent can edit those, and a gate an agent can edit
 * is not a gate." Nothing said it about the check a task brings with it - which
 * is the one a model chooses.
 */
describe('a check the agent can rewrite is not a check', () => {
  it('refuses a task that gates itself with a shell script', () => {
    expect(selfCertifying('bash test_summary.sh')).toMatch(/runs a script from inside the repo/);
  });

  it('names the fix rather than only the fault', () => {
    // A rejection the decomposer cannot act on costs a whole planning pass.
    const why = selfCertifying('bash test_summary.sh') ?? '';
    expect(why).toMatch(/Name the test runner instead/);
    expect(why).toMatch(/pytest/);
    expect(why).toMatch(/not in a shell script/);
  });

  it('catches every shell that can be handed a file', () => {
    // Three of these spell the same trick on Windows.
    for (const cmd of [
      'sh run_tests.sh',
      'zsh t.sh',
      'dash t.sh',
      'ksh t.sh',
      'source setup.sh',
      '. ./setup.sh',
      'cmd /c test.bat',
      'cmd.exe /c test.bat',
      'powershell -File test.ps1',
      'pwsh -File test.ps1',
    ])
      expect(selfCertifying(cmd), cmd).not.toBeNull();
  });

  it('catches a script run without a shell in front of it', () => {
    for (const cmd of ['./test.sh', '../scripts/check.sh', '.\\test.ps1'])
      expect(selfCertifying(cmd), cmd).not.toBeNull();
  });

  it('catches it in any part of a compound command', () => {
    // The shape that would otherwise walk straight through: a real tool first,
    // the self-written script second, and only the head word inspected.
    expect(selfCertifying('python -m compileall -q . && bash test_summary.sh')).not.toBeNull();
    expect(selfCertifying('cd app && bash t.sh')).not.toBeNull();
  });

  it('lets a test runner load a test file, which is the thing being asked for', () => {
    /*
     * The distinction the guard turns on. A runner given a path is tooling
     * doing its job and the file it loads is a test - which is exactly what the
     * task is supposed to produce. What is refused is handing a shell an
     * arbitrary script and calling the result a verdict.
     */
    for (const cmd of [
      'python -m pytest -q',
      'python -m pytest -q tests/test_summary.py',
      'python -m unittest test_compare.py',
      'pytest tests/',
      'npm test',
      'npx vitest run src/x.test.ts',
      'go test ./...',
      'python -m compileall -q . && python -m pytest -q',
      'cd frontend && npm test',
    ])
      expect(selfCertifying(cmd), cmd).toBeNull();
  });

  it('says nothing about a bare cd, which is navigation', () => {
    expect(selfCertifying('cd tests')).toBeNull();
  });

  it('is not fooled by a tool whose name merely starts with a shell name', () => {
    // `shellcheck` begins with `sh`. The regex is anchored with a word
    // boundary written as (\s|$), the way GATE_TOOLS is, for this reason.
    expect(selfCertifying('shellcheck summary.sh')).toBeNull();
    expect(selfCertifying('bashate x')).toBeNull();
  });
});

/*
 * What the trimmer spends first, 2026-08-27.
 *
 * `fitPrompt` sets `keep = length - overage - 80`, so a section smaller than
 * the overage is emptied outright while a larger one is only shortened. With
 * COMPLETED (158-345 chars) and RESOLVED (<=2000) ahead of TREE (~4,900), the
 * trimmer was destroying the sections that cannot survive partial loss in order
 * to protect the only one that can.
 *
 * Measured over the runs of 2026-08-26/27: COMPLETED emptied to zero nine
 * times, TREE never once - only shortened.
 *
 * These tests are about the ORDER, which is a two-line array that anyone can
 * reshuffle in a refactor without a single other test noticing.
 */
describe('what the trimmer gives up first', () => {
  const big = (n: number, ch: string) => ch.repeat(n);

  /** Renders every section, so cost is the sum plus a little framing. */
  const render = (s: Record<string, string>) =>
    Object.entries(s)
      .map(([k, v]) => `${k}:${v}`)
      .join('\n');

  const sections = () => ({
    JOURNAL: big(2500, 'j'),
    TREE: big(4900, 't'),
    RESOLVED: big(1800, 'r'),
    COMPLETED: big(300, 'c'),
    SYMBOLS: big(900, 's'),
  });

  it('takes the journal before anything else', () => {
    // Unchanged by the reorder, and the reason is unchanged too: it is the
    // largest block of pure commentary in the prompt.
    const out = fitPrompt(render, sections(), 8000);
    expect(out).not.toContain('jjj');
    expect(out).toContain('ccc');
  });

  it('shortens the file tree before emptying what already shipped', () => {
    /*
     * The whole finding. A 300-character COMPLETED can only ever yield 300
     * characters and loses its entire meaning doing so; the same 300 out of
     * TREE costs 6% of a list that is still a list afterwards.
     */
    const out = fitPrompt(render, sections(), 6000);
    expect(out, 'COMPLETED must survive').toContain('ccc');
    expect(out, 'TREE should be the one shortened').toContain('ttt');
    expect(out.match(/t/g)?.length ?? 0).toBeLessThan(4900);
  });

  it('keeps the resolution digest longer than the file tree', () => {
    // Same argument one section over: RESOLVED is what stops the planner
    // re-proposing work that was already decided against.
    const out = fitPrompt(render, sections(), 5200);
    expect(out).toContain('rrr');
  });

  it('still protects the API surface longest of the four', () => {
    /*
     * Unchanged, and it must stay that way: "hiding it is what had the planner
     * proposing a file move that had happened weeks earlier."
     */
    const out = fitPrompt(render, sections(), 2000);
    expect(out).toContain('sss');
  });

  it('gives up the small semantic sections only once the tree is gone', () => {
    const out = fitPrompt(render, sections(), 1400);
    expect(out).not.toContain('ttt');
  });

  it('leaves a prompt that already fits completely untouched', () => {
    const s = sections();
    expect(fitPrompt(render, s, 200_000)).toBe(render(s));
  });

  it('says what it gave up, because a silent trim is the defect above it', () => {
    // Not asserted here beyond survival — fitPrompt logs each cut by name and
    // size, which is how the nine emptied COMPLETEDs were found at all.
    expect(() => fitPrompt(render, sections(), 6000)).not.toThrow();
  });
});

/*
 * Finding AX, 2026-08-27, from the first project ShanAuto built from a prompt
 * typed into the TUI.
 *
 * The decomposer gave "Add tick command and show completion in list" this gate:
 *
 *     mkdir -p todo tests && python -m compileall -q ... .
 *
 * `mkdir -p` is Unix. A verify_cmd is run with `shell: true`, which on Windows
 * is cmd.exe, whose `mkdir` has no `-p` — so it created a directory literally
 * NAMED `-p`, and exited 0. The command passed once, left junk in the repo, and
 * failed on every attempt after it with "A subdirectory or file -p already
 * exists". Both attempts died to a check that never reached Python, against
 * code nobody ever read. The operator asked for four things and got three.
 *
 * The list this guard uses is deliberately tiny and every entry was MEASURED on
 * the host, not inferred from looking POSIX: `ls`, `rm`, `touch` and `grep` all
 * work here, because Git's tools are on PATH. Refusing a command for looking
 * Unix-y would reject work that would have passed.
 */
describe('a check the shell on this machine cannot run', () => {
  const win = (cmd: string) => wrongShellForHost(cmd, 'win32');

  // Local copies: the originals live inside another describe in this file.
  const cfg = { system: { limits: { max_files_per_task: 4 } } } as unknown as AppConfig;
  const proposal = (over: Partial<PlannedTask> = {}): PlannedTask =>
    ({
      title: 'Add health endpoint',
      kind: 'feature',
      instruction: 'Change app/api/health.py to return name.',
      acceptance: 'it responds',
      files_hint: [],
      verify_cmd: 'pytest -q',
      depends_on: [],
      est_lines: 20,
      executor_hint: 'cli',
      ...over,
    }) as PlannedTask;

  it('refuses the exact command that cost the operator a feature', () => {
    const why = win('mkdir -p todo tests && python -m compileall -q .');
    expect(why).toMatch(/mkdir -p/);
    expect(why).toMatch(/fails every run after the first/);
  });

  it('says what to do instead, not only what is wrong', () => {
    // A rejection the decomposer cannot act on costs a whole planning pass.
    const why = win('mkdir -p x && pytest') ?? '';
    expect(why).toMatch(/cmd\.exe/);
    expect(why).toMatch(/has to work twice/);
  });

  it('catches it after a separator as well as at the start', () => {
    // The realistic shape: a real check with the broken setup step in front.
    expect(win('python -m pytest -q && mkdir -p out')).not.toBeNull();
    expect(win('pytest ; mkdir -p out')).not.toBeNull();
  });

  it('catches the other three that were measured to fail', () => {
    expect(win('pytest > /dev/null'), '/dev/null').not.toBeNull();
    expect(win('export FOO=1 && pytest'), 'export').not.toBeNull();
    expect(win('pytest $(cat args.txt)'), 'substitution').not.toBeNull();
  });

  it('allows the POSIX tools that genuinely work here', () => {
    /*
     * The half that matters more. Git ships these on PATH, so a command using
     * them runs correctly under cmd.exe — and rejecting it would refuse work
     * that would have passed. Measured, all four, before this guard existed.
     */
    for (const cmd of [
      'rm -rf build && python -m pytest -q',
      'ls tests && pytest',
      'touch marker && pytest',
      'grep -r TODO src && pytest',
    ])
      expect(win(cmd), cmd).toBeNull();
  });

  it('leaves an ordinary check completely alone', () => {
    for (const cmd of [
      'python -m pytest -q',
      'python -m compileall -q . && python -m pytest -q',
      'npm test',
      'cd frontend && npm test',
      'go build ./... && go test ./...',
    ])
      expect(win(cmd), cmd).toBeNull();
  });

  it('is not fooled by mkdir without the flag, which cmd handles fine', () => {
    expect(win('mkdir out && pytest')).toBeNull();
  });

  it('says nothing at all on a POSIX host, where every one of these is correct', () => {
    for (const p of ['linux', 'darwin'] as NodeJS.Platform[]) {
      expect(wrongShellForHost('mkdir -p todo && pytest', p), p).toBeNull();
      expect(wrongShellForHost('pytest > /dev/null', p), p).toBeNull();
    }
  });

  it('drops the task through validateTasks, not just in isolation', () => {
    /*
     * The call site. Four times in two days a guard in this project was proven
     * correct while nothing proved anyone applied it.
     */
    const rejected: string[] = [];
    const kept = validateTasks(
      cfg,
      [proposal({ verify_cmd: 'mkdir -p todo tests && python -m compileall -q .' })],
      rejected,
    );

    expect(kept).toHaveLength(0);
    expect(rejected.join()).toMatch(/cannot run on this machine/);
  });
});
