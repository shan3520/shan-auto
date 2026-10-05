import { describe, it, expect } from 'vitest';
import { parseOcStream, isFatal, refusalName } from '../ocstream.js';

const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

const say = (text: string) => ({ type: 'text', part: { text } });
const step = (reason: string) => ({ type: 'step_finish', part: { reason } });
const boom = (name: string, message: string) => ({ type: 'error', error: { name, data: { message } } });

const REFUSED =
  'The user has specified a rule which prevents you from using this specific tool call. ' +
  'Here are some of the relevant rules: python -c *';

const refused = (tool: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  part: { tool, state: { status: 'error', error: REFUSED, input } },
});

/*
 * Measured on zero12, 2026-08-21. Five dispatches, two of which produced no file
 * changes at all and were both recorded as "— ok in 371s" / "— ok in 249s".
 *
 *   finished   3 dispatches   last step_finish reason "stop",    546-602 tokens
 *   aborted    2 dispatches   last step_finish reason "unknown",   0 tokens
 *
 * Neither dead stream carried an `error` event, so `failure` was null, the exit
 * code was 0, and the driver reported success on a session that stopped
 * mid-sentence. The gate then said NO_CHANGES — true about the files, false
 * about the cause — and one of the two was a second and final attempt, so the
 * task is now permanently `failed` on the strength of a session that died.
 */
describe('a session that stopped is not a session that changed nothing', () => {
  it('calls an abort INCOMPLETE even though nothing errored', () => {
    const out = parseOcStream(stream(say('Let me check the search API endpoint for'), step('unknown')));
    expect(out.failure).toBe('INCOMPLETE');
    expect(out.errorMessage).toContain('unknown');
    // The partial narration is kept: it is the only evidence of what it was
    // doing when it died, and the operator has nothing else to read.
    expect(out.text).toContain('search API endpoint');
  });

  it('leaves a session that ran to the end alone', () => {
    expect(parseOcStream(stream(say('done'), step('stop'))).failure).toBeNull();
  });

  /*
   * The one that decides whether this rule is usable at all. `tool-calls` is the
   * reason on EVERY step that called a tool, so it is on almost every step of
   * almost every healthy run. Reading any step instead of the last one would
   * mark practically every successful session as a failure.
   */
  it('judges the last step, not any step', () => {
    const healthy = stream(step('tool-calls'), say('a'), step('tool-calls'), say('b'), step('stop'));
    expect(parseOcStream(healthy).failure).toBeNull();
    expect(parseOcStream(healthy).finishReason).toBe('stop');
  });

  /*
   * "I did not see the end" must not be reported as "it ended badly". A stream
   * carrying no step_finish at all is an older or differently-shaped output, and
   * inventing a failure from its absence would fail every one of them.
   */
  it('says nothing about a stream that carried no steps', () => {
    expect(parseOcStream(stream(say('hello'))).failure).toBeNull();
    expect(parseOcStream('').failure).toBeNull();
  });

  it('does not relabel a real provider error as an abort', () => {
    const out = parseOcStream(stream(boom('QuotaError', 'You exceeded your current quota'), step('unknown')));
    expect(out.failure).toBe('QUOTA');
    expect(out.errorMessage).toContain('quota');
  });

  /*
   * The bound that makes this a second chance rather than noise. A dead session
   * is precisely the failure where running the same thing again is the right
   * answer — unlike a quota wall, which the same request cannot get past.
   */
  it('is retryable, unlike the walls', () => {
    expect(isFatal('INCOMPLETE')).toBe(false);
    expect(isFatal('QUOTA')).toBe(true);
    expect(isFatal('CONTEXT_OVERFLOW')).toBe(true);
  });
});

/*
 * `ExecResult.deniedTools` has existed since 2026-08-08, `detectBlocked`
 * consumes it, and its own comment describes this exact failure: "the verdict
 * reads as an accusation against the model when the real cause was a permission
 * list". The opencode driver — the one that does all the work — never filled it.
 * zero12's two dead dispatches contained five refusals between them and produced
 * not one BLOCKED warning.
 */
describe('the refusals opencode never reported', () => {
  it('collects a refused call', () => {
    const out = parseOcStream(stream(refused('bash', { command: 'python -c "import marshal"' }), step('unknown')));
    expect(out.deniedTools).toEqual(['bash: python -c']);
  });

  /*
   * Five refusals of `python -c` are one line for the operator to add to a
   * permission list, not five. A verdict that repeats itself is a verdict that
   * gets skimmed.
   */
  it('says each one once', () => {
    const out = parseOcStream(
      stream(
        refused('bash', { command: 'python -c "a"' }),
        refused('bash', { command: 'python -c "b"' }),
        step('unknown'),
      ),
    );
    expect(out.deniedTools).toEqual(['bash: python -c']);
  });

  /*
   * The distinction the whole thing rests on. A shell command that fails with
   * the OS's own "Permission denied" is the agent's problem to solve; reporting
   * it as a refusal excuses the agent for a wall it could have walked around.
   */
  it('ignores a tool error that is not a refusal', () => {
    const oops = {
      type: 'tool_use',
      part: {
        tool: 'bash',
        state: { status: 'error', error: 'sh: ./x: Permission denied', input: { command: './x' } },
      },
    };
    expect(parseOcStream(stream(oops, step('stop'))).deniedTools).toEqual([]);
  });

  it('ignores a tool call that simply succeeded', () => {
    const ok = {
      type: 'tool_use',
      part: { tool: 'read', state: { status: 'completed', input: { filePath: 'a.py' } } },
    };
    expect(parseOcStream(stream(ok, step('stop'))).deniedTools).toEqual([]);
  });
});

