import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import type { AppConfig } from '../config.js';
import type { Repo, TaskRow } from '../schemas.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffStat, existedAtHead, fileAtSha, type DiffStat } from '../git.js';
import { findDeadExports } from './deadexports.js';
import { keepsEveryProof } from './testedits.js';
import { safeEnv, truncate } from '../util.js';
import { log } from '../logger.js';

export type GateFailure =
  | 'NO_CHANGES'
  | 'TRIVIAL'
  | 'SCOPE_BLOWOUT'
  | 'FORBIDDEN_PATH'
  | 'DEAD_EXPORT'
  /** Rewrote a test that was already in the repo and that it never declared. */
  | 'TEST_TAMPER'
  /**
   * The repo's own check failed, in files this task never touched.
   *
   * Kept apart from VERIFY_FAIL because the two need opposite handling: one
   * is the task's problem and may be worth another attempt, the other is
   * the project's problem and no number of attempts at THIS task can move
   * it.
   */
  | 'VERIFY_UNRELATED'
  | 'VERIFY_FAIL';

export interface GateResult {
  ok: boolean;
  failure?: GateFailure;
  detail: string;
  diff: DiffStat;
  /**
   * The failure was the REPO's own check, not the task's own command.
   *
   * Only that half can belong to somebody else. A task's own command names
   * the tests it wants run, so a failure there is its own by construction —
   * which is why the caller only ever asks about this one.
   */
  baseFailed?: boolean;
  /**
   * Existing tests this task edited without declaring them, that still make
   * every proof they made before.
   *
   * The gate lets these through — see the TEST_TAMPER branch — and hands them
   * to the reviewer, because whether a change to a test's SETUP was honest
   * fallout or a quietly weakened case is a judgement, and this is the one
   * participant that can make it.
   */
  adjustedTests?: string[];
}

/**
 * Of these existing tests, which lost a proof and which only changed setup?
 *
 * `before` comes from HEAD and `after` from disk, both read whole. The patch
 * would have been the obvious source and is the wrong one: the reviewer's copy
 * of it is truncated at 20k, and a check that silently stops looking partway
 * down a long test file is worse than no check.
 *
 * Anything unreadable counts as tampered. A file that existed at HEAD and
 * cannot be read now is either deleted or gone strange, and both are the
 * answer the gate gave before this check existed.
 */
async function splitTestEdits(
  repo: Repo,
  tests: string[],
): Promise<{ tampered: string[]; adjusted: string[] }> {
  const tampered: string[] = [];
  const adjusted: string[] = [];
  for (const f of tests) {
    let kept = false;
    try {
      const before = await fileAtSha(repo, 'HEAD', f);
      const after = await readFile(join(repo.path, f), 'utf8');
      kept = before.trim().length > 0 && keepsEveryProof(before, after);
    } catch {
      kept = false;
    }
    (kept ? adjusted : tampered).push(f);
  }
  return { tampered, adjusted };
}

/**
 * Run the repo's own check again and say whether it passes.
 *
 * Deliberately NOT `baselineGreen`: that memoises, and the whole point of
 * this call is to ask the same question a second time and get a possibly
 * different answer.
 */
