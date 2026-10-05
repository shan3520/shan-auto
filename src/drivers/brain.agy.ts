import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import { existsSync } from 'node:fs';
import type { ZodTypeAny, output } from 'zod';
import type { BrainAuthor, BrainDriver, DriverOpts } from './contracts.js';
import { ensureDir, truncate, safeEnv } from '../util.js';
import { p } from '../config.js';
import { log } from '../logger.js';
import { askWithRepair, FatalBrainError } from './askloop.js';

/**
 * Planner backed by Antigravity's CLI (`agy`).
 *
 * Runs with NO `--add-dir`, so the agent has no workspace it may write to and
 * the call degenerates to a plain text->JSON round trip. The repo context it
 * needs is supplied in the prompt.
 *
 * Worth knowing: agy authenticates through the Antigravity suite rather than a
 * Google AI Studio API key, so its quota is independent of the gemini-*
 * per-day request limits that constrain the opencode brain. If one is
 * exhausted, the other may still be fine - which is exactly why both are
 * registered and either can be `brain.active`.
 */
const QUOTA_PATTERNS = [/quota/i, /rate.?limit/i, /resource.?exhausted/i, /ineligible/i, /no longer supported/i];
const AUTH_PATTERNS = [/unauthor/i, /not logged in/i, /authenticat/i, /sign in/i];

/**
 * The brain reached for a tool it does not have.
 *
 * On 2026-08-08 agy repeatedly tried `command` and `read_file` while planning.
 * There is no workspace and no `--add-dir`, headless mode has nobody to prompt,
 * so each attempt was auto-denied and agy exited with nothing at all:
 *
 *   jetski: no output produced — a tool required the "command" permission that
 *   headless mode cannot prompt for, so it was auto-denied.
 *
 * Left generic, that is indistinguishable from a hang: 20-50 silent seconds, a
 * spent provider request, and two more repair attempts that reproduce it
 * exactly, because nothing about the next attempt makes the tool appear. Quota
 * is this system's binding constraint, so it is classified fatal — one call per
 * model instead of three. config/prompts/_no-tools.md is the other half of the
 * fix; this half is what holds when the model ignores it.
 */
const TOOL_DENIED_PATTERNS = [
  /permission that headless mode cannot prompt for/i,
  /auto-denied/i,
  /permissions\.allow/i,
];

/**
 * True when this run produced no answer, only a notice about one.
 *
 * Deliberately NOT a length test. The denial notice is ~140 chars, well past
 * the 40-char "too short to be real" bar used below, so length alone would let
 * it through — while a plan whose text merely quotes the notice (this repo's
 * own backlog contains such tasks) would be destroyed by an unguarded match.
 * Every brain answer is a fenced json object, so a stdout with no `{` in it is
 * not an answer, and only then may it be read as an error.
 */
function hasNoAnswer(stdout: string): boolean {
  return !stdout.includes('{');
}

export type BrainFailure = 'TOOL_DENIED' | 'QUOTA' | 'AUTH' | null;

/**
 * Decide whether a round-trip was a failure, and which kind.
 *
 * Exported and pure so a test can call THIS, rather than a copy of it. The test
 * that used to guard this rule re-declared the pattern lists locally and had
 * already drifted — it carried a `/credential/i` the driver never had, and would
 * have kept passing if the classifier were deleted outright. A test that
 * reimplements the thing it checks is testing itself.
 */
export function classifyBrainOutput(stdout: string, stderr = ''): BrainFailure {
  const out = (stdout ?? '').trim();
  const err = (stderr ?? '').trim();
  const both = `${out}\n${err}`;

  // First, and against both streams: agy prints this notice INSTEAD of an
  // answer and has used stdout for it. hasNoAnswer keeps the wider scan honest.
  if (hasNoAnswer(out) && TOOL_DENIED_PATTERNS.some((re) => re.test(both))) return 'TOOL_DENIED';

  // Errors are read where errors appear. A substantive stdout is an answer, and
  // its contents are not evidence — see the incident above.
  const suspect = out.length < 40 ? both : err;
  if (QUOTA_PATTERNS.some((re) => re.test(suspect))) return 'QUOTA';
  if (AUTH_PATTERNS.some((re) => re.test(suspect))) return 'AUTH';
  return null;
}

