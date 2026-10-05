import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import type { AppConfig } from '../config.js';
import type { Repo, TaskRow, NormalizedTask } from '../schemas.js';
import * as ledger from '../ledger.js';
import { safeEnv, truncate } from '../util.js';
import { log } from '../logger.js';

/**
 * What to do about a project that is already broken.
 *
 * The gate is absolute: nothing is committed unless the repo's own check passes.
 * That is the guarantee the whole system rests on, and it is not negotiable.
 *
 * But it has a consequence nobody had traced. When a project is broken in THREE
 * independent ways and the planner does the sensible thing — one task per
 * failure — no task can ever land. Each one fixes its own failure, the suite is
 * still red because of the other two, and the gate correctly rejects it. Every
 * task in the group blocks every other.
 *
 * Measured on 2026-08-09, and the numbers are the argument:
 *
 *   baseline                     3 failures
 *   after "fix relationships"    1 failure   <- the agent fixed two of them
 *   REJECTED, rolled back
 *   after "add cascade deletes"  1 failure   <- fixed two again
 *   REJECTED, rolled back
 *   final state                  2 failures
 *
 * Four agent dispatches, four brain calls, real progress every time, and all of
 * it thrown away — with the tasks left queued to spend the same quota again
 * tomorrow, forever, because tomorrow changes nothing.
 *
 * The answer is not to loosen the gate. It is that "fix one of the three
 * failures" is the wrong unit of work when the check is all-or-nothing. On a red
 * project there is exactly one job worth doing: make the check pass. So that
 * becomes a single task carrying the real failure output, and the rest of the
 * repo's queue waits — because every one of those tasks is guaranteed to fail
 * the gate until the project is healthy again.
 */

export interface RepairPlan {
  /** The failing output, ready to hand to an agent. */
  detail: string;
  /** The task that already exists, or the one just created. */
  taskId: string;
}

/** Marks the repair task, so it is recognisable across runs. */
export const REPAIR_TITLE_PREFIX = 'Make the project\'s own check pass again';

export function repairTitle(repo: Repo): string {
  return `${REPAIR_TITLE_PREFIX} (${repo.id})`;
}

/**
 * Run the repo's check and capture WHY it fails.
 *
 * Separate from `baselineGreen`, which only needs the exit code. A repair task
 * is only as good as its brief, and "the tests fail" is not a brief.
 */
