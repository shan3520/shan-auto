import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { resolveRepo, stateRoot } from '../config.js';
import type { QaReview, Repo, TaskRow } from '../schemas.js';
import * as ledger from '../ledger.js';
import * as git from '../git.js';
import { makeAgent, makeBrain } from '../drivers/registry.js';
import type { ExecResult } from '../drivers/contracts.js';
import { pickAgent, reroute } from './router.js';
import { selectBatch } from './allocator.js';
import { assessStaleness, type StalenessResult } from './staleness.js';
import { ensureRepairTask, holdBlockedWork } from './repair.js';
import { ingestCommits } from './ingest.js';
import {
  gate,
  baselineGreen,
  recheckRepo,
  resetBaselineCache,
  setBaselineCache,
  isTestPath,
  type GateResult,
} from './verifier.js';
import { authorBrief, renderBrief } from './brief.js';
import { renderReview, reviewWork } from './qa.js';
import type { BrainAuthor } from '../drivers/contracts.js';
import { appendEntry, readRecent, readTaskThread } from './journal.js';
import { checkDropClaim, contradictedNote } from './dropcheck.js';
import { dailyBudget } from './budget.js';
import { getRunId, log } from '../logger.js';
import { sleep, withinWorkHours } from '../util.js';

/**
 * What the run ended up with, for any number presented as its outcome.
 *
 * `failed` counts rejections, which is what the report needs to give an honest
 * account of the run. It is not what the operator is asking when they read the
 * last line: a task sent back once and then committed is one piece of work that
 * shipped. Kept in one place because three call sites tell the operator this
 * number and they must not drift apart.
 *
 * Deliberately not clamped at zero. `sentBack` only ever increments alongside a
 * `failed` outcome, so a negative result would mean the counters had come
 * apart, and hiding that behind a Math.max would make the bug unfindable.
 */
export function netFailed(sum: Pick<RunSummary, 'failed' | 'sentBack'>): number {
  return sum.failed - sum.sentBack;
}

export interface RunSummary {
  attempted: number;
  committed: number;
  failed: number;
  handoff: number;
  /** Tasks the agent found already implemented. A planning signal, not a failure. */
  dropped: number;
  /** Superseded before dispatch. Each one is a provider request not spent. */
  parked: number;
  /**
   * Rejections that were sent back for another attempt rather than given up on.
   * Counted inside `failed` as well, because at the moment it happened the task
   * had not landed and the report's account of the run has to say so.
   *
   * It is subtracted back out wherever a number is presented to the operator as
   * the run's outcome. A task rejected once and then committed is one piece of
   * work that shipped, and reporting it as one success and one failure is how a
   * run that did exactly what it set out to do signs off looking like a coin
   * flip. On 2026-08-21 that is precisely what happened: one task planned, sent
   * back over an undeclared schema change, fixed, committed, pushed — and the
   * last line of the run read "1 committed, 1 failed".
   */
  sentBack: number;
  /**
   * Failures whose cause was a denied tool permission, not the agent. Counted
   * inside `failed` as well — this is an explanation of those numbers, not a
   * separate outcome — because the fix is a permission list, not a retry.
   */
  blocked: number;
  /** The permissions that did the blocking, deduped, when a driver named them. */
  blockedBy: string[];
  /*
   * Tasks that COMMITTED anyway, after the agent was denied a tool.
   *
   * Deliberately not counted in `blocked` above, which is documented as an
   * explanation of `failed`. These are not failures: the check ran, it passed,
   * and the work is on the operator's GitHub. They are here because run 16
   * shipped one - `BLOCKED - the agent was denied 1 tool permission(s): bash:
   * python -c`, then a commit and a push - and the only trace was a WARN in the
   * middle of a run's other warnings. Whatever the agent did instead of the
   * command it was refused, the operator gets to know that it did.
   */
  blockedShipped: { id: string; title: string; permissions: string[] }[];
  /*
   * Tasks that shipped a declared change to behaviour that already worked.
   *
   * Not a problem and not counted anywhere near `failed` - the plan said it
   * would happen and the gate passed. It is here because it is the one class
   * of correct, intended work whose consequence lands on somebody who never
   * read the plan: whoever was calling the thing that changed.
   */
  breakingShipped: { id: string; title: string; what: string }[];
  /*
   * Tasks that committed nothing but tests.
   *
   * A `feature`, `fix` or `refactor` whose whole diff is a test file did not do
   * what its title says. Sometimes that is the right answer — the work was
   * already there and the junior proved it — and sometimes it means the task
   * was pointed at the wrong file. Either way the milestone closes and the
   * backlog empties, so the operator is told the idea is finished. This is the
   * line that lets them check.
   */
  testsOnlyShipped: { id: string; title: string; predicted: string | null }[];
  /**
   * Agents that went out mid-run (quota, auth) and the reason. Their tasks were
   * left `ready` and untouched, so the next run picks them up unchanged.
   */
  /**
   * Providers that stopped answering during the run.
   *
   * `recovered` means it was waited out and came back (O22). The entry stays
   * either way: an outage the run survived is still something that happened,
   * and deleting the record to make the summary tidy would hide the one fact
   * that explains a short day.
   */
  agentsOut: { agent: string; why: string; skipped: number; recovered?: boolean }[];
  /**
   * Every task this run failed to land, retryable ones included. The report's
   * only honest account of the run — see RunProblem.
   */
  problems: RunProblem[];
  /**
   * Work withheld because its project's own check was failing, by project. Not a
   * failure and not an attempt: these were never dispatched. Recorded because a
   * run that holds work back and says nothing produces a report that cannot be
   * read — see the note on `refill`.
   */
  held: { repo: string; count: number }[];
  /**
   * Work of the owner's, or an agent's, that this system took out of the tree and
   * kept in a stash — per repo, counted across every run, not just this one.
   *
   * It is a standing total rather than a per-run event because that is the shape
   * of the problem: each individual stash was announced in a log line at the
   * moment it happened, and the pile still reached eleven without anyone knowing.
   */
  stashes: git.StashSummary[];
  stopped?: string;
}

/**
 * Thrown when this AGENT cannot do any more work — quota exhausted, bad
 * credentials. It names the agent because the three providers run on separate
 * quotas: copilot going out is no reason to stop dispatching to agy and
 * opencode, and the run only ends when nothing left in the queue has a live
 * provider to run it.
 */
export class FatalRunError extends Error {
  constructor(
    message: string,
    readonly agent: string,
    /**
     * Might this fix itself if we wait?
     *
     * A provider that is not answering or not finishing is having a bad few
     * minutes. Quota exhausted for the day and bad credentials are not, and
     * waiting on either is a hang dressed up as patience.
     *
     * The distinction exists because of O22: with both pools pointed at one
     * agent — the current configuration — the run ends when that agent goes
     * out, and the rest of the day's work waits for the next scheduled run.
     * The tasks survive, which was the earlier fix; the DAY does not.
     */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'FatalRunError';
  }
}

/**
 * How long to wait out a provider that has stopped answering, once.
 *
 * Long enough to outlast a blip, short enough that a run which spends it and
 * finds nothing changed has lost two minutes rather than an afternoon. Bounded
 * to ONE use per run, which is what keeps this from becoming the hang it would
 * otherwise be: a provider down for an hour ends the run on the second outage
 * exactly as it did before.
 */
const OUTAGE_WAIT_MS = () => Number(process.env.SHANAUTO_OUTAGE_WAIT_MS ?? 120_000);

const KILLSWITCH = () => process.env.SHANAUTO_KILLSWITCH ?? join(stateRoot(), 'KILLSWITCH');

/**
 * Is the owner asking us to stop?
 *
 * Injectable so a test can decide the answer instead of inheriting it from the
 * machine. It used to read the file directly, which meant PAUSING THE SYSTEM
 * turned its own test suite red: eight tests in executor.test.ts drove runBatch,
 * runBatch saw the real state/KILLSWITCH, and stopped before doing anything.
 *
 * That is worse than a flaky test. ShanAuto's own gate is `npm test`, so while
 * paused it could not have committed a change to itself — the most ordinary
 * action an owner can take was the one that broke it.
 */
export type StopCheck = () => boolean;
const killswitchSet: StopCheck = () => existsSync(KILLSWITCH());

/**
 * Run one task end to end: execute -> gate -> commit, with rollback on every
 * failure path so a bad task never leaves debris for the next one.
 */
type Outcome = 'committed' | 'failed' | 'handoff' | 'dropped' | 'parked';

/** An outcome, plus why it happened when the agent was never allowed to try. */
interface TaskResult {
  outcome: Outcome;
  blocked?: BlockedSignal | null;
  problem?: RunProblem;
  /**
   * The repo's own check failed for a reason this task had nothing to do with.
   *
   * Reported upward rather than handled here, because the consequence is not
   * about this task at all: everything else queued against that repo is now
   * guaranteed to fail the same way, and only the batch loop can hold it.
   */
  repoRed?: boolean;
  /**
   * It committed, and every file in the commit was a test.
   *
   * Reported upward because two things downstream are about to state that
   * behaviour changed, and neither of them has seen the diff.
   */
  testsOnly?: boolean;
}

/**
 * A task this run did not land, and why.
 *
 * Carried out of the run rather than read back from the ledger afterwards,
 * because a retryable failure sets the task to `ready` — indistinguishable from
 * a task that has never run — and so cannot be found again by any later query.
 * On 2026-08-13 that made six of the day's eight failures invisible: the report
 * said `failed | 8`, listed four, and every one of the four was a leftover from
 * a previous day.
 */
export interface RunProblem {
  id: string;
  title: string;
  /** One line: the gate verdict or the agent's failure reason. */
  why: string;
  /** False means this was the last attempt and the task is now `failed`. */
  retrying: boolean;
}

/**
 * What a revert cannot undo, told to the one participant able to check it.
 *
 * `rollback` reverts the paths `diffStat` reports, which is everything git
 * tracks and nothing else. An attempt that wrote a cache, altered a dev
 * database, installed a package or edited an ignored config leaves all of it
 * behind, and the next attempt is then graded in a world the rejected one built.
 *
 * On 2026-08-21 that turned a red suite green. Attempt 1 added a startup
 * `ALTER TABLE` that ran when the tests imported the app, permanently adding a
 * column to the gitignored `app.db`. The review rejected that file as
 * `off_brief` and the revert took the source. The column stayed. Attempt 2
 * removed the shim as instructed, ran the suite against that same database, and
 * reported 170 passing — passing because the rejected change's effect was still
 * in place. The reviewer saw a green suite and shipped it. On any machine whose
 * database predates the change and where nobody runs the migration, the
 * committed code does not work.
 *
 * The intern noticed, that time, and said so. This is here so that noticing is
 * not luck: it goes into the journal entry the next attempt is handed as
 * context, and only when there IS a next attempt to read it.
 */
