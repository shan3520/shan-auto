import { execa } from 'execa';
import type { ZodTypeAny, output } from 'zod';
import type { BrainAuthor, BrainDriver, DriverOpts } from './contracts.js';
import { archive, log } from '../logger.js';
import { ensureDir, truncate, sleep, safeEnv } from '../util.js';
import { p } from '../config.js';
import { parseOcStream, isFatal } from './ocstream.js';
import { askWithRepair, FatalBrainError } from './askloop.js';

/**
 * The brain is a pure text->JSON call. It gets all the repo context it needs
 * inside the prompt, so it runs in an EMPTY scratch directory with tools that
 * cannot prompt. Two reasons, both learned the hard way:
 *
 *  - Run it inside a real project and the model starts exploring the tree with
 *    file tools, turning a 7-second call into minutes.
 *  - Any permission set to "ask" has nothing to answer it in a non-interactive
 *    run, so the call blocks until the timeout instead of failing.
 *
 * Highest-precedence inline config, so it overrides whatever is in the global
 * or project opencode.json.
 */
const BRAIN_CONFIG = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  permission: {
    external_directory: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    question: 'deny',
    task: 'deny',
    doom_loop: 'allow',
  },
});

/**
 * Planner backed by `opencode run --format json`.
 *
 * Non-interactive, no browser, no session state to expire. This is why the
 * autonomous loop does not depend on the chat driver: opencode already has
 * model credentials (Google / Groq free tiers) and runs headless.
 */
export class OpenCodeBrain implements BrainDriver {
  readonly id = 'opencode';
  /** Set on every answered `ask`; see BrainDriver.answered. */
  answered?: BrainAuthor;
  private model: string;
  private fallback: string | undefined;
  private bin: string;
  private timeoutS: number;
  private maxRepairs: number;
  /*
   * Transient-error retries INSIDE one `once()` call. These multiply with
   * askWithRepair's schema retries: 3 x 3 was 9 provider calls for a single
   * failed ask, which is reckless when quota is the binding constraint. Two
   * inner attempts keeps the worst case at 6.
   *
   * The delay is injectable so tests do not pay it in wall-clock time — a
   * hard-coded 2s sleep made one test exceed its timeout and turned the whole
   * suite red, which in turn blocked every task, because the gate runs `npm test`.
   */
  private retryAttempts: number;
  private retryDelayMs: number;

  constructor(opts: DriverOpts & { timeoutS?: number; fallbackModel?: string; maxRepairs?: number }) {
    this.model = (opts.model as string) ?? 'google/gemini-3.6-flash';
    this.fallback = opts.fallbackModel;
    this.bin = (opts.bin as string) ?? 'opencode';
    this.timeoutS = opts.timeoutS ?? 240;
    this.maxRepairs = opts.maxRepairs ?? 2;
    this.retryAttempts = (opts.retryAttempts as number) ?? 2;
    this.retryDelayMs = (opts.retryDelayMs as number) ?? 2000;
  }

  async init(): Promise<void> {
    const { exitCode } = await execa(this.bin, ['--version'], { reject: false });
    if (exitCode !== 0) throw new Error(`"${this.bin}" is not runnable. Is opencode on PATH?`);
  }

  /** One raw round-trip. Args are passed as an array, so nothing is shell-escaped. */
  private async once(text: string, model: string): Promise<string> {
    const cwd = p('data', 'brain-cwd');
    ensureDir(cwd);

    return this.executeWithRetry(async () => {
      const started = Date.now();
      const res = await execa(
        this.bin,
        ['run', '--format', 'json', '-m', model, text],
        {
          reject: false,
          timeout: this.timeoutS * 1000,
          killSignal: 'SIGKILL',
          // Must be 'ignore'. execa's default piped stdin is never closed, and
          // opencode blocks reading it instead of ever calling the model.
          stdin: 'ignore',
          // Strip the environment (SEC-1/SEC-3): the model's tool calls run
          // arbitrary code on this machine, so credentials must not be present.
          // OPENCODE_CONFIG_CONTENT is the guardrail config above, not a secret.
          extendEnv: false,
          env: safeEnv({ NO_COLOR: '1', OPENCODE_CONFIG_CONTENT: BRAIN_CONFIG }),
          // Empty scratch dir: nothing to explore, so the model just answers.
          cwd,
          maxBuffer: 32 * 1024 * 1024,
        },
      );

      const parsed = parseOcStream(res.stdout ?? '');
      log.debug(
        `brain round-trip ${Date.now() - started}ms, ${parsed.text.length} chars, ${parsed.events} event(s)`,
      );

      if (parsed.failure) {
        const msg = `${parsed.failure} — ${truncate(parsed.errorMessage, 400)}`;
        // Quota / auth / dead model: retrying the same model is a wasted call.
        if (isFatal(parsed.failure)) throw new FatalBrainError(parsed.failure, msg);
        throw new Error(msg);
      }
      if (res.timedOut) {
        throw new Error(
          `opencode timed out after ${this.timeoutS}s with no error event. ` +
            `Usually the provider is throttling and opencode is retrying internally.`,
        );
      }
      if (!parsed.text.trim()) {
        throw new Error(`opencode returned no text (exit ${res.exitCode}): ${truncate(res.stderr ?? '', 300)}`);
      }
      return parsed.text;
    }, this.retryAttempts, this.retryDelayMs);
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxAttempts: number,
    delayMs: number,
  ): Promise<T> {
    let attempt = 1;
    const limit = Math.max(1, maxAttempts);
    
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof FatalBrainError || attempt >= limit) {
          throw error;
        }
        attempt++;
        await sleep(delayMs);
      }
    }
  }

  async ask<S extends ZodTypeAny>(
    text: string,
    schema: S,
    label: string,
    accept?: (data: output<S>) => string | null,
  ): Promise<output<S>> {
    const models = [this.model, ...(this.fallback ? [this.fallback] : [])];
    // Cleared first: a throw must not leave the previous call's attribution
    // standing for a caller that reads it after catching.
    this.answered = undefined;
    return askWithRepair(
      (t, m) => this.once(t, m),
      models,
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

export default OpenCodeBrain;