export async function captureFailure(cfg: AppConfig, repo: Repo): Promise<string> {
  const res = await execa(repo.verify_cmd.trim(), {
    cwd: repo.path,
    shell: true,
    reject: false,
    timeout: cfg.system.timeouts.verify_s * 1000,
    killSignal: 'SIGKILL',
    stdin: 'ignore',
    // The failure output is fed back into LLM-authored briefs; strip the env so a
    // compromised check can't leak credentials into them (SEC-1/SEC-3).
    extendEnv: false,
    env: safeEnv({ NO_COLOR: '1', CI: '1' }),
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = stripAnsi(`${res.stdout ?? ''}\n${res.stderr ?? ''}`).trim();
  return truncate(out || `exit ${res.exitCode}`, 4000);
}

/** Is this the task that repairs the repo, rather than ordinary work? */
export function isRepairTask(task: TaskRow): boolean {
  return task.title.startsWith(REPAIR_TITLE_PREFIX);
}

/**
 * Ensure exactly one open repair task exists for a broken repo.
 *
 * Idempotent by title: a second run must not stack up a fresh copy every time,
 * which would turn one broken project into an unbounded queue.
 *
 * `known` is the failing output when the caller already has it. The gate
 * produces exactly this text on its way to rejecting a task, and running the
 * check a second time to recover it is not merely slow: on a suite that
 * accumulates state between runs — the kind that produced this failure in the
 * first place — the second run can legitimately disagree with the first, and
 * the repair brief would then describe a failure the agent cannot reproduce.
 */
export async function ensureRepairTask(
  cfg: AppConfig,
  repo: Repo,
  known?: string,
): Promise<RepairPlan> {
  const detail = known?.trim() ? truncate(known.trim(), 4000) : await captureFailure(cfg, repo);
  const title = repairTitle(repo);

  const existing = ledger.openTasksByRepo(repo.id).find((t) => t.title === title);

  if (existing) {
    /*
     * "Already queued" was true of a task that could never run again.
     *
     * `openTasksByRepo` counts anything not committed or dropped as open, which
     * is the right meaning of the word and the wrong answer to the question
     * asked here. A repair job that FAILED satisfied this check while
     * `selectBatch` — which only takes `ready` — could not pick it, so:
     *
     *   run 1  red -> repair queued -> dispatched -> fails
     *   run 2  still red -> "already queued" -> nothing dispatched
     *          -> every other job in this project held
     *   run 3  the same, and so on for ever
     *
     * The project is parked permanently by the one job that exists to unpark
     * it. Nothing else reaches it either: a repair task is inserted with a NULL
     * milestone, so `settleMilestones` never sees it and `autoReplanBlocked`
     * never revives it. The only way out was a person typing
     * `npm run sa -- retry --failed`, about a screen that did not say so.
     *
     * A red project is a hard stop for everything in it, and the repair job is
     * the only thing that can clear it. Trying it again each run is what a
     * person would do, and it is bounded the same way everything else is: the
     * executor stops re-dispatching within a run once the failure stops
     * changing.
     */
    if (existing.status === 'failed' || existing.status === 'blocked') {
      ledger.retryTask(existing.id);
      log.warn(
        `${repo.id}: its repair job did not land last time. Trying it again ` +
          `(${existing.id}) — nothing else here can run until it does.`,
      );
    } else {
      log.info(`${repo.id}: repair task already queued (${existing.id})`);
    }
    return { detail, taskId: existing.id };
  }

  const planned: NormalizedTask = {
    title,
    kind: 'bugfix',
    instruction:
      `The project's own check is failing, so nothing can be committed to it ` +
      `until it passes. Make it pass.\n\n` +
      `Run this to see the failures for yourself:\n\n    ${repo.verify_cmd}\n\n` +
      `It currently reports:\n\n${detail}\n\n` +
      `Fix ALL of the failures in one go — a change that fixes only some of them ` +
      `still leaves the check red, and will be rejected and reverted in full. ` +
      `Do not delete, skip or weaken a test to make it pass; if a test is asserting ` +
      `the wrong thing, fix what it asserts and say so.\n\n` +
      /*
       * Named explicitly because the general instruction above did not hold.
       *
       * On 2026-08-20 a repair job was given "do not delete, skip or weaken a
       * test" and complied to the letter: it deleted nothing, skipped nothing,
       * and changed no assertion. It edited the REQUESTS instead, widening
       * `limit=10` to `limit=1000` in three tests so that rows left in the
       * live database by previous runs no longer crowded out the row each test
       * had just seeded. The check went green and the cause was untouched.
       *
       * An agent will take the cheapest path that satisfies the words it was
       * given, so the words have to name this one.
       */
      `Find out WHY it fails before changing anything. If a test fails because ` +
      `of data left behind by an earlier run — rows in a shared database, files ` +
      `on disk, a cache — the fix is to make the test set up and clean up after ` +
      `itself, or to give it its own storage. Adjusting a limit, a threshold, a ` +
      `page size or a query parameter so the leftover data stops interfering is ` +
      `NOT a fix: the cause is still there and the check will fail again later, ` +
      `with the test no longer exercising what it was written to exercise.`,
    acceptance: `${repo.verify_cmd} exits 0, with no test deleted or skipped.`,
    files_hint: [],
    verify_cmd: repo.verify_cmd,
    depends_on: [],
    /*
     * Deliberately large. est_lines drives the complex/simple routing split, and
     * repairing a broken build is the last thing to hand to the agent reserved
     * for work needing no judgement.
     */
    est_lines: 200,
    executor_hint: 'cli',
  };

  const [taskId] = ledger.insertTasks(null, repo.id, [planned]);
  log.warn(
    `${repo.id}: its own check is failing. Queued one job to repair it (${taskId}); ` +
      `other work on this project is on hold until it passes.`,
  );
  return { detail, taskId: taskId! };
}

/**
 * Split a batch into what can run and what cannot.
 *
 * Anything queued against a red repo other than its repair task is guaranteed to
 * be rejected by the gate, so dispatching it spends an agent request to learn
 * something already known.
 */
export function holdBlockedWork(
  batch: TaskRow[],
  redRepos: Set<string>,
): { runnable: TaskRow[]; held: TaskRow[] } {
  const runnable: TaskRow[] = [];
  const held: TaskRow[] = [];
  for (const t of batch) {
    if (redRepos.has(t.repo) && !isRepairTask(t)) held.push(t);
    else runnable.push(t);
  }
  return { runnable, held };
}