/**
 * How many times ONE attempt will re-dispatch over a provider that returned nothing.
 *
 * Not a retry of the task: the attempt counter is untouched, the brief is the
 * same, and nothing about the work has been judged. It is the same dispatch,
 * made again, because the first one never reached a model.
 *
 * The attempt counter must not absorb this. It is the loop bound — see the note
 * on `seen` in `runBatch` — so refunding it to cover an outage would remove the
 * thing that makes a second chance a second chance instead of a spin. This is a
 * separate, smaller bound that cannot interact with it.
 *
 * Two, because run 15 stalled three dispatches out of four in one evening and a
 * single extra try would have been a coin flip, while a large number turns a
 * dead provider into a task that occupies the runner for an hour saying nothing.
 * Worst case here is roughly four extra minutes per attempt.
 */
const STALLED_REDISPATCHES = 2;

/**
 * The hard ceiling on attempts for one task, whatever else says otherwise.
 *
 * Not a budget. `keepTrying` below decides when to stop by asking whether the
 * work is still moving, and this exists only so that a task which somehow
 * changes its failure every single time cannot run for ever. A run that never
 * ends delivers nothing, which fails the same goal as one that gives up early.
 */
const ATTEMPT_CEILING = 12;

/**
 * What a failure is ABOUT, with the incidental parts filed off.
 *
 * Two attempts that fail the same way have learned nothing; two that fail
 * differently have moved. Telling those apart is the whole of `keepTrying`, and
 * it has to survive the noise a real failure carries — line numbers, elapsed
 * times, temp paths, a different subset of the same failing tests.
 */
