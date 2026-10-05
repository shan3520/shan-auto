import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlaceholder, wrongToolForStack } from '../planner.js';
import { taskPrompt } from '../taskprompt.js';
import type { NormalizedTask, Repo, TaskRow } from '../../schemas.js';

/**
 * Two failures that had been quietly costing provider requests every night.
 *
 * Both share a shape with everything else in this register: the system reported
 * a plausible-sounding problem — "the agent produced no changes", "a milestone
 * planned to nothing" — which pointed away from the actual cause.
 */

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }),
);

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'plan-'));
  dirs.push(d);
  return d;
};

const task = (over: Partial<NormalizedTask>): NormalizedTask =>
  ({
    title: 'A task',
    kind: 'feature',
    instruction: 'Do the thing.',
    acceptance: 'It works',
    files_hint: [],
    verify_cmd: 'npm test',
    depends_on: [],
    est_lines: 20,
    executor_hint: 'cli',
    ...over,
  }) as NormalizedTask;

describe('a placeholder is not a plan', () => {
  /*
   * These two reached the ledger and sat there failing for days:
   *
   *   "Task 1"       -> "Implement the feature as described."
   *   "Initial Task" -> "Execute primary task specification according to
   *                      project guidelines."
   *
   * No agent can act on either. Both were dispatched repeatedly, returned
   * NO_CHANGES every time, and were retried on the next run. One of them was the
   * ENTIRE output of the milestone `doctor` reported as having "planned to
   * nothing" — it had not planned to nothing, it had planned to THIS, which is
   * worse: the failure then reads as a lazy agent rather than bad planning.
   */
  it('catches the two that actually happened', () => {
    expect(isPlaceholder(task({ instruction: 'Implement the feature as described.' }))).toBe(true);
    expect(
      isPlaceholder(
        task({ instruction: 'Execute primary task specification according to project guidelines.' }),
      ),
    ).toBe(true);
  });

  it.each([
    'Complete the work as specified.',
    'Perform the required changes according to spec.',
    'Do the primary task.',
  ])('catches %s', (instruction) => {
    expect(isPlaceholder(task({ instruction }))).toBe(true);
  });

  it('leaves a real instruction alone, even a short one', () => {
    expect(
      isPlaceholder(
        task({ instruction: 'Change app/api/health.py to return name instead of app_name.' }),
      ),
    ).toBe(false);
  });

  it('anything naming a file, symbol or call is specific by definition', () => {
    for (const instruction of [
      'Implement the retry() helper.',
      'Implement the feature in src/auth/login.ts.',
      'Implement settings.PROJECT_NAME lookup.',
    ]) {
      expect(isPlaceholder(task({ instruction })), instruction).toBe(false);
    }
  });

  it('does not reject a long instruction merely for starting with Implement', () => {
    const instruction =
      'Implement a background worker that reads the queue, retries failed jobs with ' +
      'exponential backoff, and gives up after five attempts, recording the reason each time.';
    expect(isPlaceholder(task({ instruction }))).toBe(false);
  });
});

