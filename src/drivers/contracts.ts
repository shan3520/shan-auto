import type { ZodTypeAny, output } from 'zod';
import type { Repo, TaskRow } from '../schemas.js';

/** Any driver config block from config/drivers.yaml. */
export type DriverOpts = Record<string, unknown>;

/**
 * The autonomous planner. Must be non-interactive and callable unattended.
 */
/**
 * Which model produced an answer, and whether it was a fallback rather than
 * the configured first choice.
 *
 * A fallback is a decision about WHO did the judging, so anything that
 * publishes a verdict to the operator has to be able to say it changed.
 */
export interface BrainAuthor {
  model: string;
  /** True when an earlier model in the list was tried and could not answer. */
  fallback: boolean;
}

export interface BrainDriver {
  readonly id: string;
  init(): Promise<void>;
  /**
   * Ask for a structured answer. Implementations MUST validate + repair.
   * Generic over the schema (not the payload) so the return type is zod's
   * *output* type, with defaults applied.
   *
   * `accept` is the caller's semantic gate, run only on output the schema
   * already accepted. Return null to take the answer, or the objection to send
   * back for repair. A schema is a poor judge of usefulness: a model that
   * answers with a well-formed `"Sample Task"` placeholder satisfies zod
   * completely, and without this the loop returned it as a success and never
   * reached the fallback model. Rejecting on the merits must cost the same as
   * failing to parse, or the stronger model is consulted only for the failures
   * that happen to be malformed.
   */
  /**
   * Which model produced the last answer this driver returned, and whether it
   * was a fallback rather than the configured first choice.
   *
   * Optional and driver-reported: a driver with one model has nothing to say,
   * and a caller that does not care is unaffected. Callers that publish a
   * verdict to the operator should say so when `fallback` is true — see
   * DECISIONS.md, "A verdict was attributed to the driver, not the model".
   *
   * Read straight after the `ask` whose answer it describes. Tasks run one at a
   * time and each driver is built per call site, but this is still the last
   * answer and not a per-call return value; do not stash it and read it later.
   */
  readonly answered?: BrainAuthor;
  ask<S extends ZodTypeAny>(
    prompt: string,
    schema: S,
    label: string,
    accept?: (data: output<S>) => string | null,
  ): Promise<output<S>>;
  /**
   * How many characters of prompt this driver can actually deliver, if it has a
   * limit worth respecting. Callers that assemble a prompt from elastic parts
   * should fit it to this rather than guess.
   *
   * A transport property, not a model property: agy is spawned as a process and
   * the prompt rides in argv, which Windows caps at 32767 characters for the
   * whole command line. Past that nothing runs, and the caller cannot tell that
   * from the model declining to answer.
   */
  readonly maxPromptChars?: number;
  /**
   * What `text` will cost against `maxPromptChars`, when that is not simply its
   * length. Callers fitting a prompt to the budget must measure with this, or
   * they will trim to a size that still does not fit: agy rides in argv, and
   * Windows doubles every quote in an argument before CreateProcess sees it.
   */
  promptCost?(text: string): number;
  dispose(): Promise<void>;
}

/**
 * Optional human-input channel (a chat UI you type into).
 * The autonomous loop never depends on this being available.
 */