export async function recheckRepo(
  cfg: AppConfig,
  repo: Repo,
): Promise<{ green: boolean; out: string }> {
  const res = await execa(repo.verify_cmd.trim(), {
    cwd: repo.path,
    shell: true,
    reject: false,
    timeout: cfg.system.timeouts.verify_s * 1000,
    killSignal: 'SIGKILL',
    stdin: 'ignore',
    extendEnv: false,
    env: safeEnv({ NO_COLOR: '1', CI: '1' }),
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = stripAnsi(`${res.stdout ?? ''}\n${res.stderr ?? ''}`).trim();
  return { green: res.exitCode === 0, out };
}

/**
 * Did the repo's own check pass before anything was attempted?
 *
 * Measured once per repo per run and cached, because it costs a full test suite
 * — ten seconds for example-api, and it must not be paid per task. The answer
 * decides whether the size floor applies at all: on a project that is already
 * green, any diff passes the check by default and the floor is the only thing
 * standing between a whitespace change and a commit; on a project that is red,
 * the suite going green IS the proof of work, whatever the diff measures.
 */
const baselineCache = new Map<string, boolean>();

export function resetBaselineCache(): void {
  baselineCache.clear();
}

/**
 * F4: override a repo's baseline without running its check again.
 *
 * The gate just ran repo.verify_cmd and it exited 0 — the repo is green NOW, so
 * the TRIVIAL floor must re-apply to the next task on it. Without this the cache
 * keeps the pre-run reading (usually green=false for a red project) and every
 * small commit after the repair is still treated as a free pass.
 */
export function setBaselineCache(repoId: string, green: boolean): void {
  baselineCache.set(repoId, green);
}

export async function baselineGreen(cfg: AppConfig, repo: Repo): Promise<boolean> {
  const hit = baselineCache.get(repo.id);
  if (hit !== undefined) return hit;

  const res = await execa(repo.verify_cmd.trim(), {
    cwd: repo.path,
    shell: true,
    reject: false,
    timeout: cfg.system.timeouts.verify_s * 1000,
    killSignal: 'SIGKILL',
    stdin: 'ignore',
    // The repo's own check runs the owner's command, but it reaches the same
    // shell the LLM's edits are about to land in — strip the environment so a
    // compromised check has no credentials to exfiltrate (SEC-1/SEC-3).
    extendEnv: false,
    env: safeEnv({ NO_COLOR: '1', CI: '1' }),
    maxBuffer: 16 * 1024 * 1024,
  });

  const green = res.exitCode === 0;
  baselineCache.set(repo.id, green);
  log.info(
    green
      ? `${repo.id}: its own check passes before starting`
      : `${repo.id}: its own check FAILS before starting — a fix of any size counts as work`,
  );
  return green;
}

/**
 * Files an autonomous agent has no business rewriting on a micro-task.
 *
 * Extended beyond git metadata to the build/lockfile surface the gate itself
 * depends on (§9.2). Tradeoff, documented in the detail string: a legit "add a
 * script to package.json" task is now rejected; the owner does that by hand or
 * via `sa resolve`.
 */
const FORBIDDEN = [
  /(^|\/)\.git\//,
  /(^|\/)\.github\//,
  // §9.4: the orchestrator's own briefs. diffStat already excludes them from
  // the shared measurement, but an agent that tries to write one anyway must
  // fail loudly rather than pass some future path that bypasses diffStat.
  /(^|\/)\.shanauto\//,
  /(^|\/)\.gitignore$/,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)setup\.py$/,
  /(^|\/)setup\.cfg$/,
  /(^|\/)pytest\.ini$/,
  /(^|\/)tox\.ini$/,
  /(^|\/)conftest\.py$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\..+$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)go\.mod$/,
];

/**
 * Verify commands the planner (an LLM) is not allowed to write.
 *
 * The base step is the repo owner's own check and always runs regardless. This
 * guard applies ONLY to the task's own command — the LLM-authored half of the
 * gate — because that text reaches a shell with the owner's environment. A
 * strict allow-list would break legitimate `pytest tests/x.py` tasks, so this
 * is a deny-list of exfiltration / interpreter / destructive primitives (SEC-1).
 * The real boundary is the stripped environment (safeEnv); this makes the common
 * payloads fail loudly instead of silently running.
 */
/*
 * Patterns must be LOWERCASE, because taskCmdAllowed lowercases the input
 * before matching. Four of these used to carry their original casing
 * (Invoke-WebRequest, Remove-Item, GH_TOKEN, _(TOKEN|KEY|SECRET)) — and as
 * case-sensitive regexes against a lowercased string they never matched. Found
 * by the Part 2 deny/allow matrix: `echo $GH_TOKEN`, `export API_KEY=abc` and
 * `printenv MY_SECRET` all sailed through, and the two PowerShell forms only
 * "worked" when the case-insensitive PowerShell cmdlet name was already caught
 * by a different pattern.
 */