export function failureSignature(reason: string): string {
  return (reason ?? '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[a-z]:[\\/][^\s'"]+/g, 'PATH')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Should this task get another go?
 *
 * The old rule was `attempt < max_attempts`, which is a budget, and a budget is
 * the wrong question. A task whose second attempt fails differently from its
 * first is being worked out; a task whose fifth attempt fails exactly like its
 * fourth is stuck, and one more will not help.
 *
 * So: always honour `max_attempts` as a FLOOR, then keep going for as long as
 * each attempt fails in a new way, up to ATTEMPT_CEILING. The operator's
 * instruction on 2026-08-28 was "shanauto should complete its work no matter
 * how much quota is needed" — every cap in this file was justified by protecting
 * quota, and that justification is withdrawn. What replaces it is not "no
 * limit" but "a limit on repetition rather than on spend".
 */
const lastFailure = new Map<string, string>();

export function keepTrying(
  taskId: string,
  attempt: number,
  maxAttempts: number,
  nextReason: string,
): boolean {
  /*
   * The previous reason comes from run-scoped state, NOT from `task.last_error`.
   *
   * Two drafts of this hung the suite instead of failing it. The first asked
   * `attempt < maxAttempts` before checking repetition, and the harness pins
   * `attempt` to 1. The second read the reason off the TaskRow — which the
   * caller never refreshes between attempts, so it was undefined for ever and
   * every failure looked new.
   *
   * Both are the same mistake: termination that depends on somebody else
   * updating something. This map is written here and read here.
   */
  const previousReason = lastFailure.get(taskId);
  lastFailure.set(taskId, nextReason);
  if (attempt >= ATTEMPT_CEILING) return false;
  // Nothing to compare against yet: a first failure always earns another go.
  if (!previousReason) return true;

  /*
   * Repetition stops it, and repetition ALONE — deliberately not
   * `attempt < maxAttempts` first.
   *
   * Termination here must not depend on somebody else incrementing a counter.
   * The first draft of this asked the floor question first, and because the
   * executor's own test harness pins `attempt` to 1, every task retried for
   * ever: the suite ran past a ten-minute timeout instead of failing. That is
   * the same trap recorded as O30, walked into a second time.
   *
   * Failing the same way twice has taught nothing, so `maxAttempts` cannot buy
   * a third identical try. It still matters — see the ceiling above and the
   * call sites — but as the bound on how long we keep going while the work is
   * MOVING, never as permission to repeat.
   */
  if (failureSignature(previousReason) === failureSignature(nextReason)) return false;
  return attempt < Math.max(maxAttempts, ATTEMPT_CEILING);
}

const SIDE_EFFECTS_SURVIVE =
  'NOTE: the file changes above were reverted. Anything that attempt changed ' +
  'OUTSIDE git — a development database, a cache, an installed package, an ' +
  'ignored config file — was NOT reverted and is still in place. If your work ' +
  'passes its checks, confirm it passes because of what you wrote and not ' +
  'because of what the reverted attempt left behind.';

/** The agent asked for a tool and was refused. Whatever followed is not its fault. */
export interface BlockedSignal {
  /*
   * EVERY command or tool that was refused, in the order the driver reported
   * them. Empty when it could not name any.
   *
   * A list rather than a name because run 17 proved the singular wrong: one
   * task was denied `bash: Get-ChildItem -Name` AND a `write` under the temp
   * directory, the report named the first, and the second - the one that pushes
   * opencode onto the bash-heredoc route - was never mentioned. An operator who
   * allows what the report names is denied the rest on the next run, with
   * nothing said. There is no reader of this that wants only the first.
   */
  permissions: string[];
  /** One line, fit for a task status, a journal entry and the daily report. */
  detail: string;
}

/**
 * agy has no structured output, so the refusal arrives as prose and the name of
 * the thing refused has to be read back out of it. Copilot needs none of this —
 * it reports `deniedTools` — which is why the structured field wins below.
 */
const PERMISSION_NAME_PATTERNS = [
  /*
   * agy's real sentence, copied from data/artifacts on 2026-08-15:
   *
   *   jetski: no output produced — a tool required the "command" permission
   *   that headless mode cannot prompt for, so it was auto-denied.
   *
   * The name is right there in quotes and none of the patterns below reach it:
   * the first wants "tool X requires", agy writes "a tool required the X"; the
   * second only looks FORWARD from "denied", and agy puts "auto-denied" after
   * the name; the third wants a quoted name near `permissions.allow`, and agy's
   * hint there is unquoted. So two blocked tasks in that run were both reported
   * as "the driver could not name it" — the generic fallback this function
   * exists to avoid — while the answer sat in the recorded output.
   *
   * The literal is already in the tree twice (brain.agy.ts, brain.agy.test.ts);
   * only the agent path had never been shown it.
   */
  /required?s? the\s+["'`]([\w.:-]{2,60})["'`]\s+permission/i,
  /tool\s+["'`]?([\w.:-]{2,60})["'`]?\s+requires? a permission/i,
  /(?:auto-)?denied[^\n]{0,40}?["'`]([^"'`\n]{2,80})["'`]/i,
  /permissions\.allow[^\n]{0,40}?["'`]([^"'`\n]{2,80})["'`]/i,
];

/**
 * Read a permission refusal out of an agent result.
 *
 * Every ingredient already existed and was thrown away at this boundary: the agy
 * driver logged "was denied a tool permission" and returned `PERMISSION_DENIED`,
 * the Copilot stream parser collected the exact commands. Nothing forwarded
 * either, so a blocked agent reached the gate indistinguishable from an idle
 * one and was reported as `NO_CHANGES: agent produced no file changes` — a
 * sentence that blames the model for a permission list. Two debugging rounds
 * across 17 tasks on 2026-08-08 went looking for a fault in the agent.
 */
/** Words that turn a mention of the token into a denial of it. */
const NEGATED = /\b(not|isn'?t|aren'?t|no|never|cannot|can'?t|rather than|instead of|would be|wrong|inaccurate|false)\b/i;

/**
 * Words that make the token hypothetical or quoted rather than asserted.
 *
 * Every agent prompt ends with "If the task is already satisfied, change nothing
 * and say ALREADY_DONE", so an agent that recites its brief mentions the token
 * without ever claiming it. Same failure as a negation, different grammar.
 */
const HYPOTHETICAL = /\b(if|unless|whether|should i|said|says|instruct|prompt|asked to|e\.g\.|example|might|may|could|would)\b/i;

/**
 * Did the agent actually CLAIM the work was already done?
 *
 * The old test was `/ALREADY[_ ]DONE/i.test(stdout)` against the whole output,
 * which matches the token wherever it appears — including inside a sentence
 * refusing it. On 2026-08-08 copilot wrote, verbatim:
 *
 *   "`ALREADY_DONE` is not accurate here: this workspace doesn't contain the
 *    requested `app/` SQLAlchemy/Alembic structure at all"
 *
 * The task was recorded `dropped — agent reported the work was already done`,
 * the models were never written, and that false record then blocked the
 * milestone from ever being re-planned, because dedupe rightly treats known
 * work as known. A lie in the ledger is worse than a failure in it.
 *
 * This is the third time free text has been scanned for a signal word without
 * checking whether it was asserted or merely mentioned — agy's prose about
 * "rate limit" aborted a run, and a plan containing "Authentication" was thrown
 * away as an auth failure. So: only the closing lines count, because the prompt
 * asks the agent to SAY it when finishing, and a negated line does not count.
 */
export function saysAlreadyDone(stdout: string): boolean {
  const lines = (stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // The conclusion, not the working-out. An agent that decides mid-thought and
  // then changes its mind must not be taken at its first word.
  return lines
    .slice(-3)
    .some(
      (line) =>
        /ALREADY[_ ]DONE/i.test(line) && !NEGATED.test(line) && !HYPOTHETICAL.test(line),
    );
}

/**
 * What the tree the next attempt inherits actually looks like.
 *
 * O26. This sentence was written unconditionally — "Its file changes were
 * reverted and stashed, so you are starting from a clean tree" — because
 * `rollback` returned `void` and nothing here could know. Run 23 logged
 * "Nothing to roll back in example-api" beside every one of them, and the fallback
 * path promises a stash it does not create and may have deleted through.
 *
 * Neither is dangerous while the tree really is clean, which is why the issue
 * was recorded rather than patched. What changed is the evidence: the refusal
 * note shipped a day earlier told an agent its turn had ended when it had not,
 * and this project's own finding is that a prompt caught lying about the
 * agent's own situation spends the credibility the rest of it runs on. A
 * sentence that is usually true is exactly the kind that is never checked.
 */
export function treeNote(undone: import('../git.js').RollbackResult | null): string {
  if (!undone) return `Whether anything it wrote is still in the tree is not known here.`;
  if (undone.skipped) {
    return (
      `Its file changes could NOT be reverted — another process holds the git ` +
      `index — so they are still in the tree. Read before you write: what is ` +
      `there may be its work, not yours.`
    );
  }
  if (undone.reverted === 0) return `It changed no files, so the tree is as it was.`;
  return undone.stash
    ? `Its ${undone.reverted} file change(s) were reverted and stashed, so you ` +
        `are starting from a clean tree.`
    : `Its ${undone.reverted} file change(s) were reverted WITHOUT a stash, so ` +
        `you are starting from a clean tree and that work is gone.`;
}

/**
 * What to tell the NEXT attempt after a refusal, so it can route around it.
 *
 * This function is the whole of the change. Until now a blocked task was the
 * one gate rejection that ended a task outright, on the reasoning that "the fix
 * is a permission list, not another attempt at the same wall". The first half
 * of that is true and the second half does not follow: the agent has its own
 * read, write and edit tools, and almost every refusal on record was for
 * something it never needed a shell for — reading a file, writing a scratch
 * file, deleting one, setting an environment variable. It reached for a shell
 * out of habit and was refused.
 *
 * Whether that ENDS its turn varies, and the note has to say which. Task
 * T4uxha4ldlc on 2026-08-30 was refused `cd /d D:\\repos\\example-tracker`
 * — Command Prompt syntax typed into a shell that does not speak it, refused by
 * opencode's own `external_directory: deny` for naming a path outside the
 * project, which is the one guardrail worth keeping: a rejected task is
 * reverted, and a revert only reaches inside the repo.
 *
 * It then shrugged, ran a different check that worked, and finished normally,
 * having written both files it was asked for. The first version of this note
 * would have opened by telling it its turn had ended and nothing was written.
 * Two false sentences at the top of the one message meant to be believed.
 *
 * The operator cannot be the one to fix that. Widening a permission list is
 * theirs to approve, not theirs to discover, and a run that stops to ask has
 * failed at the thing it exists to do. So the refusal is fed back instead: the
 * next attempt is told exactly which command was refused and what to use in its
 * place. An agent refused the SAME command twice has not routed around it and
 * is stopped by the ordinary repetition rule — which is why the reason handed
 * to `keepTrying` at the gate now carries the refusal and not just the verdict.
 */
export function refusalNote(blocked: BlockedSignal, cutShort: boolean): string {
  const named = blocked.permissions.length
    ? blocked.permissions.map((p) => `    ${p}`).join('\n')
    : '    (the driver could not name it)';
  /*
   * Only claimed when it is true. See the note on `cutShort` above: an agent
   * told "nothing was written" about an attempt in which it demonstrably wrote
   * two files has been handed a reason to discount the rest of this note.
   */
  const what = cutShort
    ? `Your turn ended right there, which is why nothing was written. The work ` +
      `itself was never rejected — it was never finished.`
    : `You carried on afterwards and finished, so this did not cost you the ` +
      `attempt. It is recorded because the check you meant to run never ran, ` +
      `and whatever you concluded instead rested on that.`;
  return (
    `A tool call was REFUSED part-way through your last attempt.\n\n` +
    `Refused:\n${named}\n\n` +
    `${what}\n\n` +
    `Do not run that again, in any spelling — it is refused the same way this ` +
    `time. Note that the reason may not be the one you would guess: a command ` +
    `is refused for naming a path outside this project as readily as for the ` +
    `command itself. Use your own tools instead — you can read, write and edit ` +
    `files directly, without the shell, and you are already inside the project ` +
    `folder so there is nothing to change directory to. If you need a scratch ` +
    `file, put it beside the code in this repo and remove it with your edit ` +
    `tool. Committing and pushing are not yours to do; leave the work in the ` +
    `tree.`
  );
}

/**
 * What to tell the next attempt after it changed nothing and said nothing.
 *
 * There are two honest reasons an agent produces no file changes, and they have
 * opposite cures. Either the work is already there — in which case the task
 * should be DROPPED, and the brief already tells it how to say so — or it did
 * not do the work, in which case it should do it.
 *
 * `saysAlreadyDone` is deliberately strict, and has to be: it reads the closing
 * lines only, ignores negations and hypotheticals, because a loose version once
 * recorded a task as already-built out of a sentence REFUSING that reading, and
 * a lie in the ledger is worse than a failure in it. The cost of that strictness
 * is this case — an agent that genuinely found the work present, said so in its
 * own words, and did not use the token.
 *
 * It is then rejected NO_CHANGES, retried, does the same thing, and is recorded
 * as a failure. Its milestone blocks and spends one of its automatic re-plans on
 * work that already exists.
 *
 * So the retry is told which of the two exits it is standing in front of. Same
 * shape as `refusalNote`: the situation fed back plainly, at the moment it is
 * about to be repeated, rather than a general instruction in a brief it has
 * already read once.
 */
export function noChangesNote(): string {
  return (
    `Your last attempt changed no files, and did not report the work as ` +
    `already done. Those are the only two endings this task has, so one of ` +
    `them has to be true.\n\n` +
    `If the work IS already present: say so, and end your reply with ` +
    `ALREADY_DONE on its own as the last line. Say it plainly — a sentence ` +
    `like "ALREADY_DONE is not accurate here" is read as the opposite, and a ` +
    `mention of it while thinking does not count. That ends the task and ` +
    `nothing is held against it.\n\n` +
    `If it is NOT: write the change. Reading the code and reporting on it is ` +
    `not the task, and an attempt that reports without writing is rejected ` +
    `exactly like this one.`
  );
}

export function detectBlocked(
  res: Pick<ExecResult, 'reason' | 'stdout' | 'deniedTools'>,
): BlockedSignal | null {
  const named = (res.deniedTools ?? []).map((t) => t.trim()).filter(Boolean);
  if (named.length > 0) {
    return {
      permissions: named,
      /*
       * Still one line - it goes in a task status, a journal entry and a log
       * warning, all of which are read a line at a time. It is the only place
       * that truncates, so it says when it has.
       */
      detail:
        `the agent was denied ${named.length} tool permission(s): ` +
        named.slice(0, 3).join(' | ') +
        (named.length > 3 ? ` (+${named.length - 3} more)` : ''),
    };
  }
  if (res.reason !== 'PERMISSION_DENIED') return null;

  for (const re of PERMISSION_NAME_PATTERNS) {
    const m = re.exec(res.stdout ?? '');
    if (m?.[1]) {
      return {
        permissions: [m[1]],
        detail: `the agent was denied the tool permission \`${m[1]}\``,
      };
    }
  }
  // Still worth saying. "Blocked, name unknown" points at the permission list;
  // silence points at the model.
  return {
    permissions: [],
    detail: 'the agent was denied a tool permission (the driver could not name it)',
  };
}

/**
 * Decide whether this task is still worth a provider request, using only git and
 * the ledger. Exported so the wiring can be tested without a live repo.
 *
 * Every failure path returns FRESH. This check exists to save quota; it must
 * never be the reason live work does not run.
 */
export async function assessTaskStaleness(repo: Repo, task: TaskRow): Promise<StalenessResult> {
  try {
    const claim = ledger.getClaim(task.id);
    if (!claim?.plan_head) return { verdict: 'FRESH', evidence: '' };

    // Pick up anything that landed since — including commits from earlier tasks
    // in this same run, which is why ingestion is per-task and not per-run.
    await ingestCommits(repo);

    const currentHead = await git.headSha(repo);
    if (!currentHead || currentHead === claim.plan_head) {
      return { verdict: 'FRESH', evidence: '' };
    }

    const shas = (await git.commitsBetween(repo, claim.plan_head, currentHead)).map((c) => c.sha);
    const delta = ledger.resolutionsForShas(repo.id, shas, claim.planned_at);
    return assessStaleness(claim, claim.plan_head, currentHead, delta);
  } catch (e) {
    log.debug(`staleness check skipped for ${task.id}: ${(e as Error).message}`);
    return { verdict: 'FRESH', evidence: '' };
  }
}

/**
 * The one thing the senior cannot see and has to be told: this run already
 * changed a file this task claims, in order to keep a promise of its own.
 *
 * Run 19 is why this exists. Two tasks planned together both claimed
 * `app/api/search.py`. The first shipped a paginated search function and wired
 * the endpoint to it. The second was briefed an hour later, after the first had
 * committed, and the senior planned the endpoint straight back off that
 * function - leaving it with one caller, a compatibility shim. Every gate
 * passed: the first task's own check asserted a symbol that was still present,
 * and the repo's suite was green at 197. Its acceptance was false anyway.
 *
 * Returns '' when the drift came from outside this system - a hand edit, or an
 * ingested commit with no task behind it. That is ordinary staleness, the tree
 * is the best evidence there is for it, and the senior already reads the tree.
 * Only work this run committed carries an acceptance sentence that is now this
 * task's business to keep true.
 */
export function priorWorkNote(stale: StalenessResult, lookup = ledger.getTask): string {
  const by = stale.driftedBy;
  if (!by?.taskId) return '';
  const prior = lookup(by.taskId);
  if (!prior?.acceptance) return '';
  const sha = by.sha ? by.sha.slice(0, 8) : 'an earlier commit';
  return (
    `ALREADY CHANGED BY THIS RUN: ${by.path} was rewritten in ${sha} by the task ` +
    `"${prior.title}", which this system has already committed as done. That task's ` +
    `acceptance was: ${prior.acceptance} - and it still has to be true once this task ` +
    'is finished. Plan on top of that change rather than around it. If this task ' +
    'genuinely cannot be done without undoing it, say so plainly in the objective and ' +
    'brief the smallest change that leaves both true.'
  );
}

/**
 * `assignedTo` is the caller's decision, used when the stably-routed agent is
 * out for this run and a pool-mate is taking the task instead. Absent, this
 * routes for itself exactly as before.
 */
/**
 * Get the senior's brief for this task, or null if this agent does not take one.
 *
 * Failure here is deliberately NOT fatal. The brief makes a task better
 * specified; its absence makes the task what it was last week, which is a thing
 * that worked. Losing a task because the senior was out of quota would trade a
 * whole unit of work for a prompt upgrade, so an authoring failure degrades to
 * the freeform instruction and says so in the log rather than in silence.
 *
 * A brief already on the row is reused: a second attempt at a task is a retry of
 * the implementation, not a chance for the senior to change its mind, and
 * re-authoring would let the plan drift between attempts of the same task.
 */
async function briefFor(
  cfg: AppConfig,
  task: TaskRow,
  agentId: string,
  repo: Repo,
  /** What this run already landed in the files this task claims; see priorWorkNote. */
  landed = '',
): Promise<string | null> {
  if (!cfg.drivers.routing.brief_for.includes(agentId)) return null;
  if (task.brief) {
    log.debug(`[${task.id}] reusing the brief from an earlier attempt`);
    return task.brief;
  }

  let brain;
  try {
    brain = await makeBrain(cfg);
    await brain.init();
    const brief = renderBrief(
      await authorBrief(cfg, brain, repo, task, landed, ledger.ideaForTask(task.id)),
    );
    ledger.setTaskBrief(task.id, brief);
    log.info(`[${task.id}] briefed by ${named(brain)} (${brief.length} chars)`);
    return brief;
  } catch (e) {
    log.warn(
      `[${task.id}] no brief — the senior could not write one (${(e as Error).message}). ` +
        `Dispatching on the planner's instruction instead.`,
    );
    return null;
  } finally {
    await brain?.dispose().catch(() => undefined);
  }
}

/**
 * The senior's verdict on work the gate has already passed.
 *
 * `null` means ship, and it is what every failure here returns. That is the
 * whole design of this seam: the review is a filter on work that is otherwise
 * ready to commit, so a senior that is unreachable, over budget, or unable to
 * produce an acceptable review must cost nothing. The alternative — treating a
 * missing review as a rejection — turns one provider outage into a run that
 * deletes every change it makes and reports failures nobody can act on.
 *
 * Nothing is rolled back here, and nothing is written to the ledger. This
 * function answers a question; the caller acts on it.
 */
/**
 * How a participant should be named when the model that answered was not the
 * one configured for the job.
 *
 * The driver id alone is what the operator used to see — `reviewed by agy: ship`
 * — and it is the same string whether the configured senior judged the work or
 * its understudy did after the senior failed to answer. The fallback itself is
 * correct engineering and is why runs finish at all; the silence about it is
 * not. See DECISIONS.md, 'A verdict was attributed to the driver, not the
 * model'.
 */
function named(brain: { id: string; answered?: BrainAuthor }): string {
  const a = brain.answered;
  return a?.fallback ? `${brain.id} (fell back to ${a.model})` : brain.id;
}

async function qaVerdict(
  cfg: AppConfig,
  task: TaskRow,
  agentId: string,
  repo: Repo,
  g: GateResult,
  report: string,
): Promise<(QaReview & { author?: BrainAuthor }) | null> {
  if (!cfg.drivers.routing.qa_for.includes(agentId)) return null;

  let brain;
  try {
    /*
     * Read the patch BEFORE the brain is started. It is the cheap half and the
     * half that can be empty: a change the gate counted but git cannot show —
     * a permission bit, a mode change — gives the reviewer nothing to read, and
     * spawning a model to look at an empty diff is a request spent on nothing.
     */
    const patch = await git.workingPatch(repo, g.diff.files);
    if (!patch.text) {
      log.debug(`[${task.id}] no reviewable diff; committing without a review`);
      return null;
    }

    brain = await makeBrain(cfg);
    await brain.init();
    const review = await reviewWork(brain, repo, task, {
      patch: patch.text,
      truncated: patch.truncated,
      files: g.diff.files,
      gateDetail: g.detail,
      adjustedTests: g.adjustedTests,
      report,
    });
    log.info(
      `[${task.id}] reviewed by ${named(brain)}: ${review.verdict}` +
        (patch.truncated ? ` (patch cut at ${patch.text.length} of ${patch.fullLength} chars)` : ''),
    );
    /*
     * Attached to the verdict, not left on the driver, because the journal that
     * publishes this is written much later by a caller that has no brain in
     * scope — which is exactly how the attribution went missing before.
     */
    return { ...review, author: brain.answered };
  } catch (e) {
    log.warn(
      `[${task.id}] no review — the senior could not give one ` +
        `(${(e as Error).message}). Committing on the gate's verdict alone.`,
    );
    return null;
  } finally {
    await brain?.dispose().catch(() => undefined);
  }
}

/**
 * Timeouts in a row from one agent, this run, across all tasks.
 *
 * Run 31 is why. `opencode` hung on four dispatches in a row - two tasks, two
 * attempts each - and every one ran the full 900s budget before being killed.
 * That is an hour of wall clock, both tasks left `failed` with no attempts
 * left, and one of them was "use argparse so --help works". Nothing was wrong
 * with the tasks: the same binary answered a trivial prompt correctly minutes
 * afterwards.
 *
 * Run 23 taught this exact lesson about a provider returning nothing, and the
 * fix below the `stalled` branch has held since. A provider that hangs is the
 * same event wearing a different reason string - it produced no work, cost the
 * whole budget, and said nothing about the task - and it was not covered.
 *
 * Counted per agent and across tasks on purpose. One task timing out is a fact
 * about that task, which may genuinely be too big; the SAME agent timing out on
 * a DIFFERENT task straight afterwards is a fact about the agent. Any outcome
 * that is not a timeout clears it, so an agent that recovers is not carrying a
 * grudge from earlier in the run.
 */
const consecutiveTimeouts = new Map<string, number>();

/** Two, matching STALLED_REDISPATCHES' reasoning: once is chance, twice is the provider. */
const TIMEOUTS_BEFORE_OUT = 2;

async function runOne(cfg: AppConfig, task: TaskRow, assignedTo?: string): Promise<TaskResult> {
  const repo = resolveRepo(cfg, task.repo);
  const agentId = assignedTo ?? pickAgent(cfg, task);

  /** Record a beat of this task's story. Never throws; see core/journal.ts. */
  const journal = (stage: Parameters<typeof appendEntry>[0]['stage'], detail: string) =>
    appendEntry({ repo: repo.id, stage, detail, taskId: task.id, title: task.title, agent: agentId });

  log.info(`[${task.id}] ${task.title}  (${repo.id} -> ${agentId})`);

  /*
   * git prep runs BEFORE the task is marked running and before its attempt
   * counter moves. Two reasons: HEAD is only current after ensureClean does its
   * pull --rebase, and a task parked below must cost neither a provider request
   * nor one of its two retry attempts.
   */
  try {
    await git.ensureClean(repo);
  } catch (e) {
    ledger.setStatus(task.id, 'blocked', `git prep failed: ${(e as Error).message}`);
    return { outcome: 'failed' };
  }

  const stale = await assessTaskStaleness(repo, task);
  if (stale.verdict === 'SUPERSEDED') {
    // Park, never drop: `sa retry --failed` recovers it if this was wrong.
    ledger.setStatus(task.id, 'blocked', `superseded: ${stale.evidence}`);
    ledger.addResolution({
      repo: repo.id,
      kind: 'manual_park',
      task_id: task.id,
      commit_sha: stale.supersededBy?.sha ?? null,
      symbols: stale.supersededBy ? [stale.supersededBy.symbol] : [],
      reason: `parked before dispatch — ${stale.evidence}`,
    });
    log.info(`[${task.id}] parked before dispatch — ${stale.evidence}`);
    journal('park', `parked before dispatch — ${stale.evidence}`);
    return { outcome: 'parked' };
  }
  /*
   * Dispatch anyway; the agent is better placed to judge than a path match. But
   * it can only judge what it is shown, and until run 19 this verdict was
   * logged for the operator and then dropped on the floor.
   */
  let landed = '';
  if (stale.verdict === 'DRIFTED') {
    log.warn(`[${task.id}] drifted — ${stale.evidence}`);
    landed = priorWorkNote(stale);
    if (landed) log.info(`[${task.id}] the senior will be told what this run already landed there`);
  }

  const agent = await makeAgent(cfg, agentId);
  ledger.setStatus(task.id, 'running');
  const attempt = ledger.bumpAttempt(task.id);

  /*
   * The senior writes the brief here, after the attempt is counted and before
   * anything is told what to do.
   *
   * It has to come after the staleness check above: a task about to be parked as
   * superseded must not first spend a model call being briefed for work that
   * already exists. And it has to come before the journal entry below, because a
   * dispatch record quoting the planner's sentence when the agent was handed a
   * brief describes a run that did not happen.
   *
   * Assigned onto the row so the drivers reach it the same way they reach every
   * other field. The alternative - a fifth parameter on `execute` - would put
   * the brief in the contract for agents that never take one.
   */
  task.brief = await briefFor(cfg, task, agentId, repo, landed);

  /*
   * The journal is read BEFORE this task is journalled, so an agent never reads
   * its own dispatch back as though it were prior work.
   */
  const context = readRecent();
  /*
   * A retry is also handed its OWN gate failure and review findings, separately.
   *
   * `readRecent` is a shared chronological tail, so whether a task's own history
   * is inside it depends on what the other tasks happened to be doing — and with
   * two in flight it usually is not (see `readTaskThread` for the measurement).
   * Reading it per-task makes the answer independent of the traffic around it.
   *
   * Empty when there is no history, which is what makes it readable downstream:
   * its presence is exactly the statement "you have done this before".
   *
   * Asked of the JOURNAL rather than of the attempt counter, and that is a
   * correction. The guard here was `attempt > 1`, which is the same statement
   * only while nothing resets the counter — and `retryTask` sets `attempts=0`,
   * because from the queue's point of view a revived task starts again. So
   * every recovery path threw the history away at the moment it was most
   * useful: the operator's `retry --failed`, `retry <id>`, and the repair job
   * this run now revives on its own. A task that failed yesterday was
   * dispatched today knowing nothing about yesterday, and re-derived the
   * approach it had already been rejected for.
   *
   * The thread is keyed by task id and is empty for a task that has never run,
   * so the property the old guard was protecting is unchanged. What changes is
   * that it is now true across runs as well as within one.
   */
  const rework = readTaskThread(task.id);
  if (rework) log.info(`[${task.id}] attempt ${attempt} — carrying ${rework.length} chars of rework`);
  journal(
    'dispatch',
    task.brief
      ? `briefed by the senior:\n${task.brief}`
      : `${task.instruction}\n\nACCEPTANCE: ${task.acceptance}`,
  );

  /*
   * Read the repo's health BEFORE the agent touches anything.
   *
   * Cached per repo per run, so on the ordinary path `run` has already measured
   * it and this costs nothing. It must not be left until gate time: by then the
   * agent has edited the tree, so the answer describes the RESULT rather than
   * the starting point — which is the exact input the size floor needs in order
   * to decide whether a two-line fix counts as work.
   */
  const wasGreen = await baselineGreen(cfg, repo);

  /*
   * A dispatch the provider never ran is not an attempt at the task.
   *
   * On run 15 three of four dispatches ended on a step carrying zero tokens in
   * and zero out — the agent had done its orienting reads and was mid-task when
   * the provider simply stopped answering. Each of those was charged against a
   * budget of two attempts. Task Tiaybdncsp2 spent both without a model ever
   * writing a line, and T0cygl3e2i8 spent its first that way, then produced good
   * work on its second and drew a review naming one real defect with the exact
   * fix beside it — and had no attempt left to apply it. Both tasks failed. The
   * run committed nothing.
   *
   * So this asks again, up to a bound, without touching the attempt counter. The
   * tree is rolled back first: a stalled session usually wrote nothing, but
   * `usually` is not a thing to hand the next dispatch.
   */
  const idea = ledger.ideaForTask(task.id);
  let res = await agent.execute(task, repo, cfg.system.timeouts.task_s, context, rework, idea);
  for (let redispatch = 1; res.stalled && redispatch <= STALLED_REDISPATCHES; redispatch++) {
    // Bill the dead dispatch. It cost the provider's allowance whatever it cost,
    // and a discarded result is exactly the spend that would otherwise vanish.
    ledger.recordAgentCost(getRunId(), res.costUnits, task.id);
    log.warn(
      `[${task.id}] the provider returned nothing (${res.reason}); redispatching ` +
        `${redispatch} of ${STALLED_REDISPATCHES} — attempt ${attempt} is not charged`,
    );
    await git.rollback(repo).catch(() => undefined);
    res = await agent.execute(task, repo, cfg.system.timeouts.task_s, context, rework, idea);
  }
  // Read once, before anything downstream has a chance to conclude "lazy agent".
  const blocked = detectBlocked(res);
  if (blocked) log.warn(`[${task.id}] BLOCKED — ${blocked.detail}`);
  /*
   * Bill the dispatch here, above every path that can return below. The
   * allowance was charged when the request was made, so a timeout, a gate
   * rejection and a commit all cost the same — recording it only on success
   * would have hidden precisely the spend with nothing to show for it.
   *
   * recordAgentCost never throws; see the ledger.
   */
  // The task id makes a surprising bill traceable to the dispatch that caused it.
  ledger.recordAgentCost(getRunId(), res.costUnits, task.id);
  /*
   * Status and archive pointer go LAST, not first.
   *
   * A result entry is clipped from the tail — an agent's useful summary is the
   * last thing it says — so anything written above a long output is exactly
   * what gets discarded. The pointer back to the untrimmed copy is the one line
   * that must never be the thing that gets cut.
   */
  const verdict =
    (res.ok ? `ok in ${Math.round(res.durationMs / 1000)}s` : `FAILED (${res.reason}) in ${Math.round(res.durationMs / 1000)}s`) +
    // A permission refusal can still exit ok, so "ok in 40s" on its own is the
    // most misleading line in the journal on exactly the runs that need reading.
    (blocked ? ` · BLOCKED: ${blocked.detail}` : '');
  journal(
    'result',
    `${res.stdout}\n\n— ${verdict}${res.rawPath ? ` · full output: ${res.rawPath}` : ''}`,
  );

  if (res.handoff) {
    ledger.setStatus(task.id, 'handoff', `awaiting you in ${agentId}: ${res.stdout}`);
    return { outcome: 'handoff' };
  }

  /*
   * A session that stopped mid-thought may have finished the work first.
   *
   * Run 20, task Tz6zyxs1hnm: 27 steps, four files, +65/-27, and then a step
   * the provider never ran. Every line of it was reverted without the gate
   * being asked anything, the attempt was charged, and the retry rewrote the
   * same change and committed it. The tree was almost certainly already good.
   *
   * How a session ENDED is not evidence about what is in the tree. What the
   * work is worth is a question this system already answers, three times over —
   * the project's own check, the gate, and the senior's review — and none of
   * those care why the agent stopped talking. So the changes go to them. A
   * rejection reverts exactly as before, one verify run later.
   *
   * INCOMPLETE only. That failure means the provider stopped answering between
   * steps. A TIMEOUT is us killing an agent that was demonstrably still
   * working, where a half-written file is a real possibility rather than a
   * theoretical one, and it keeps the old behaviour.
   *
   * Nothing else needs excluding here. INCOMPLETE is written in one place,
   * `ocstream.ts`, and `isFatal` leaves it out by name — so a fatal session
   * cannot reach this line, and a check for one would read as protection
   * without being any.
   */
  const abandoned =
    !res.ok && res.reason === 'INCOMPLETE'
      ? await git.diffStat(repo).catch(() => null)
      : null;
  const salvaging = (abandoned?.files.length ?? 0) > 0;
  if (salvaging) {
    log.warn(
      `[${task.id}] the session stopped early but left ${abandoned!.files.length} changed ` +
        'file(s) — judging the work rather than the session',
    );
    journal(
      'note',
      `The session stopped before it finished (${res.reason}), leaving ` +
        `${abandoned!.files.length} changed file(s): ${abandoned!.files.slice(0, 8).join(', ')}. ` +
        'How it ended says nothing about whether the work is right, so the changes go to ' +
        'the same check, gate and review as any other. If they do not pass they are ' +
        'reverted, exactly as they would have been.',
    );
  }

  if (res.ok) consecutiveTimeouts.delete(agentId);

  if (!res.ok && !salvaging) {
    // Kept, because the note below describes it. Until now it said "reverted
    // and stashed" beside a debug line reading "Nothing to roll back".
    const undone = await git
      .rollback(repo, undefined, `${task.id} ${task.title} — ${res.reason ?? 'failed'}`)
      .catch(() => null);
    if (res.fatal) {
      // Quota exhausted / bad credentials: leave the task ready and abort the run.
      // The attempt goes back too — the provider refused before the agent saw
      // the task, so charging it a retry would punish the task for the outage.
      ledger.refundAttempt(task.id);
      ledger.setStatus(task.id, 'ready', `${res.reason}: ${res.stdout.slice(0, 300)}`);
      throw new FatalRunError(`${res.reason}: ${res.stdout.slice(0, 300)}`, agentId);
    }
    /*
     * Every dispatch this task got came back with nothing at all.
     *
     * `stalled` is not "the agent gave up" — it is a step-finish carrying zero
     * tokens in and zero out, which means the request never reached a model.
     * The loop above already asked twice more for free on exactly that reading.
     * Arriving here means all three came back the same way.
     *
     * Until run 23 the answer was to charge the attempt and move on to the next
     * task, which then did the same thing. That run dispatched 24 times, spent
     * zero tokens, and finished with four tasks marked `failed` and a report
     * that said INCOMPLETE eight times without once saying no model had run.
     * Reproduced outside ShanAuto afterwards: eight identical calls to the same
     * model, seven of them empty. Nothing was wrong with the tasks.
     *
     * So this is treated as what the fatal branch above already calls it — the
     * provider refusing before the agent saw the task, which must not be
     * charged to the task. FatalRunError takes THIS AGENT out of the run rather
     * than ending it: another provider on another quota can still pick the work
     * up, and if none can, the run stops with every task still `ready`.
     */
    if (res.stalled) {
      ledger.refundAttempt(task.id);
      ledger.setStatus(task.id, 'ready', `${res.reason}: the provider never ran the task`);
      throw new FatalRunError(
        `${STALLED_REDISPATCHES + 1} dispatches in a row came back with no tokens sent and ` +
          `none returned — the provider is not answering. Nothing was wrong with the task.`,
        agentId,
        true,
      );
    }
    /*
     * A hung provider, treated as the outage it is rather than as the task's
     * fault. Same disposition as the `stalled` branch above and for the same
     * reason: the attempt is refunded because the agent never got far enough to
     * be judged, and FatalRunError takes THIS AGENT out rather than ending the
     * run, so another provider on another quota can still pick the work up.
     */
    if (res.reason === 'TIMEOUT') {
      const n = (consecutiveTimeouts.get(agentId) ?? 0) + 1;
      consecutiveTimeouts.set(agentId, n);
      if (n >= TIMEOUTS_BEFORE_OUT) {
        ledger.refundAttempt(task.id);
        ledger.setStatus(task.id, 'ready', `TIMEOUT: the provider never finished the task`);
        throw new FatalRunError(
          `${n} dispatches in a row ran the full ${cfg.system.timeouts.task_s}s budget and were ` +
            `killed — the provider is not finishing. Nothing was wrong with the task.`,
          agentId,
          true,
        );
      }
    } else {
      consecutiveTimeouts.delete(agentId);
    }

    const why = blocked ? `BLOCKED: ${blocked.detail} — ${res.reason}` : `${res.reason}`;
    const retryable = keepTrying(task.id, attempt, cfg.system.limits.max_attempts, why);
    ledger.setStatus(task.id, retryable ? 'ready' : 'failed', `${why}: ${res.stdout.slice(0, 500)}`);
    log.warn(`[${task.id}] agent failed (${res.reason})${retryable ? ' - will retry' : ''}`);
    /*
     * The one thing the next attempt will actually read.
     *
     * A retry is handed `readTaskThread`, which carries verdicts — gate and
     * review. An attempt that died before the gate wrote neither, so until
     * 2026-08-21 the retry started with nothing at all. On run 14 that was
     * measured rather than argued: the INCOMPLETE task's thread came back zero
     * characters long, and it was about to repeat 466 seconds of work —
     * including rediscovering that the column its brief assumed exists does not
     * — with no idea it had ever run.
     *
     * Written only when there is a next attempt, and deliberately short: it
     * competes for the same budget as the verdicts, and a note that crowded out
     * the reason a later attempt was rejected would trade one blind retry for
     * another.
     */
    if (retryable) {
      const said = res.stdout.trim();
      // The tail, not the head: an agent's conclusions are the last thing it
      // says, which is the same reason `result` entries stay out of the thread.
      const tail = said.length > 700 ? `\u2026${said.slice(-700)}` : said;
      journal(
        'note',
        `Attempt ${attempt} did not finish (${res.reason}). ${treeNote(undone)}\n` +
          // Only worth saying when something really was undone: the warning is
          // about what a revert could NOT reach, and there is no revert to
          // qualify when the tree was already clean.
          (undone && undone.reverted > 0 ? `${SIDE_EFFECTS_SURVIVE}\n\n` : `\n`) +
          // Leads, when there is one. An agent that died on a refusal needs the
          // refusal before it needs its own transcript back.
          // This path IS the cut-short case: the agent did not return a result.
          (blocked ? `${refusalNote(blocked, true)}\n\n` : '') +
          /*
        * Attributed only when there is something to attribute. A driver whose
        * agent produced no text at all falls back to ShanAuto's own diagnosis
        * of the provider, and printing that under "what it reported" tells the
        * next model its predecessor said something it never said.
        */
          (res.spoke === false
            ? `It produced no account of what it was doing. What ShanAuto saw:\n${tail}`
            : `What it reported before it stopped:\n${tail}`),
      );
    }
    // Only remember the final verdict; a retry that later succeeds is noise.
    if (!retryable) {
      ledger.remember({
        repo: repo.id,
        kind: 'task_failed',
        task_id: task.id,
        reason: blocked
          ? `${task.title} — BLOCKED: ${blocked.detail}`
          : `${task.title} — agent failed: ${res.reason}`,
      });
    }
    return {
      outcome: 'failed',
      blocked,
      problem: { id: task.id, title: task.title, why, retrying: retryable },
    };
  }

  const g = await gate(cfg, task, repo, undefined, wasGreen);
  if (!g.ok) {
    // Revert exactly what the gate saw, not the whole worktree.
    // Labelled, so the stash it leaves can be told from the 37 beside it.
    await git.rollback(repo, g.diff.files, `${task.id} ${task.title}`).catch(() => undefined);

    /*
     * The repo's check failed. Was this task the cause of it?
     *
     * The tree has just been reverted to exactly what it was before the agent
     * touched it, so the question can be answered instead of guessed: run the
     * check once more. Still red on a tree the task is no longer in means the
     * task was never the reason, and no number of further attempts at it can
     * change that.
     *
     * Traced on 2026-08-20. Task Thbswhqeaoe was reverted and its four files
     * stashed because tests/api/test_stats.py failed — a test it never opened,
     * broken by rows example-api's own suite accumulates in app.db and never
     * cleans up, which ShanAuto pushed past the threshold by running that
     * suite four times in one run. It was then marked `ready`, so the next run
     * would spend another agent request learning the same thing.
     *
     * Costs one extra run of the check, on the failure path only. An earlier
     * version tried to answer it for free by matching the filenames in the
     * output against the diff; scripts/prove-gate.ts showed that wrong on the
     * ordinary case where a task breaks a test it does not touch.
     */
    let repoRed = false;
    if (g.baseFailed) {
      const after = await recheckRepo(cfg, repo);
      repoRed = !after.green;
      if (repoRed) {
        g.detail =
          `the project's own check was ALREADY failing, and still fails with this ` +
          `task reverted — so this is not its doing:\n${after.out}`.slice(0, 3000);
      }
      // Either way the answer is now measured rather than assumed, and the
      // cached baseline should say so for the tasks that follow.
      setBaselineCache(repo.id, after.green);
    }

    // The agent looked, found the work already present, and correctly did
    // nothing. That is a redundant task, not a failed one — counting it as a
    // failure hides a planning problem behind an execution statistic.
    if (g.failure === 'NO_CHANGES' && saysAlreadyDone(res.stdout)) {
      /*
       * O27. Until now this was the only outcome nobody checked. `NO_CHANGES`
       * and `saysAlreadyDone` both ask whether the claim was ASSERTED, which it
       * was; nothing asked whether it was TRUE. It is also the most expensive
       * one to get wrong — a drop teaches the planner's dedupe the work exists,
       * so the proposal that would have built it never comes back, and nothing
       * retracts it.
       *
       * The check costs nothing: the plan already wrote down which files and
       * symbols this task was going to add, and nobody was reading it back.
       */
      const claimed = checkDropClaim(repo, task);
      if (claimed.verdict === 'contradicted') {
        /*
         * Not dropped, and deliberately not failed either. The agent looked at
         * the wrong thing, or looked at the right thing and misread it; either
         * way it gets told exactly what is missing and sent back. Nothing is
         * remembered here — a false claim must not reach the dedupe pool, which
         * is the whole cost this guard exists to prevent.
         */
        const why = `ALREADY_DONE contradicted: ${claimed.evidence}`;
        const again = keepTrying(task.id, attempt, cfg.system.limits.max_attempts, why);
        ledger.setStatus(task.id, again ? 'ready' : 'failed', why);
        log.warn(`[${task.id}] said the work was already there — ${claimed.evidence}`);
        journal('gate', `REJECTED ${why}` + (again ? '\n(will retry)' : '\n(no attempts left)'));
        if (again) journal('note', contradictedNote(claimed));
        if (!again) {
          ledger.remember({
            repo: repo.id,
            kind: 'task_failed',
            task_id: task.id,
            reason: `${task.title} — claimed already done, and it was not: ${claimed.evidence}`,
          });
        }
        return {
          outcome: 'failed',
          problem: { id: task.id, title: task.title, why, retrying: again },
        };
      }

      const checked =
        claimed.verdict === 'confirmed'
          ? `agent reported the work was already done, and it is: ${claimed.evidence}`
          : `agent reported the work was already done (not verified: ${claimed.evidence})`;
      ledger.setStatus(task.id, 'dropped', checked);
      log.info(`[${task.id}] dropped — already implemented (${claimed.verdict})`);
      journal('drop', `agent found the work already present and changed nothing\n${claimed.evidence}`);
      // The expensive discovery. Recorded so the pre-dispatch check can make the
      // same call for free next time — and carrying whether anything confirmed
      // it, because this entry is what the planner's dedupe reads.
      ledger.remember({
        repo: repo.id,
        kind: 'already_done',
        task_id: task.id,
        paths: g.diff.files,
        reason: `${task.title} — ${checked}`,
      });
      return { outcome: 'dropped' };
    }

    /*
     * Retrying is for a task that might do better next time. A task reverted
     * for somebody else's failing test would do exactly as well and exactly as
     * badly, forever, so it is left alone until the project is repaired.
     */
    if (repoRed) g.failure = 'VERIFY_UNRELATED';
    /*
     * What the gate SAW is unchanged; what gets written down about it is not.
     *
     * `NO_CHANGES: agent produced no file changes` is a true observation and a
     * false diagnosis whenever the agent was refused a tool: it wrote nothing
     * because it was not allowed to. The verdict itself is deliberately
     * untouched here — only the sentence changes.
     *
     * Computed BEFORE the retry decision, because the decision now reads it.
     */
    const verdictLine = blocked
      ? `BLOCKED: ${blocked.detail}. The gate then reported ${g.failure}: ${g.detail}`
      : `${g.failure}: ${g.detail}`;

    /*
     * Which gate rejections are worth another dispatch: everything except the
     * one where trying again is the wrong move. A FORBIDDEN_PATH or a
     * TEST_TAMPER is the agent doing something it was told not to, and the
     * rework note now says so — but that is a reason to send it back with the
     * finding, not a reason to abandon the operator's work.
     *
     * ONE carve-out, and it is not about cost. `VERIFY_UNRELATED` means the
     * repo's own check was already failing before this task ran, so the task is
     * not the reason and cannot be the cure — it would "do exactly as well and
     * exactly as badly, forever". This is not the work being dropped: a repair
     * job is queued for the project, and when it lands
     * `reopenUnrelatedFailures` puts every task reverted for that failure back
     * in the queue, in the same run. ShanAuto does fix this one itself; it just
     * does not fix it by re-running the same task into a red repo.
     *
     * `blocked` USED to be a second carve-out and no longer is. See
     * `refusalNote`: a refused agent is now told what refused it and sent back
     * to route around it, which is something it can actually do. The reason
     * handed to `keepTrying` is the verdict line, which NAMES the refused
     * command — so being refused the same thing twice still stops it, and being
     * refused something new counts as progress, because it is.
     */
    const retryable =
      g.failure !== 'VERIFY_UNRELATED' &&
      keepTrying(task.id, attempt, cfg.system.limits.max_attempts, verdictLine);

    ledger.setStatus(task.id, retryable ? 'ready' : 'failed', verdictLine);
    log.warn(
      `[${task.id}] ${blocked ? 'BLOCKED, gate rejected' : 'gate rejected'}: ` +
        `${g.failure} - ${g.detail.slice(0, 200)}`,
    );
    // The most valuable line in the journal: the next task can read why this
    // approach was rejected instead of rediscovering it.
    journal(
      'gate',
      `REJECTED ${verdictLine}` +
        (retryable ? `\n(will retry)\n${SIDE_EFFECTS_SURVIVE}` : '\n(no attempts left)'),
    );
    /*
     * The refusal, spelled out for whoever runs next. Kept separate from the
     * verdict above because the verdict says what the GATE saw, and a gate that
     * saw "no file changes" is describing a symptom of this.
     */
    // Reached only when the agent returned a result, so it was not cut short.
    if (retryable && blocked) journal('note', refusalNote(blocked, false));
    /*
     * Not `else if`, but close: a blocked agent's NO_CHANGES is a symptom of the
     * refusal, and `refusalNote` is the note that fits it. This one is for the
     * agent that was refused nothing and still wrote nothing.
     */
    if (retryable && !blocked && g.failure === 'NO_CHANGES') {
      journal('note', noChangesNote());
    }
    if (!retryable) {
      ledger.remember({
        repo: repo.id,
        kind: 'gate_rejection',
        task_id: task.id,
        paths: g.diff.files,
        reason: blocked
          ? `${task.title} — BLOCKED: ${blocked.detail} (gate then saw ${g.failure})`
          : `${task.title} — gate rejected ${g.failure}: ${g.detail.slice(0, 160)}`,
      });
    }
    return {
      outcome: 'failed',
      blocked,
      problem: { id: task.id, title: task.title, why: verdictLine, retrying: retryable },
      repoRed,
    };
  }

  /*
   * The gate said the change is correct BY MEASUREMENT: the project's own
   * check ran and passed. The senior is asked the question the check cannot
   * answer — whether the tests that passed are able to fail at all.
   *
   * Placed here, after the gate and before the commit, because both sides of
   * that matter. Reviewing before the gate would spend a model call on work
   * the check was going to reject anyway. Reviewing after the commit would be
   * a review of something already pushed.
   */
  const review = await qaVerdict(cfg, task, agentId, repo, g, res.stdout);
  if (review?.verdict === 'rework') {
    const verdictLine = `QA_REWORK: ${review.summary}`;
    // Same revert as a gate rejection, and for the same reason: the next
    // attempt must start from the tree the task was planned against, not from
    // a half-accepted version of its own last try.
    await git.rollback(repo, g.diff.files).catch(() => undefined);

    const retryable = keepTrying(task.id, attempt, cfg.system.limits.max_attempts, verdictLine);
    ledger.setStatus(task.id, retryable ? 'ready' : 'failed', verdictLine);
    log.warn(`[${task.id}] senior sent it back: ${review.summary.slice(0, 200)}`);
    /*
     * The findings go in the journal in full, because the journal is what the
     * next attempt is handed as context. Summarising here would leave the
     * intern to guess at the defect it was sent back to fix.
     */
    journal(
      'review',
      `${renderReview(review)}\n` +
        (retryable
          ? `(reverted; one more attempt)\n${SIDE_EFFECTS_SURVIVE}`
          : '(reverted; no attempts left)'),
    );
    if (!retryable) {
      ledger.remember({
        repo: repo.id,
        kind: 'qa_rework',
        task_id: task.id,
        paths: g.diff.files,
        reason: `${task.title} — senior rejected: ${review.summary.slice(0, 160)}`,
      });
    }
    return {
      outcome: 'failed',
      problem: { id: task.id, title: task.title, why: verdictLine, retrying: retryable },
    };
  }
  // An approval is worth recording: it is the senior saying, in the journal the
  // next task reads, that this shape of work was acceptable.
  if (review) journal('review', renderReview(review));
  /*
   * A ship from the understudy is the one fallback that has to outlive the run.
   *
   * Everything else a fallback touches can be re-read and re-judged later. This
   * one authorised a commit and a push to the operator's GitHub, and the log
   * line that said so scrolls away. It goes in the ledger's memory, where the
   * operator looks when they want to know why something is on their account.
   */
  if (review?.author?.fallback) {
    ledger.remember({
      repo: repo.id,
      kind: 'qa_fallback_ship',
      task_id: task.id,
      paths: g.diff.files,
      reason:
        `${task.title} — approved by ${review.author.model}, not the configured senior, ` +
        'which could not answer. The push went ahead on the understudy verdict.',
    });
  }

  /*
   * A denial that did not stop the work is still a denial.
   *
   * Run 16: the agent was refused `bash: python -c`, did the job some other
   * way, passed the gate and shipped. Nothing was wrong with the result - the
   * repo's own check ran and passed - but the operator's allow-list is missing
   * something an agent needed, and every path that said so up to here was a
   * failure path. On a run that commits, the sentence never got printed.
   */
  if (blocked) {
    ledger.remember({
      repo: repo.id,
      kind: 'blocked_ship',
      task_id: task.id,
      paths: g.diff.files,
      reason:
        `${task.title} — ${blocked.detail}. It worked around the refusal, the repo's ` +
        'own check passed, and the change was committed and pushed anyway.',
    });
  }

  /*
   * A declared contract change, recorded where it outlives the run.
   *
   * Run 12 planned `/api/unanswered-queries/frequent` from a bare list to
   * `{data, message}` - an endpoint that was already committed and already had
   * tests, whose own instruction included rewriting those tests to match. The
   * plan said `feature`, the brief said nothing, the gate saw green tests, and
   * the operator found out by reading the diff. Declaring it is now the
   * planner's job; keeping the declaration is this one's.
   */
  /*
   * ...but only over a commit somebody could actually be broken by.
   *
   * `task.breaking` is written by the planner, at plan time, out of a file tree
   * and a list of names — before any of the code that would break anyone
   * exists. It then becomes two claims that outlive the run: the
   * conventional-commits `!` and `BREAKING CHANGE:` footer, which is the marker
   * release tooling reads, and a bold line on the operator's report saying that
   * behaviour changed.
   *
   * On 2026-08-23, run 22 shipped both over a diff of one test file.
   * `Txmndc7k0hx` was aimed at a function that already did what the plan wanted
   * doing, so the junior proved it with a test and committed — the only honest
   * move left to it. The senior said as much in the same run: "because no
   * production code was modified, nothing in the repo behaves differently now".
   * The report announced a breaking change on the same page.
   *
   * A diff that touches no production file cannot break a caller. That needs no
   * judgement, so it is settled here instead of being asked of anybody.
   */
  const testsOnly = g.diff.files.length > 0 && g.diff.files.every((f) => isTestPath(f));
  const breaking = testsOnly ? undefined : (task.breaking ?? undefined);
  if (testsOnly) {
    log.warn(
      `[${task.id}] shipped tests and no production change` +
        (task.breaking
          ? ' — the plan predicted a breaking change and it did not happen.'
          : '.'),
    );
  }

  if (breaking) {
    ledger.remember({
      repo: repo.id,
      kind: 'breaking_ship',
      task_id: task.id,
      paths: g.diff.files,
      reason: `${task.title} - ${breaking}`,
    });
  }

  const msg = git.commitMessage(task.kind, task.title, task.acceptance, breaking, true);
  // Commit exactly what the gate inspected — not whatever else is in the tree.
  const { sha, pushed } = await git.commitAndPush(repo, msg, g.diff.files);
  ledger.markCommitted(task.id, sha);
  /*
   * F4: the gate just ran repo.verify_cmd and it exited 0, so this repo is green
   * NOW regardless of what baselineGreen measured before the agent touched it.
   * Without this the TRIVIAL floor re-applies to the very next task on the repo,
   * treating a single-file commit as too small to count as work.
   */
  setBaselineCache(repo.id, true);
  // SEC-7: a local-only commit is not a delivered one; say so instead of
  // letting the run summary count it silently.
  if (!pushed) {
    log.warn(
      `[${task.id}] ${sha.slice(0, 8)} is LOCAL ONLY — push failed, the commit is not on origin yet.`,
    );
  }
  log.info(`[${task.id}] committed ${sha.slice(0, 8)}  (${g.detail})`);
  journal(
    'commit',
    `committed ${sha.slice(0, 8)} — ${g.detail}\nfiles: ${g.diff.files.join(', ')}` +
      // Read by the next task as context, and by the operator afterwards. A
      // commit entry that omits this is the one that reads as untroubled.
      (blocked ? `\nBLOCKED on the way: ${blocked.detail}` : ''),
  );
  return { outcome: 'committed', blocked, testsOnly };
}

export async function runBatch(
  cfg: AppConfig,
  initial: TaskRow[],
  stopRequested: StopCheck = killswitchSet,
  redRepos: Set<string> = new Set(),
): Promise<RunSummary> {
  const sum: RunSummary = {
    attempted: 0, committed: 0, failed: 0, sentBack: 0, handoff: 0, dropped: 0, parked: 0,
    blocked: 0, blockedBy: [], blockedShipped: [], breakingShipped: [], testsOnlyShipped: [],
    agentsOut: [], problems: [], held: [], stashes: [],
  };
  // Per run: an agent that hung yesterday starts today with a clean slate.
  consecutiveTimeouts.clear();
  lastFailure.clear();
  /*
   * One wait-and-retry per run, and only one. See OUTAGE_WAIT_MS: this is the
   * whole of what keeps waiting out an outage from becoming a hang.
   */
  let waitedOutAnOutage = false;
  /** Repos this run actually dispatched into; only those are worth reporting on. */
  const touched = new Set<string>();
  /*
   * The cache is NOT cleared here.
   *
   * `run` measures each repo before selecting the batch — that is where the
   * decision to queue a repair job is made — and clearing it would throw that
   * reading away and force a second full test-suite run. Worse, the re-read
   * would happen at GATE time, after the agent had already edited the tree, so
   * it would measure the result rather than the baseline and answer the wrong
   * question. `resetBaselineCache` is exported for the caller that starts a run.
   */
  const deadline = Date.now() + cfg.system.limits.max_run_hours * 3600_000;
  const { start, end } = cfg.system.work_hours;

  /*
   * This run's own share of the ceiling, fixed here and never re-read.
   *
   * `committedToday()` answers a question about the clock, and the loop asked it
   * again every iteration. Work hours were opened to 00:00-23:59 on 2026-08-08,
   * which makes a run that crosses local midnight ordinary rather than exotic —
   * and at midnight that count resets to zero mid-run and silently hands the
   * same run a fresh full budget. The ceiling exists so a bug cannot spend the
   * whole day; it could not stop a bug that ran past midnight.
   *
   * Counting what THIS run has committed is clock-independent, so a run can
   * never exceed max_daily_commits however long it lives. The daily check below
   * is kept as well: it is what still stops a second run started later the same
   * day, and it is what makes the reset between separate runs legitimate.
   */
  const alreadyCommittedToday = ledger.committedToday();
  const runCeiling = Math.max(0, cfg.system.max_daily_commits - alreadyCommittedToday);

  /*
   * Work through a queue that is topped up as the run proceeds, rather than a list
   * fixed at the start. Committing a task unblocks its dependents, and with a
   * one-shot list those newly-ready tasks sat idle until the next day even with
   * hours of window left.
   */
  const queue = [...initial];
  const seen = new Set(initial.map((t) => t.id));
  // Warned once per run, not once per task: the point is to be noticed, and a
  // line repeated after every dispatch is a line that gets scrolled past.
  let warnedOverBudget = false;

  /*
   * Which tasks are being withheld right now, by repo.
   *
   * A set rather than a counter, because a task can stop being held: the repair
   * job lands, the repo goes green, and the work it was blocking is released
   * mid-run. A counter would only ever go up, and the report would end up
   * claiming work was withheld that the same run went on to commit.
   */
  const heldNow = new Map<string, Set<string>>();

  const refill = () => {
    /*
     * F6: the run's own red-repo list must apply to what a refill adds, not just
     * the initial batch. `run` filters the first selectBatch and passes the rest
     * here, but every later refill used to pull red-repo work straight back in —
     * and that work is guaranteed to fail the gate until the repair task lands.
     */
    const { runnable, held } = holdBlockedWork(selectBatch(cfg), redRepos);
    for (const t of runnable) {
      heldNow.get(t.repo)?.delete(t.id); // released: its repo is green again
      if (!seen.has(t.id)) {
        seen.add(t.id);
        queue.push(t);
      }
    }
    /*
     * `held` used to be destructured away and dropped on the floor, which is how
     * the 2026-08-12 report came to say `attempted 1 · committed 1 · stopped
     * because: batch exhausted` in a table whose next line read `backlog ready:
     * 8`. The batch was not exhausted; eight jobs had been withheld and nothing
     * anywhere recorded it. Withholding the work is correct — it cannot pass the
     * gate — but doing it silently produces a report that reads as "out of work"
     * on a night when there was plenty of it.
     */
    for (const t of held) {
      const set = heldNow.get(t.repo) ?? new Set<string>();
      set.add(t.id);
      heldNow.set(t.repo, set);
    }
  };

  for (;;) {
    if (queue.length === 0) {
      refill(); // dependents unblocked by the last commit
      if (queue.length === 0) break;
    }
    const task = queue.shift()!;

    /*
     * An agent that went out earlier in this run gets no more tasks — but the
     * task is only skipped once its whole pool is out. `reroute` hands it to a
     * pool-mate first; the routing screen already calls the work "shared with"
     * them, and a run that stops with a healthy agent idle throws away the
     * independent quota it exists to have.
     *
     * A genuinely skipped task is left exactly as it was — `ready`, attempts
     * untouched — and `seen` keeps a refill from offering it again, so the next
     * run picks it up as though this one had never reached it.
     */
    const outNow = new Set(sum.agentsOut.filter((a) => !a.recovered).map((a) => a.agent));
    const firstChoice = pickAgent(cfg, task);
    const routedTo = reroute(cfg, task, outNow);
    if (!routedTo) {
      const out = sum.agentsOut.find((a) => a.agent === firstChoice);
      if (out) out.skipped++;
      log.info(`[${task.id}] skipped — nothing left that can take it (${firstChoice} is out)`);
      continue;
    }
    if (stopRequested()) {
      sum.stopped = 'KILLSWITCH';
      log.warn('Killswitch present - stopping.');
      break;
    }
    if (Date.now() > deadline) {
      sum.stopped = 'MAX_RUN_HOURS';
      log.warn('Run budget exhausted - stopping.');
      break;
    }
    if (!withinWorkHours(start, end)) {
      sum.stopped = 'OUTSIDE_WORK_HOURS';
      log.warn(`Outside work hours (${start}-${end}) - stopping.`);
      break;
    }
    if (ledger.committedToday() >= cfg.system.max_daily_commits) {
      sum.stopped = 'DAILY_CEILING';
      log.warn('Daily commit ceiling hit - stopping.');
      break;
    }
    if (sum.committed >= runCeiling) {
      // Reached only by a run that outlived the day it started in.
      sum.stopped = 'RUN_CEILING';
      log.warn(
        `This run has committed its whole share of the daily ceiling ` +
          `(${runCeiling} of ${cfg.system.max_daily_commits}) - stopping.`,
      );
      break;
    }
    if (sum.committed >= cfg.system.daily_target) {
      sum.stopped = 'TARGET_MET';
      log.info(`Daily target of ${cfg.system.daily_target} met.`);
      break;
    }

    /*
     * Announced here, not up with the routing decision, because everything
     * between the two can still stop the run. A real run on 2026-08-15 said
     * "copilot is out for this run — agy takes it instead." and then stopped on
     * the operator's own stop request one line later, having told them agy was
     * taking a job agy never touched. Deciding is not doing; only say it where
     * the doing begins.
     */
    if (routedTo !== firstChoice) {
      log.info(`[${task.id}] ${firstChoice} is out for this run — ${routedTo} takes it instead.`);
    }

    sum.attempted++;
    touched.add(task.repo);
    let result: TaskResult;
    try {
      result = await runOne(cfg, task, routedTo);
    } catch (e) {
      if (e instanceof FatalRunError) {
        /*
         * Not the end of the run — the end of this AGENT's run. Three providers
         * on three independent quotas is the whole point of the system; stopping
         * all of them because one is exhausted throws away the other two.
         *
         * The run does still stop when nothing remaining can be dispatched: the
         * check below looks at what is actually queued rather than at how many
         * agents are left. What counts as dispatchable is `reroute`, not the
         * stable pick — the queue is finished when no eligible agent is left for
         * any of it, not when the agent it happened to hash to is gone.
         */
        sum.agentsOut.push({ agent: e.agent, why: e.message, skipped: 0 });
        log.error(`${e.agent} is out for this run — ${e.message}`);

        const stillOut = new Set(sum.agentsOut.filter((a) => !a.recovered).map((a) => a.agent));
        const live = queue.filter((t) => reroute(cfg, t, stillOut) !== null);
        if (live.length === 0) {
          /*
           * O22. Nothing left that can run — but if the reason is a provider
           * having a bad few minutes, that is worth waiting out ONCE before
           * giving the rest of the day back.
           *
           * The earlier fix stopped an outage costing the TASKS: they are left
           * `ready` with their attempts refunded. What it did not address is
           * that the run ends there, and with both pools pointed at one agent
           * that is the rest of the day. Rerouting is not the answer — agy is
           * the senior and a reviewer marking its own homework reviews nothing
           * — so the answer is to wait, briefly and once.
           *
           * Once is what makes this a pause rather than a hang. A provider that
           * is still down when we look again ends the run exactly as before,
           * two minutes later.
           */
          if (e.transient && !waitedOutAnOutage) {
            waitedOutAnOutage = true;
            const secs = Math.round(OUTAGE_WAIT_MS() / 1000);
            log.warn(
              `${e.agent} is the only agent left and it is not answering. Waiting ${secs}s ` +
                `and trying once more before giving up the rest of the day.`,
            );
            await sleep(OUTAGE_WAIT_MS());
            // Back in play. The timeout tally goes too, or the first dispatch
            // after the wait inherits the count that took it out.
            // Marked, not deleted: routing must stop treating it as out, and
            // the report must still say the outage happened.
            for (const a of sum.agentsOut) if (a.agent === e.agent) a.recovered = true;
            consecutiveTimeouts.delete(e.agent);
            log.info(`Trying ${e.agent} again.`);
            continue;
          }
          sum.stopped = `FATAL: ${e.message}`;
          log.error(`Nothing left that a live agent can run - stopping.`);
          break;
        }
        log.info(`Continuing with ${live.length} task(s) routed to other agents.`);
        continue;
      }
      log.error(`[${task.id}] unhandled error: ${(e as Error).message}`);
      ledger.setStatus(task.id, 'failed', (e as Error).message);
      // F2: mirror runOne's failure path — an unexpected throw must not leave the
      // agent's edits in the tree for the next task to trip over. Resolved from
      // the task, same as runOne does.
      const repo = resolveRepo(cfg, task.repo);
      await git.rollback(repo).catch(() => undefined);
      result = {
        outcome: 'failed',
        // An unhandled throw is terminal: setStatus above wrote 'failed'
        // outright, without consulting the attempt count.
        problem: {
          id: task.id,
          title: task.title,
          why: `unhandled error: ${(e as Error).message}`,
          retrying: false,
        },
      };
    }
    sum[result.outcome]++;
    // `retrying` is set by whoever rejected it and is the only thing that knows
    // whether this outcome is final. A rejection on the last attempt leaves it
    // false, so a genuine failure still counts as one.
    if (result.problem?.retrying) sum.sentBack++;
    if (result.problem) sum.problems.push(result.problem);

    /*
     * A task just set back to `ready` for another attempt has to leave `seen`,
     * or the attempt never happens in this run.
     *
     * `runOne` sets the status itself on a gate rejection or a rework, and every
     * report and every test read that as "it will be retried". It was not, here:
     * `seen` still held the id from the first offer, and `refill` discards any id
     * it recognises. So `max_attempts: 2` bought a second attempt TOMORROW — the
     * ledger said ready, attempts said 1 of 2, and the run that had just written
     * the findings walked straight past the work they were about to be used on.
     *
     * The same `seen` reasoning as the two deletes below: `seen` means offered,
     * and a task handed back for rework has stopped being offered. Attempts are
     * NOT reset — see DECISIONS.md, "Attempts are deliberately not reset". The
     * bound is what makes this a second chance instead of a loop; all this
     * decides is whether the second chance happens now or a day later.
     */
    if (result.problem?.retrying) seen.delete(result.problem.id);

    /*
     * A repo can go red in the middle of a run, and until now nothing noticed.
     *
     * `run` measures every repo once, before the first dispatch, and hands the
     * red ones here to be held. That is the whole of it — the set was never
     * added to again. So a project that was green at 13:04 and red at 13:12
     * kept being handed work, and every remaining task died on someone else's
     * failure.
     *
     * Not hypothetical, and not rare: on 2026-08-20 it was ShanAuto's OWN gate
     * runs that did it. example-api's suite writes to a database it never cleans
     * up, one test asks for the top 10 documents by retrieval count, and each
     * run of the suite adds another row. Running the suite four times in one
     * run is what pushed it over ten. The next two tasks survived only because
     * an agent quietly rewrote the offending test — which is the other half of
     * this fix, TEST_TAMPER, and had it been in place first the run would have
     * ended 0 of 4 instead of 3 of 4.
     *
     * Reusing the run-start path exactly: mark the repo red, queue the one job
     * worth doing on a red repo, and hold the rest. The gate has already told
     * us what failed, so that text becomes the repair brief instead of paying
     * for another full suite run to rediscover it.
     */
    if (result.repoRed && !redRepos.has(task.repo)) {
      redRepos.add(task.repo);
      // The gate ran the check and it was red. Say so, or the TRIVIAL floor
      // spends the rest of the run treating this repo as green.
      setBaselineCache(task.repo, false);
      log.warn(
        `${task.repo} went red during this run, on something no task here ` +
          `changed. Holding its remaining work until it passes again.`,
      );
      await ensureRepairTask(cfg, resolveRepo(cfg, task.repo), result.problem?.why).catch(
        (e: unknown) =>
          log.warn(`could not queue a repair job for ${task.repo}: ${(e as Error).message}`),
      );
      const { runnable, held } = holdBlockedWork(queue, redRepos);
      queue.length = 0;
      queue.push(...runnable);
      for (const t of held) {
        const set = heldNow.get(t.repo) ?? new Set<string>();
        set.add(t.id);
        heldNow.set(t.repo, set);
        /*
         * Held is not the same as offered, and `seen` means offered.
         *
         * Leaving it set makes the release silent: the repair lands, the repo
         * goes green, refill finds the work and drops every one of it on the
         * floor because it recognises the id. The 2026-08-20 run logged
         * "its held work is back in play" and then ended with five jobs
         * untouched and a report claiming none were held — the batch was not
         * exhausted, it was forgotten.
         *
         * Only reachable since a repo can go red MID-run. Before that a red
         * repo was known at run start and `run` filtered its work out of the
         * initial batch, so held ids never entered `seen` in the first place.
         */
        seen.delete(t.id);
      }
    }
    if (task.breaking && result.outcome === 'committed' && !result.testsOnly) {
      sum.breakingShipped.push({ id: task.id, title: task.title, what: task.breaking });
    }

    if (result.outcome === 'committed' && result.testsOnly) {
      sum.testsOnlyShipped.push({
        id: task.id,
        title: task.title,
        predicted: task.breaking ?? null,
      });
    }

    if (result.blocked && result.outcome === 'committed') {
      /*
       * A denial the work survived. It goes on a separate list rather than into
       * `blocked`, whose count the report presents as part of `failed` - adding
       * a committed task to it would make the report's own arithmetic wrong.
       */
      sum.blockedShipped.push({
        id: task.id,
        title: task.title,
        permissions: result.blocked.permissions,
      });
    } else if (result.blocked) {
      /*
       * Counted only once the task is FINISHED with, not once per dispatch.
       *
       * A refusal is retried now, and a task refused twice is still one blocked
       * task. The report presents `blocked` as part of `failed`, and `failed`
       * is netted against `sentBack` — so a per-dispatch count here reads
       * `blocked: 2` beside `netFailed: 1` for a single task, and the report's
       * own arithmetic stops adding up. Same guard as `ledger.remember` on
       * both failure paths, for the same reason.
       */
      if (!result.problem?.retrying) sum.blocked++;
      /*
       * The NAMES are collected on every dispatch, retrying or not: a command
       * that was refused was refused, and it belongs on the operator's list
       * even when the agent went on to route around it and ship. That case ends
       * as a commit, so nothing else in the run would ever mention it.
       *
       * Deduped: 17 tasks blocked by one missing entry is one thing to fix, and
       * the report should read that way. Deduped across the whole run, not
       * within a task - two tasks denied the same command is still one entry to
       * add, and one task denied two commands is still two.
       */
      for (const name of result.blocked.permissions) {
        if (!sum.blockedBy.includes(name)) sum.blockedBy.push(name);
      }
    }

    // A soft budget, and deliberately soft: it warns and the run carries on.
    // Anything that can stop work belongs in limits, next to the hard ceiling,
    // where it is obvious that it can.
    if (!warnedOverBudget) {
      const b = dailyBudget(cfg);
      if (b.over) {
        warnedOverBudget = true;
        log.warn(`Agent spend today is ${b.line}. Soft budget — nothing has been stopped.`);
      }
    }

    /*
     * The repo is green again — stop holding its work back.
     *
     * A commit is only reachable through the gate, and the gate runs the repo's
     * own `verify_cmd` and requires exit 0. So a commit to a repo IS the proof
     * that the repo passes its own check — the same proof `baselineGreen` goes
     * and buys with a full test run, which is why `setBaselineCache(repo, true)`
     * is already set on this path. `redRepos` was a second copy of that fact
     * that nobody updated, and the two disagreed for the rest of the run.
     *
     * What that cost, from the ledger: on 2026-08-12 run R4oyj70s3v2 attempted
     * exactly ONE task, committed it — the example-api repair job — and stopped.
     * Repairing example-api is what made its other eight jobs runnable, and the run
     * held every one of them back because it was still working from the reading
     * it took before the repair. `stopped because: batch exhausted`, against a
     * daily target of 30. 2026-08-09 ended the same way: 4 attempted, 1
     * committed. They are the two lowest non-zero days in the whole history, and
     * they are exactly the two days a repair task landed.
     *
     * Keyed on the repo, not on `isRepairTask`: in a red repo nothing BUT the
     * repair task is dispatched, so the two are the same set here — and if that
     * ever stops being true, the gate's verdict is still the thing that matters.
     */
    if (result.outcome === 'committed' && redRepos.delete(task.repo)) {
      log.info(
        `${task.repo} passes its own check again — its held work is back in play.`,
      );
      /*
       * Including the work that was already reverted, not only the work held.
       *
       * A task rejected VERIFY_UNRELATED is one the gate went and PROVED
       * innocent. Marking it failed was right while the repo was red and wrong
       * the moment the repair landed.
       *
       * `seen.delete` for the same reason it appears above: `seen` means
       * offered, and refill drops any id it recognises. Without it this reads
       * as fixed and changes nothing, which is exactly how the held-work bug
       * survived its own fix.
       */
      for (const id of ledger.reopenUnrelatedFailures(task.repo)) {
        seen.delete(id);
        log.info(`  ${id} was reverted for that failure — back in the queue.`);
      }
    }
  }

  // Read at the end, so it reports what is STILL held rather than everything
  // that was ever held — the two differ exactly when a repair job landed.
  for (const [repo, ids] of heldNow) {
    if (ids.size) sum.held.push({ repo, count: ids.size });
  }

  /*
   * Count the set-aside work last, so a stash this run created is included and
   * one it dropped as empty is not. Wrapped: a failure to read the stash list is
   * not a reason to lose the run's report.
   */
  sum.stashes = await git.stashSummary([...touched].map((id) => resolveRepo(cfg, id)));
  return sum;
}