export interface ChatDriver {
  readonly id: string;
  init(): Promise<void>;
  /** Read out messages you typed since `sinceIso`, newest last. */
  harvest(sinceIso: string): Promise<string[]>;
  /** Send a prompt and return the reply text. */
  ask(prompt: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface ExecResult {
  ok: boolean;
  /**
   * Did the agent itself say anything, or is `stdout` only ShanAuto's account?
   *
   * O26. On the INCOMPLETE path a driver with no agent text falls back to its
   * own diagnosis — *the session stopped after a step that finished with reason
   * "unknown"* — and the retry note printed that under the heading "What it
   * reported before it stopped:". The next model was shown a description of the
   * provider and told its predecessor had said it.
   *
   * The information was never missing: `OcParsed` keeps `text` and
   * `errorMessage` in separate fields and the boundary here flattened them.
   * Undefined means "not stated", which every other driver leaves it at and
   * which is read as agent text — those return the agent's own output and
   * nothing else, so that is the true reading for them.
   */
  spoke?: boolean;
  /** 'handoff' means a human must finish this in a GUI; it is not a failure. */
  handoff?: boolean;
  /** Provider quota/auth exhausted: the whole run should stop, not just this task. */
  fatal?: boolean;
  /** Truncated. The untrimmed original is at `rawPath`. */
  stdout: string;
  durationMs: number;
  reason?: string;
  /**
   * Tool permissions this agent asked for and was refused.
   *
   * A refusal is neither a failure nor laziness: the agent writes nothing, the
   * gate reports NO_CHANGES, and the verdict reads as an accusation against the
   * model when the real cause was a permission list. On 2026-08-08 that cost two
   * full debugging rounds across 17 tasks. The drivers already knew — the
   * Copilot stream parser has collected these names all along — and this is the
   * field that finally carries them out to the executor. Drivers with no
   * structured output (agy) say the same thing with `reason: 'PERMISSION_DENIED'`.
   */
  deniedTools?: string[];
  /**
   * This dispatch ended on a step the provider never ran.
   *
   * Optional and driver-reported, like `deniedTools` above: only opencode's
   * stream says enough to know, and absent means "cannot tell", never "no".
   *
   * The executor treats it as a dispatch that did not happen rather than as an
   * attempt that went badly, because the two are charged differently — see the
   * redispatch loop in `runOne`.
   */
  stalled?: boolean;
  /**
   * What this dispatch cost against the provider's allowance.
   *
   * Optional, and deliberately never defaulted to 0. Only copilot reports a
   * figure (`result.usage.premiumRequests`); agy and opencode report nothing,
   * and a missing figure means unknown, not free. Defaulting it would quietly
   * understate every run on the constraint this whole system is bound by.
   */
  costUnits?: number;
  /**
   * Where the agent's complete, untruncated output was archived.
   *
   * Every consumer downstream trims: the driver caps stdout, and the journal
   * caps again. Without this the original was simply gone, which made the
   * journal's clip the last cut rather than a convenience view.
   */
  rawPath?: string;
}

/**
 * The hands. Anything that can be pointed at a repo and told to make a change.
 */
/**
 * The idea a task descends from, exactly as the operator wrote it.
 *
 * Deliberately not a summary. Every other statement of the job reaching an
 * agent has been through at least three model paraphrases, each one narrower
 * than the last; this is the one that has not.
 */
export interface OriginatingIdea {
  title: string;
  body: string;
}

export interface AgentDriver {
  readonly id: string;
  readonly kind: 'cli' | 'ide';
  /**
   * @param context Recent working-journal text: what was tried just before this,
   *   and how it went. Optional, and optional on purpose — a driver that ignores
   *   it still behaves correctly, and the journal being unavailable must never
   *   stop a task from running.
   * @param rework Why this task's LAST attempt was rejected, when there was one:
   *   the gate's failure and the senior's findings, in their own words. Absent on
   *   a first attempt, and absent is the whole of the difference — a driver that
   *   drops it turns every retry back into a cold repeat of the attempt that was
   *   already refused.
   *
   *   Separate from `context` because the two are read differently: `context` is
   *   advisory background about other work, and this is binding about this task.
   * @param idea The complaint the task ultimately came from, in the operator's
   *   own words. A parameter rather than a field on the row - which is how the
   *   brief travels - because it is not task state: it is not derived from
   *   routing, it is not rewritten between attempts, and it is the same text for
   *   every task under the same idea. That makes it context, and it sits beside
   *   the other two for the same reason they do.
   *
   *   Optional, and a driver may ignore it. What it changes is the ALREADY_DONE
   *   verdict, which without it is taken against the brief - a document three
   *   paraphrases removed from what was asked for. See taskprompt's
   *   alreadyDoneLines.
   */
  execute(
    task: TaskRow,
    repo: Repo,
    timeoutS: number,
    context?: string,
    rework?: string,
    idea?: OriginatingIdea | null,
  ): Promise<ExecResult>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
