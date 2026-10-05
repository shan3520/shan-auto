/**
 * Parser for `opencode run --format json` NDJSON output.
 *
 * The important part is the `error` event. opencode reports provider failures
 * there and then retries internally with backoff, emitting nothing else. Without
 * reading it, a quota error looks exactly like a hang, and the caller burns its
 * whole timeout budget on a call that was never going to succeed.
 */

export type OcFailure =
  | 'QUOTA'
  | 'CONTEXT_OVERFLOW'
  | 'MODEL_UNAVAILABLE'
  | 'AUTH'
  | 'PROVIDER'
  | 'INCOMPLETE'
  | null;

export interface OcParsed {
  text: string;
  failure: OcFailure;
  errorMessage: string;
  events: number;
  /**
   * Tool calls opencode refused on one of its own permission rules.
   *
   * Named for the operator: the tool, and for a shell call the first words of
   * the command, which is the thing they would have to allow. Deduped, because
   * five refusals of `python -c` are one entry to add, not five.
   */
  deniedTools: string[];
  /**
   * The `reason` on the last step-finish in the stream, or '' if the stream
   * carried none. See INCOMPLETE below.
   */
  finishReason: string;
  /**
   * The session ended on a step the provider never ran.
   *
   * A step-finish carrying zero input AND zero output tokens did not happen:
   * nothing was sent to the model and nothing came back. That is distinct from
   * a session that stopped mid-thought having produced tokens, and it is the
   * signature of an outage rather than of an agent giving up.
   *
   * Measured on run 15 (2026-08-21), where it decided the whole run. Three of
   * four dispatches ended this way — 7, 14 and 7 tool calls of orienting reads,
   * then a final step with in=0 out=0 cost=0 after 69 to 115 seconds, no text,
   * and nothing to roll back. The fourth ran 24 steps and finished on `stop`.
   * Both tasks failed, one of them holding a correct review with an exact fix
   * and no attempt left to apply it, because a step the provider never ran had
   * been charged against the task's budget of two.
   *
   * Only meaningful together with INCOMPLETE: a completed session's last step
   * legitimately reports the reason `stop`, and is not this.
   */
  stalled: boolean;
}

function classify(name: string, message: string): OcFailure {
  const m = message.toLowerCase();
  if (m.includes('exceeded your current quota') || m.includes('resource_exhausted')) return 'QUOTA';
  if (name === 'ContextOverflowError' || m.includes('request too large') || m.includes('tokens per minute')) {
    return 'CONTEXT_OVERFLOW';
  }
  if (m.includes('no longer available') || m.includes('not found') || m.includes('does not exist')) {
    return 'MODEL_UNAVAILABLE';
  }
  if (m.includes('api key') || m.includes('unauthorized') || m.includes('permission denied')) return 'AUTH';
  if (m.includes('rate_limit') || m.includes('rate limit')) return 'QUOTA';
  return name ? 'PROVIDER' : null;
}

/**
 * opencode's own sentence when a permission rule refuses a tool call, copied
 * from .zero12/artifacts on 2026-08-21:
 *
 *   The user has specified a rule which prevents you from using this specific
 *   tool call. Here are some of the relevant rules [...]
 *
 * Matched on that literal rather than on the word "permission", because a shell
 * command that fails with the OS's own "Permission denied" is a different event
 * entirely — that one IS the agent's problem to solve, and reporting it as a
 * refusal would excuse the agent for a wall it could have walked around.
 */
const REFUSAL = 'prevents you from using';

/**
 * Name the refused call the way the operator would have to allow it.
 *
 * A shell refusal is the interesting case, and the only one where the tool name
 * alone says nothing: `bash` is broadly allowed and specific patterns are
 * denied, so "the agent was denied bash" points at nothing to change. The first
 * two words are what the deny list matches on (`python -c *`, `git push *`).
 */
export function refusalName(tool: string, input: Record<string, unknown> | undefined): string {
  const t = tool || 'tool';
  const cmd = typeof input?.command === 'string' ? input.command.trim() : '';
  if (t === 'bash' && cmd) return `bash: ${cmd.split(/\s+/).slice(0, 2).join(' ')}`;
  const path = typeof input?.filePath === 'string' ? input.filePath : '';
  return path ? `${t}: ${path}` : t;
}