const DENY_TASK_CMD: RegExp[] = [
  // network fetchers — the exfiltration primitive
  /\bcurl\b/, /\bwget\b/, /\binvoke-webrequest\b/, /\biwr\b/, /\birm\b/,
  // direct sockets / credential export
  /\b(nc|ncat|netcat|telnet)\b/, /\bcertutil\b/, /\breg\s+save\b/, /\bsecedit\b/,
  // interpreter one-liners — arbitrary code under another binary
  /\b(powershell|pwsh)\b/, /\bcmd\s+[\/-][ck]\b/, /\bbash\s+-c\b/, /\bsh\s+-c\b/,
  // destructive filesystem ops
  /\brm\b/, /\brmdir\b/, /\bremove-item\b/, /\bformat\s+[A-Za-z]:/, /\btakeown\b/,
  /\bdel\s+[\/-]f\b/,
  // git state mutation / credential theft
  /\bgit\s+(push|remote|credential|clone)\b/,
  // secret-file literals
  /\.env\b/, /\bid_rsa\b/, /\bgh_token\b/,
  /\b[a-z_][a-z0-9_]*_(token|key|secret)\b/,
];

export function taskCmdAllowed(cmd: string): { ok: true } | { ok: false; reason: string } {
  const c = cmd.toLowerCase();
  for (const re of DENY_TASK_CMD) {
    if (re.test(c)) return { ok: false, reason: `contains forbidden pattern ${re.source}` };
  }
  return { ok: true };
}

/**
 * Does this path look like a test?
 *
 * Deliberately broad. A false positive costs a declared filename in
 * files_hint; a false negative costs the one guarantee the gate exists to
 * give.
 *
 * A second consumer since run 22: executor.ts asks whether EVERY file in a
 * commit is a test, and withholds the BREAKING CHANGE footer if so. Breadth
 * errs the same way there — calling something a test that is not means a
 * public claim goes unmade, which is the recoverable direction. Anyone
 * narrowing this list should check both callers.
 */
const TEST_PATH: RegExp[] = [
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//,
  /(^|\/)spec\//i,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.py$/,
  /\.(test|spec)\.[jt]sx?$/,
  /(^|\/)[^/]+_test\.go$/,
  /(^|\/)[^/]+Test\.java$/,
];

export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isTestPath(p: string): boolean {
  const s = normPath(p);
  return TEST_PATH.some((re) => re.test(s));
}

/**
 * The files the planner said this task would touch.
 *
 * Stored as a JSON string on the row. A malformed value must not take the
 * gate down, and an empty list is the honest reading of "nothing declared".
 */
export function declaredFiles(filesHint: string): Set<string> {
  try {
    const v: unknown = JSON.parse(filesHint || '[]');
    if (!Array.isArray(v)) return new Set();
    return new Set(v.filter((x): x is string => typeof x === 'string').map(normPath));
  } catch {
    return new Set();
  }
}

/**
 * Which files does this failing test output point at?
 *
 * Used only to answer one question: did the thing that failed have anything to
 * do with what this task changed? So it collects paths broadly — test files and
 * application frames alike — because every extra path found can only make the
 * answer come out as "related", which is the cautious direction. Finding
 * nothing means the question goes unanswered and the task is blamed, same as
 * before.
 */
const FAIL_LINE: RegExp[] = [
  // pytest short summary: FAILED tests/api/test_stats.py::test_x - assert False
  /^(?:FAILED|ERROR)\s+(\S+?)(?:::|\s|$)/,
  // pytest traceback location: tests/api/test_stats.py:100: AssertionError
  /^(\S+\.[A-Za-z]\w*):\d+:\s/,
  // vitest / jest: FAIL src/core/__tests__/x.test.ts > name
  /^\s*(?:FAIL|\u25cf)\s+(\S+\.[cm]?[jt]sx?)\b/,
  // go test: --- FAIL carries no path, but the file:line above it does
  /^\s+(\S+\.go):\d+:/,
];

export function failingFiles(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    for (const re of FAIL_LINE) {
      const m = re.exec(raw);
      if (!m || !m[1]) continue;
      const p = normPath(m[1]);
      // A bare filename with no directory is as likely to be prose as a path,
      // and cannot be matched against a repo-relative diff either way.
      if (!p.includes('/')) continue;
      found.add(p);
      break;
    }
  }
  return [...found];
}