/**
 * Windows caps a whole command line at 32767 characters, and the prompt travels
 * as an argv element. Over that, CreateProcess fails before anything runs:
 * execa reports ENAMETOOLONG with `exitCode: undefined` and BOTH streams empty,
 * in about 2ms.
 *
 * That is indistinguishable from "the model returned nothing" unless it is
 * named, and for days it silently ate the first attempt on every model - the
 * first specifically, because attempt 0 carries the full prompt while every
 * repair after it is short enough to fit. A third of the attempt budget, spent
 * on a command that never ran, while quota is this system's binding constraint.
 */
const WINDOWS_COMMAND_LINE_MAX = 32767;

export class AgyBrain implements BrainDriver {
  readonly id = 'agy';
  /** Set on every answered `ask`; see BrainDriver.answered. */
  answered?: BrainAuthor;
  private bin: string;
  private models: string[];
  private timeoutS: number;
  private maxRepairs: number;

  constructor(opts: DriverOpts & { timeoutS?: number; fallbackModel?: string; maxRepairs?: number }) {
    this.bin = (opts.bin as string) ?? `${process.env.LOCALAPPDATA ?? ''}\\agy\\bin\\agy.exe`;
    // agy is happy with no --model at all; an empty string means "use the default".
    this.models = [(opts.model as string) ?? '', ...(opts.fallbackModel ? [opts.fallbackModel] : [])];
    this.timeoutS = opts.timeoutS ?? 240;
    this.maxRepairs = opts.maxRepairs ?? 2;
  }

  async init(): Promise<void> {
    if (!existsSync(this.bin)) {
      throw new Error(`agy not found at ${this.bin}. Install Antigravity, or switch brain.active to opencode.`);
    }
  }

  private argv(text: string, model: string): string[] {
    const args = ['-p', text, '--print-timeout', `${Math.max(1, Math.floor(this.timeoutS / 60))}m`];
    if (model) args.push('--model', model);
    return args;
  }

  /**
   * What one argument actually costs on a Windows command line.
   *
   * Not its length. CreateProcess takes a single string, so each argument is
   * wrapped in quotes, every " inside becomes \", and any run of
   * backslashes immediately before a quote is doubled. The decompose prompt is
   * largely JSON examples: the template alone carries 70 quotes before a single
   * ledger section is filled in, and the journal quotes task titles on top of
   * that.
   *
   * Counting `a.length + 3` is what let 283542f trim a prompt to a budget it
   * still could not spawn on 2026-08-18 - the guard and the budget shared one
   * wrong model, so they agreed with each other and the spawn failed anyway.
   */
  private static quotedLength(a: string): number {
    let n = 2; // the surrounding quotes
    let slashes = 0;
    for (const ch of a) {
      if (ch === '\\') {
        slashes++;
        n++;
        continue;
      }
      if (ch === '\"') {
        // the run before it doubles, and the quote itself becomes two chars
        n += slashes + 2;
        slashes = 0;
        continue;
      }
      slashes = 0;
      n++;
    }
    // a trailing run doubles too, against the closing quote
    return n + slashes;
  }

  /**
   * Exposed because the caller assembling the prompt is the only one that can
   * shrink it, and it cannot budget against a cost it is unable to measure.
   */
  promptCost(text: string): number {
    return AgyBrain.quotedLength(text);
  }

  private commandLineLength(args: string[]): number {
    return [this.bin, ...args].reduce((n, a) => n + AgyBrain.quotedLength(a) + 1, 0);
  }