/**
 * The finish reason of a session that ran to completion. Anything else at the
 * END of a stream means it stopped in the middle of something.
 */
const COMPLETED = 'stop';

export function parseOcStream(stdout: string): OcParsed {
  let text = '';
  let failure: OcFailure = null;
  let errorMessage = '';
  let events = 0;
  let finishReason = '';
  let lastStepRan = false;
  const denied: string[] = [];

  for (const line of (stdout ?? '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    events++;
    try {
      const ev = JSON.parse(s) as {
        type?: string;
        part?: {
          text?: string;
          tool?: string;
          reason?: string;
          tokens?: { input?: number; output?: number };
          state?: { status?: string; error?: string; input?: Record<string, unknown> };
        };
        error?: { name?: string; data?: { message?: string } };
      };
      if (ev.type === 'text' && typeof ev.part?.text === 'string') {
        text += ev.part.text;
      } else if (ev.type === 'step_finish') {
        finishReason = typeof ev.part?.reason === 'string' ? ev.part.reason : '';
        // Kept per step rather than summed: what matters is whether the step the
        // session ENDED on ran, not whether the session did any work earlier.
        const tk = ev.part?.tokens;
        lastStepRan = (tk?.input ?? 0) > 0 || (tk?.output ?? 0) > 0;
      } else if (ev.type === 'tool_use' && ev.part?.state?.status === 'error') {
        const err = ev.part.state.error ?? '';
        if (err.includes(REFUSAL)) {
          const name = refusalName(ev.part.tool ?? '', ev.part.state.input);
          if (!denied.includes(name)) denied.push(name);
        }
      } else if (ev.type === 'error') {
        const name = ev.error?.name ?? '';
        const msg = ev.error?.data?.message ?? '';
        // Keep the first error; later ones are retries of the same problem.
        if (!failure) {
          failure = classify(name, msg);
          errorMessage = `${name}: ${msg}`.trim();
        }
      }
    } catch {
      /* partial line */
    }
  }

  /*
   * A session that died is not a session that decided to change nothing.
   *
   * Measured across zero12's five dispatches on 2026-08-21. The three that
   * finished ended on `reason: "stop"` with 546-602 output tokens and a closing
   * summary. The two that produced no changes at all ended on
   * `reason: "unknown"` with zero tokens, mid-sentence, and carried no `error`
   * event anywhere — so `failure` was null, the exit code was 0, and the driver
   * reported ok. The journal recorded "— ok in 249s", and the gate then said
   * NO_CHANGES, which is true about the files and false about the cause. One of
   * those was a task's second and last attempt, so it is now permanently
   * `failed` on the strength of a session that never finished thinking.
   *
   * The empty reason is the guard, and it is load-bearing: a stream carrying no
   * step-finish at all is an older or a differently-shaped output, and "I did
   * not see the end" must not be reported as "it ended badly".
   */
  if (!failure && finishReason && finishReason !== COMPLETED) {
    failure = 'INCOMPLETE';
    errorMessage =
      `the session stopped after a step that finished with reason "${finishReason}" ` +
      `instead of "${COMPLETED}" — it did not run to the end`;
  }

  return {
    text,
    failure,
    errorMessage,
    events,
    deniedTools: denied,
    finishReason,
    stalled: failure === 'INCOMPLETE' && !lastStepRan,
  };
}

/**
 * Failures that will not fix themselves by trying the same model again.
 *
 * CONTEXT_OVERFLOW belongs here: the request was too large for the model's
 * per-minute token budget, and resending an identical payload cannot make it
 * smaller. Groq's free tier is 8k TPM against opencode's ~38k preamble — it will
 * never fit, so retrying just burns requests. Leaving it out cost 9 pointless
 * calls per failure, and made one test sleep for 12 seconds on every task.
 *
 * INCOMPLETE is deliberately NOT here. A session that died partway is the one
 * failure where doing the same thing again is the correct response.
 */
export function isFatal(f: OcFailure): boolean {
  return f === 'QUOTA' || f === 'AUTH' || f === 'MODEL_UNAVAILABLE' || f === 'CONTEXT_OVERFLOW';
}

export class QuotaError extends Error {
  constructor(
    readonly failure: OcFailure,
    message: string,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}