/**
 * The commit gate. This is the strict part of the system: it is what keeps the
 * contribution graph honest. Nothing reaches git without clearing every check.
 */
export async function gate(
  cfg: AppConfig,
  task: TaskRow,
  repo: Repo,
  mockDiff?: DiffStat,
  /*
   * Whether the repo's own check passed BEFORE this task ran, measured once per
   * repo per run. Undefined means "not measured", which is treated as green so
   * the floor still applies — the cautious direction.
   */
  repoWasGreen?: boolean,
): Promise<GateResult> {
  const diff = mockDiff ?? await diffStat(repo);
  const L = cfg.system.limits;
  /** Existing tests edited without being declared, that kept every proof. */
  let adjustedTests: string[] | undefined;

  if (diff.files.length === 0) {
    return { ok: false, failure: 'NO_CHANGES', detail: 'agent produced no file changes', diff };
  }

  const forbidden = diff.files.filter((f) => FORBIDDEN.some((re) => re.test(f.replace(/\\/g, '/'))));
  if (forbidden.length) {
    return {
      ok: false,
      failure: 'FORBIDDEN_PATH',
      detail: `touched protected path(s): ${forbidden.join(', ')}`,
      diff,
    };
  }

  const cap = L.max_files_per_task * L.scope_blowout_multiplier;
  if (diff.files.length > cap) {
    return {
      ok: false,
      failure: 'SCOPE_BLOWOUT',
      detail: `${diff.files.length} files changed, cap is ${cap}`,
      diff,
    };
  }

  /*
   * An agent may not quietly rewrite a test that was already in the repo.
   *
   * Every other check here asks whether the change is good. This one asks
   * whether the EVIDENCE is, and it has to run before the suite does, because
   * a suite that has been edited to pass proves nothing by passing.
   *
   * Measured on 2026-08-20. Task Tc2ca9kfmri declared three files, touched
   * seven, and one of the four undeclared ones was tests/api/test_stats.py —
   * an existing test, unrelated to the feature, whose fixture it rewrote from
   * 5 rows to 100 and whose assertion it moved from >= 5 to >= 100. The suite
   * went green and the gate committed it. The gate had no way to tell that
   * from tampering, because it was not looking.
   *
   * Scoped as narrowly as the hazard. A NEW test file is the task's own work.
   * A test file the planner DECLARED is work the task was sent to do. What is
   * left — an existing test, edited, undeclared — is where the hazard lives.
   *
   * It is not, however, where the hazard always is, and on 2026-08-23 that cost
   * a run its best work. Task Th23pq9f3b1 changed how a document's opens are
   * counted, from a global recent-activity slice to the document's own records.
   * Two tests in that same test_stats.py seed opens with no `opened_at`, so under
   * the new counting they counted nothing and went red. The junior added the
   * field to three seeded rows — dating the stale document's opens 20 days back
   * so the "honors days" test still proved what its name says — touched no
   * assertion, ran all 203 tests green, and had already mutation-tested its own
   * fix by hand. The gate deleted every line of it, and the task that depended
   * on it never ran.
   *
   * Same file, same rule, opposite deed. What separates them is not WHICH file
   * was touched but what was taken away: one moved the bar, the other moved the
   * ball. So the rule now asks that — is every proof this file already made
   * still being made? A removed, rewritten, deleted or skipped assertion is
   * TEST_TAMPER exactly as before. A test that still proves everything it did
   * goes to the reviewer named, because setup can weaken a case too and that
   * judgement is not the gate's to make.
   *
   * Skipped when the repo was already red, where editing a failing test can be
   * the actual repair. Same reasoning as the floor below, and the repair task's
   * brief already forbids weakening one.
   */
  if (repoWasGreen !== false) {
    const declared = declaredFiles(task.files_hint);
    const undeclaredTests = diff.files.filter(
      (f) => isTestPath(f) && !declared.has(normPath(f)),
    );
    const rewritten = await existedAtHead(repo, undeclaredTests);
    if (rewritten.length) {
      const { tampered, adjusted } = await splitTestEdits(repo, rewritten);
      if (tampered.length) {
        return {
          ok: false,
          failure: 'TEST_TAMPER',
          detail:
            `changed what an existing test PROVES, in file(s) it did not ` +
            `declare and did not write: ${tampered.join(', ')}. An assertion ` +
            `that was there is not there now — removed, rewritten, skipped, or ` +
            `its test deleted. A task proves itself by passing the tests that ` +
            `are there, not by editing them. Put those assertions back and make ` +
            `the code satisfy them; if one of them really is asserting the wrong ` +
            `thing, that is its own job and has to be declared. Changing a test's ` +
            `SETUP so it still runs is allowed and is not what this is about.`,
          diff,
        };
      }
      adjustedTests = adjusted;
    }
  }

  /*
   * The size floor does not apply when the project was already broken.
   *
   * Measured, end to end, on 2026-08-09. The suite was red; ShanAuto planned the
   * work correctly, and agy produced exactly the right fix:
   *
   *   -    return {"app_name": settings.PROJECT_NAME, ...}
   *   +    return {"name": settings.PROJECT_NAME, ...}
   *   -    assert data["app_name"] == settings.PROJECT_NAME
   *   +    assert data["name"] == settings.PROJECT_NAME
   *
   * Applied to a clean clone, that patch turns the failing tests green. The gate
   * threw it away as "only 2 insertion(s); below minimum 3" — and because this
   * check ran BEFORE the verify, it never ran the suite that would have proved
   * the change worked. Two more tasks died the same way in the same run: three
   * agent dispatches and four brain calls spent, nothing committed, and the same
   * tasks queued to burn the quota again tomorrow.
   *
   * A one-line fix to a broken build is the most valuable change this system can
   * make, and the rule made it structurally impossible.
   *
   * The floor still exists for its real purpose — stopping a whitespace or
   * comment change from counting as work on a project that was ALREADY green,
   * where any diff passes the check by default. When the baseline was red, the
   * proof of work is the suite going green, and its size is beside the point.
   */
  // F11: a pure rename is 0 insertions and 0 deletions yet is real work. Without
  // renames counted, `git mv x.ts y.ts` reads as "only 0 changed lines" and the
  // floor rejects it the way it rejects a comment tweak.
  const changed = diff.insertions + diff.deletions + diff.renames;
  if (repoWasGreen !== false && changed < L.min_insertions) {
    return {
      ok: false,
      failure: 'TRIVIAL',
      detail:
        `only ${changed} changed line(s); below minimum ${L.min_insertions}. ` +
        `(The project's own check was already passing, so a change this small ` +
        `proves nothing.)`,
      diff,
    };
  }

  /*
   * Code nobody calls is not progress. Two thirds of the commits on 2026-08-06
   * added working, tested functions that no production path invoked, and the
   * gate waved them through because dead code compiles and its own unit tests
   * pass. Checked before running the suite, since it is far cheaper.
   */
  if (cfg.system.limits.forbid_dead_exports) {
    const dead = await findDeadExports(repo, diff.files);
    if (dead.length) {
      return {
        ok: false,
        failure: 'DEAD_EXPORT',
        detail:
          `adds export(s) nothing references: ` +
          `${dead.map((d) => `${d.symbol} in ${d.file}`).join(', ')}. ` +
          `Wire it into a real code path in the same task, or mark it @public.`,
        diff,
      };
    }
  }

  /*
   * The repo's verify_cmd ALWAYS runs. A task's own command may only ADD to it.
   *
   * The planner writes each task's verify_cmd, so letting it replace the baseline
   * let it grade its own homework. Of 63 commits on 2026-08-07, exactly one ran
   * the full `npm run typecheck && npm test`; 34 ran typecheck with no tests, 8
   * ran tests with no typecheck, one ran a script that does not exist, and one
   * "verified" itself with `grep -q "better-sqlite3" package.json` — a check the
   * change satisfied by definition, which is how an unused native dependency got
   * committed. A gate the candidate chooses is not a gate.
   */
  /*
   * Run the two checks as SEPARATE processes, both of which must exit 0.
   *
   * They used to be concatenated into one shell string, `base && taskCmd`, on
   * the assumption that appending can only ever narrow. It cannot. The appended
   * text is unparenthesised, so any top-level `||` or `&` in the task's command
   * takes the whole baseline as its left operand and swallows its failure:
   *
   *   node fail.js                                   -> exit 1   (correctly red)
   *   node fail.js && pytest tests/x.py || true       -> exit 0   (baseline gone)
   *
   * That is not only an adversarial payload. `... || true` and
   * `test -f x && echo present || echo missing` are ordinary things a planner
   * writes — the second is the exact shape config/prompts/decompose.md asks for
   * on removal tasks. A task following its own brief could disable the gate.
   *
   * Separate processes cannot be composed by the text of either one.
   */
  const taskCmd = task.verify_cmd?.trim();
  const base = repo.verify_cmd.trim();
  if (taskCmd && taskCmd !== base) {
    const verdict = taskCmdAllowed(taskCmd);
    if (!verdict.ok) {
      return {
        ok: false,
        failure: 'VERIFY_FAIL',
        detail:
          `the task's own check was rejected before running: ${verdict.reason}. ` +
          `The repo's own check (${base}) still runs; a task check may only add ` +
          `tests/typecheck, not shell primitives the planner has no business writing.`,
        diff,
      };
    }
  }
  const steps = taskCmd && taskCmd !== base ? [base, taskCmd] : [base];

  for (const step of steps) {
    log.debug(`verify: ${step}`);
    const res = await execa(step, {
      cwd: repo.path,
      shell: true,
      reject: false,
      timeout: cfg.system.timeouts.verify_s * 1000,
      killSignal: 'SIGKILL',
      // A verify command that decides to prompt must fail, not hang the run.
      stdin: 'ignore',
      // Same env-stripping as baselineGreen: the task half is LLM-authored text
      // reaching a shell, so the owner's secrets must not be in it (SEC-1/SEC-3).
      extendEnv: false,
      env: safeEnv({ NO_COLOR: '1', CI: '1' }),
      maxBuffer: 16 * 1024 * 1024,
    });

    if (res.exitCode !== 0) {
      const out = stripAnsi(`${res.stdout ?? ''}\n${res.stderr ?? ''}`).trim();
      const which = step === base ? "the repo's own check" : "the task's own check";

      /*
       * Whose failure is this? The gate does not decide, on purpose.
       *
       * The first attempt at this compared the paths in the failing output
       * against the paths in the diff, and scripts/prove-gate.ts — real repo,
       * real pytest — showed it wrong within four cases. A task changed
       * app/thing.py and broke tests/test_existing.py; pytest names only the
       * test file, because that is where the assertion lives, and the task
       * never touched it. By filename the task was innocent. It was not.
       *
       * A filename cannot answer the question. Reverting the change and
       * running the check again can, exactly, and the caller already reverts
       * on every failure path — so it asks there. All the gate owes it is
       * which half of the check failed.
       */
      const hits = failingFiles(out);

      /*
       * The verdict goes FIRST, ahead of the raw output.
       *
       * truncate() cuts the tail, and pytest puts its summary there — so the
       * one line naming what failed was the first thing thrown away. The
       * ledger entry for Thbswhqeaoe ends mid-word inside a traceback, with
       * `FAILED tests/api/test_stats.py::test_popular_documents_endpoint` cut
       * off below it.
       */
      const named = hits.length ? `failing in: ${hits.join(', ')}` : '';
      return {
        ok: false,
        failure: 'VERIFY_FAIL',
        detail: truncate(
          `${which} failed (${step})\n${named}\n${out || `exit ${res.exitCode}`}`,
          3000,
        ),
        diff,
        baseFailed: step === base,
      };
    }
  }

  return {
    ok: true,
    detail: `${diff.files.length} file(s), +${diff.insertions}/-${diff.deletions}`,
    diff,
    adjustedTests,
  };
}