  /**
   * What is left for the prompt once this driver's own arguments are on the
   * line. Measured against the longest model name it may use, so the budget
   * does not change when the loop falls back.
   */
  get maxPromptChars(): number {
    const widest = this.models.reduce((a, b) => (a.length >= b.length ? a : b), '');
    return WINDOWS_COMMAND_LINE_MAX - this.commandLineLength(this.argv('', widest));
  }

  private async once(text: string, model: string): Promise<string> {
    const started = Date.now();
    const cwd = p('data', 'brain-cwd');
    ensureDir(cwd);

    const args = this.argv(text, model);

    /*
     * Refuse before spawning rather than after. The spawn failure is silent on
     * both streams, so a prompt that cannot be delivered has to be reported
     * here or it is reported nowhere.
     */
    const commandLine = this.commandLineLength(args);
    if (commandLine > WINDOWS_COMMAND_LINE_MAX) {
      throw new FatalBrainError(
        'PROMPT_TOO_LONG',
        `command line is ${commandLine} chars, ${commandLine - WINDOWS_COMMAND_LINE_MAX} over the ` +
          `${WINDOWS_COMMAND_LINE_MAX}-char Windows limit (prompt alone is ${text.length}). ` +
          `Nothing was sent. Fit the prompt to brain.maxPromptChars before calling.`,
      );
    }

    const res = await execa(this.bin, args, {
      cwd,
      reject: false,
      timeout: (this.timeoutS + 30) * 1000,
      killSignal: 'SIGKILL',
      // As everywhere: a piped stdin that never closes makes CLIs block forever.
      stdin: 'ignore',
      // Strip the environment (SEC-1/SEC-3): the model's tool calls run
      // arbitrary code on this machine, so credentials must not be present.
      extendEnv: false,
      env: safeEnv({ NO_COLOR: '1' }),
      maxBuffer: 32 * 1024 * 1024,
    });

    const out = stripAnsi(res.stdout ?? '').trim();
    const err = stripAnsi(res.stderr ?? '').trim();
    log.debug(`agy brain round-trip ${Date.now() - started}ms, ${out.length} chars`);

    const failure = classifyBrainOutput(out, err);
    if (failure === 'TOOL_DENIED') {
      log.warn(
        `agy brain asked for a tool and was auto-denied, so it returned nothing. ` +
          `The brain has no workspace by design; see config/prompts/_no-tools.md. ` +
          `Not retrying ${model || 'the default model'} — the denial recurs identically.`,
      );
      throw new FatalBrainError('TOOL_DENIED', truncate(`${out}\n${err}`.trim(), 400));
    }
    if (failure) {
      // QUOTA and AUTH are read from the error stream, so that is what is quoted.
      throw new FatalBrainError(failure, truncate(out.length < 40 ? `${out}\n${err}` : err, 400));
    }
    if (res.timedOut) throw new Error(`agy timed out after ${this.timeoutS}s`);
    if (!out) {
      /*
       * `exit undefined` was the whole diagnosis for a process that never
       * started, and it reads as a hang or a flaky provider. When there is no
       * exit code the reason is on the result object, not on either stream.
       */
      const why =
        res.exitCode === undefined
          ? ((res as { shortMessage?: string }).shortMessage ?? 'the process did not start')
          : `exit ${res.exitCode}`;
      throw new Error(`agy returned nothing (${why}): ${truncate(res.stderr ?? '', 300)}`);
    }
    return out;
  }

  async ask<S extends ZodTypeAny>(
    text: string,
    schema: S,
    label: string,
    accept?: (data: output<S>) => string | null,
  ): Promise<output<S>> {
    // Cleared first: a throw must not leave the previous call's attribution
    // standing for a caller that reads it after catching.
    this.answered = undefined;
    return askWithRepair(
      (t, m) => this.once(t, m),
      this.models,
      text,
      schema,
      label,
      this.maxRepairs,
      accept,
      (model, fallback) => {
        this.answered = { model: model || 'default', fallback };
      },
    );
  }

  async dispose(): Promise<void> {
    /* stateless */
  }
}

export default AgyBrain;