/*
 * Named for the operator, who has to act on it. `bash` is broadly allowed and
 * specific patterns are denied, so "the agent was denied bash" points at nothing
 * to change — the first two words are what the deny list actually matches on.
 */
describe('naming a refusal the way it would have to be allowed', () => {
  it('reduces a shell call to the pattern behind it', () => {
    expect(refusalName('bash', { command: '  python -c "import marshal, sys"  ' })).toBe('bash: python -c');
    expect(refusalName('bash', { command: 'git push origin main' })).toBe('bash: git push');
  });

  it('names the file for a file tool, since that is the rule that stopped it', () => {
    expect(refusalName('read', { filePath: 'D:/repos/shanauto/.zero12/artifacts/x.md' })).toBe(
      'read: D:/repos/shanauto/.zero12/artifacts/x.md',
    );
  });

  it('falls back to the bare tool name rather than to nothing', () => {
    expect(refusalName('webfetch', {})).toBe('webfetch');
    expect(refusalName('bash', undefined)).toBe('bash');
    expect(refusalName('', undefined)).toBe('tool');
  });
});

/*
 * Measured on zero15, 2026-08-21. Four dispatches across two tasks.
 *
 *   ran     1 dispatch    reason "stop",     29 tool calls incl. 9 edits, tokens > 0
 *   stalled 3 dispatches  reason "unknown",  7-14 read/glob/grep calls, 0 edits,
 *                                            in=0 out=0 cost=0 after 69-115s
 *
 * The three dead ones are not the same animal as a session that thought about
 * the task and gave up: nothing was spent, so nothing was tried. Telling them
 * apart is the whole point, because a caller that cannot will either burn a
 * real attempt on an outage or re-run work that genuinely happened.
 */
describe('a step that cost nothing is a step that never ran', () => {
  const ran = (reason: string, input: number, output: number) => ({
    type: 'step_finish',
    part: { reason, tokens: { input, output } },
  });

  it('calls an aborted step that spent nothing stalled', () => {
    const out = parseOcStream(stream(say('Let me look at the search service'), ran('unknown', 0, 0)));
    expect(out.failure).toBe('INCOMPLETE');
    expect(out.stalled).toBe(true);
  });

  /*
   * The distinction this file exists for. Both of these aborted. Only one of
   * them wasted the provider's time rather than the model's, and only that one
   * is worth asking again.
   */
  it('does not call an aborted step that produced output stalled', () => {
    const out = parseOcStream(stream(say('half a patch'), ran('unknown', 900, 240)));
    expect(out.failure).toBe('INCOMPLETE');
    expect(out.stalled).toBe(false);
  });

  it('counts a step that read the prompt but wrote nothing as having run', () => {
    // Input alone still means a model was handed the work and answered.
    expect(parseOcStream(stream(ran('unknown', 900, 0))).stalled).toBe(false);
  });

  it('never calls a session that ran to the end stalled', () => {
    // The healthy fixtures throughout this file carry no token counts at all,
    // so a rule that looked only at tokens would condemn every one of them.
    expect(parseOcStream(stream(say('done'), step('stop'))).stalled).toBe(false);
    expect(parseOcStream(stream(say('done'), ran('stop', 4000, 1200))).stalled).toBe(false);
  });

  /*
   * The run-15 shape exactly: the agent oriented itself over several live steps
   * and THEN the provider went quiet. Summing tokens across the session would
   * see a busy transcript and call it healthy.
   */
  it('judges the step the session ended on, not the ones before it', () => {
    const out = parseOcStream(
      stream(ran('tool-calls', 5000, 300), say('reading'), ran('tool-calls', 6000, 120), ran('unknown', 0, 0)),
    );
    expect(out.stalled).toBe(true);
  });

  /*
   * A refusal, a crash or a timeout is a real answer about this task. Asking
   * again would just collect it again, more slowly.
   */
  it('leaves a failure that is not an abort alone', () => {
    const out = parseOcStream(stream(boom('ProviderError', 'model overloaded'), ran('unknown', 0, 0)));
    expect(out.failure).not.toBe('INCOMPLETE');
    expect(out.stalled).toBe(false);
  });
});