describe('a check that cannot run blocks the task forever', () => {
  /*
   * Both placeholders carried `verify_cmd: npm test` — in a Python repo with no
   * package.json. The gate runs the repo baseline AND the task's own command, so
   * a task whose command cannot succeed can never be committed, however good the
   * change is. Worth catching before an agent has been paid for.
   */
  function repoWith(files: string[]): Repo {
    const d = scratch();
    for (const f of files) {
      if (f.endsWith('/')) mkdirSync(join(d, f), { recursive: true });
      else writeFileSync(join(d, f), '');
    }
    return { id: 'r', path: d } as Repo;
  }

  it('rejects npm test where there is no package.json', () => {
    expect(wrongToolForStack('npm test', repoWith(['pyproject.toml']))).toMatch(/package\.json/);
  });

  it('rejects a python check where there is no python project', () => {
    expect(wrongToolForStack('python -m pytest -q', repoWith(['package.json']))).toMatch(
      /no python project/,
    );
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

  /*
   * The prefix that walked past the whole check, from a real plan on
   * 2026-08-20. Both tests anchor at the start of the command, so
   * `cd frontend && npx tsc --noEmit` was accepted for a Python repo whose
   * frontend/ holds two .tsx files and nothing else — while a bare
   * `npx jest ...` was correctly rejected twice in the same run.
   */
  it('follows a cd prefix instead of being fooled by it', () => {
    const r = repoWith(['pyproject.toml', 'frontend/']);
    expect(wrongToolForStack('cd frontend && npx tsc --noEmit', r)).toMatch(/package\.json/);
  });

  it('names the directory the check would actually run in', () => {
    const r = repoWith(['pyproject.toml', 'frontend/']);
    expect(wrongToolForStack('cd frontend && npm test', r)).toMatch(/r\/frontend/);
  });

  it('allows a cd into a directory that really is that stack', () => {
    const r = repoWith(['pyproject.toml', 'frontend/', 'frontend/package.json']);
    expect(wrongToolForStack('cd frontend && npm test', r)).toBeNull();
  });

  it('still judges the repo root when there is no cd', () => {
    // The prefix must not become the only path into the check.
    expect(wrongToolForStack('npx tsc --noEmit', repoWith(['pyproject.toml']))).toMatch(
      /package\.json/,
    );
  });

  it('says nothing when the cd target does not exist yet', () => {
    // A task whose job is to scaffold frontend/ must not be rejected for the
    // very absence it was written to fix.
    const r = repoWith(['pyproject.toml']);
    expect(wrongToolForStack('cd frontend && npm test', r)).toBeNull();
  });
});

describe('agy is told what it is allowed to run', () => {
  /*
   * agy's permission rules match a command token-for-token — `command(git
   * status)` is allowed and `git status --short --branch` is DENIED, verified
   * both directions. So an allow-list can never cover ad-hoc exploration, and
   * every `ls` or `grep` was auto-denied with nobody to prompt. Three of four
   * agy dispatches in one run hit it; one spent a provider request to discover
   * it could not run `ls`.
   *
   * Nothing in the prompt had ever mentioned the restriction.
   *
   * That guidance has since moved out of the driver and into `taskPrompt`,
   * behind `shellIsAllowlisted`, so every default-deny driver reads it from one
   * place. These assert the text an agy dispatch actually carries, plus the
   * driver wiring that selects it — grepping the driver for the sentences only
   * proved where they were written, not that they still reach the agent.
   */
  const agyTask = {
    title: 'A task',
    instruction: 'Do the thing.',
    acceptance: 'It works',
    files_hint: '[]',
    verify_cmd: 'python -m compileall app && python -m pytest -q',
  } as TaskRow;

  const agyPrompt = (checkCmd?: string): string =>
    taskPrompt(agyTask, {
      opening: 'Implement exactly this one change in the workspace directory.',
      extraConstraints: ['- Work ONLY inside the workspace directory that was added.'],
      checkCmd,
      shellIsAllowlisted: true,
    });

  it('tells it to use its own file tools instead of shelling out', () => {
    const text = agyPrompt('python -m pytest -q');
    expect(text).toMatch(/use your own file tools/i);
    expect(text).toMatch(/Do NOT shell out/);
  });

  it('names the one exact command that works, because near-misses do not', () => {
    const text = agyPrompt('python -m pytest -q');
    expect(text).toMatch(/EXACTLY this one command/);
    expect(text).toMatch(/python -m pytest -q/);
    expect(text).toMatch(/[Cc]opy it character for character/);
  });

  it('does NOT hand it the verify command to run', () => {
    /*
     * The reversal of what this test originally asserted, and deliberate.
     * Offering repo.verify_cmd and task.verify_cmd as runnable is what killed
     * two tasks on 2026-08-15: example-api's verify_cmd is a compound
     * (`compileall ... && pytest -q`), agy matches token-for-token, no rule
     * contains `&&`, and a headless denial abandons the turn having written
     * nothing. The agent gets ONE operator-authored command instead.
     *
     * Until 2026-08-20 "does not hand it" meant showing the verify command as
     * data labelled "Do not run it yourself". That is not handing it over in
     * any sense the agent respects: on the from-zero run that day agy ran the
     * printed string verbatim on two of four tasks and both committed nothing.
     * It now means the string is absent from the prompt.
     */
    const text = agyPrompt('python -m pytest -q');
    expect(text).not.toMatch(/<VERIFY_CMD>/);
    expect(text).toMatch(/You cannot run that check/);
  });

  it('still says something honest when the repo configures no check command', () => {
    const text = agyPrompt(undefined);
    expect(text).toMatch(/Do NOT run any shell command to check your work/);
    expect(text).toMatch(/use your own file tools/i);
  });

  it('the agy driver is what selects that guidance', () => {
    const src = readFileSync(join(process.cwd(), 'src/drivers/agent.agy.ts'), 'utf8');
    expect(src).toMatch(/shellIsAllowlisted:\s*true/);
    expect(src).toMatch(/checkCmd:\s*repo\.agent_check_cmd/);
  });
});

describe('the script that grants shell access must not revoke it', () => {
  /*
   * `agy-access.ps1 -Apply` wrote settings.json through Set-Content -Encoding
   * UTF8 which, in Windows PowerShell 5.1, means UTF-8 WITH a BOM. agy parses
   * strictly, so a leading U+FEFF made the file invalid JSON and it loaded NO
   * permissions at all — auto-denying every command. The symptom is identical to
   * a missing allow-rule, which is exactly how it would have survived: the
   * script that grants shell access was silently revoking it.
   */
  it('writes UTF-8 without a byte-order mark', () => {
    const ps = readFileSync(join(process.cwd(), 'scripts/agy-access.ps1'), 'utf8');
    expect(ps).toMatch(/UTF8Encoding\(\$false\)/);
    expect(ps).not.toMatch(/Set-Content -Path \$Path -Encoding UTF8/);
  });

  it('doctor refuses to call a corrupted permission file healthy', () => {
    const idx = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
    expect(idx).toMatch(/byte-order mark/);
    expect(idx).toMatch(/0xef/);
  });
});

describe('a milestone that produced nothing is reported however it is labelled', () => {
  /*
   * `stuckMilestones` meant `status='rejected'` and nothing else — a definition
   * rather than a measurement. `M9b7oj3cz9u "Relocate health module"` sat in
   * `pending` with zero tasks: a status NOTHING in this codebase sets or reads.
   * The planner only picks up `unplanned`, so it could not be reached, and the
   * health check did not look at it, so it was not reported either.
   *
   * And `sa retry --failed` had moved a rejected milestone into that state,
   * which made the warning disappear without the milestone gaining a single
   * task. The report improved; reality did not.
   *
   * Listing the dead statuses was itself the bug, so the rule is now stated the
   * other way round: live is `unplanned` or `planned`, stuck is everything
   * else, and a status nobody has invented yet is stuck without being named.
   * The behaviour is covered against a real database in ledger.test.ts ('a
   * milestone stranded in an unrecognised status'); what is checked here is
   * that the two queries cannot drift apart.
   */
  const ledgerSrc = (): string => readFileSync(join(process.cwd(), 'src/ledger.ts'), 'utf8');

  /** One function's body — sliced to its closing brace, not to end of file. */
  const body = (src: string, name: string): string => {
    const from = src.indexOf(`export function ${name}`);
    expect(from, name).toBeGreaterThan(-1);
    const lines = src.slice(from).split('\n');
    const stop = lines.findIndex((l) => l.trim() === '}' && !l.startsWith(' '));
    return lines.slice(0, stop < 0 ? lines.length : stop + 1).join('\n');
  };

  it('defines stuck as "not live", so a status nobody writes yet still surfaces', () => {
    const src = ledgerSrc();
    expect(src).toMatch(
      /LIVE_MILESTONE_STATUS = "status IS NOT NULL AND status IN \('unplanned','planned'\)"/,
    );
    expect(body(src, 'stuckMilestones')).toMatch(/NOT \(\$\{LIVE_MILESTONE_STATUS\}\)/);
  });

  it('counts and requeues through one predicate, so what was counted is what moved', () => {
    // The UPDATE matched status='rejected' while the SELECT found more than
    // that, so a milestone stuck in an unrecognised status was COUNTED as
    // requeued and never moved — it reported "requeued 1" and changed nothing.
    const f = body(ledgerSrc(), 'replanStuckMilestones');
    expect(f.match(/REQUEUEABLE_MILESTONE/g)).toHaveLength(2);
    expect(f).not.toMatch(/WHERE status=/);
  });
});

/*
 * Finding AP. `run` settles milestones twice: once before planning, so a
 * milestone the last run left blocked is re-planned and worked in this one, and
 * once after the batch, so the report and `sa status` describe the run that
 * just happened rather than the one before it.
 *
 * The first call is covered end to end in cli.test.ts. The second is not, and
 * cannot be with this harness: it is only observable when a milestone settles
 * DURING a batch, which needs a real dispatch against a real agent. Deleting it
 * leaves every other test in the repo green - measured, as mutant N13, on
 * 2026-08-26 - so what is held down here is that the call still exists.
 *
 * A weaker test than the ones around it, and deliberately kept rather than
 * dropped: a source check that a line is present is worth more than nothing at
 * all for a line whose absence nothing else can see.
 */
describe('a run settles milestones on the way out as well as on the way in', () => {
  const indexSrc = (): string => readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

  it('settles before planning, so a blocked milestone is back in scope', () => {
    const src = indexSrc();
    // Awaited since 2026-08-31 — settling now runs the acceptance check (O25),
    // which asks a model. The ordering this test exists for is unchanged.
    expect(src).toMatch(/await settleAndRequeue\(cfg\);\r?\n\s*\/\/ Park unreachable chains/);
  });

  it('settles again after the batch, before the run is closed and reported', () => {
    const src = indexSrc();
    const batch = src.indexOf('const sum = await runBatch(');
    const settle = src.indexOf('ledger.settleMilestones()', batch);
    const endRun = src.indexOf('ledger.endRun(runId, sum.attempted', batch);

    expect(batch, 'runBatch call').toBeGreaterThan(-1);
    expect(settle, 'settle after the batch').toBeGreaterThan(batch);
    expect(settle, 'settle before the run is closed').toBeLessThan(endRun);
  });
});
