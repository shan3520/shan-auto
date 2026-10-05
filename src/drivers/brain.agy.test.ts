import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';
import { z } from 'zod';
import { AgyBrain } from './brain.agy.js';

vi.mock('execa');

/**
 * Guards the 2026-08-08 incident: the brain reaching for a tool it does not have.
 *
 * It plans in an empty scratch dir with no --add-dir, so `command` and
 * `read_file` are auto-denied by headless mode, which has nobody to prompt. agy
 * then exits having printed only the notice below. Untreated, each occurrence
 * cost a provider request and 20-50 seconds, three times per model, and a run of
 * them exhausted every retry and killed a planning pass. Quota is this system's
 * binding constraint, so the outcome has to be recognised on the first one.
 */
const DENIAL_COMMAND =
  'jetski: no output produced — a tool required the "command" permission that ' +
  'headless mode cannot prompt for, so it was auto-denied.';
const DENIAL_READ_FILE =
  'jetski: no output produced — a tool required the "read_file" permission that ' +
  'headless mode cannot prompt for, so it was auto-denied.';

const TASKS = z.object({ tasks: z.array(z.object({ title: z.string() })) });

describe('AgyBrain auto-denied tool calls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('spends one request per model on a denial instead of every repair attempt', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: DENIAL_COMMAND, exitCode: 1 } as any);

    const brain = new AgyBrain({ model: 'm1', fallbackModel: 'm2', maxRepairs: 2 });
    await expect(brain.ask('plan this', TASKS, 'decompose')).rejects.toThrow(/TOOL_DENIED/);

    // 2 models x 1 attempt. Before this was classified it was 2 x 3.
    expect(execa).toHaveBeenCalledTimes(2);
  });

  it('recognises the denial when agy prints it on stdout rather than stderr', async () => {
    // The notice is ~140 chars, so it clears the "too short to be a real answer"
    // bar that gates the quota/auth scan. Treated as an answer it parsed as
    // nothing and burned all three attempts.
    vi.mocked(execa).mockResolvedValue({
      stdout: DENIAL_READ_FILE,
      stderr: '',
      exitCode: 0,
    } as any);

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 2 });
    await expect(brain.ask('plan this', TASKS, 'decompose')).rejects.toThrow(/TOOL_DENIED/);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('does not discard a real plan that happens to describe a denied tool call', async () => {
    // The exact regression this repo already suffered once with /authenticat/i:
    // a valid answer thrown away because of a word inside it. This backlog
    // literally contains tasks about auto-denied permissions.
    const plan = {
      tasks: [
        {
          title: 'Detect auto-denied tool calls in the brain',
          instruction:
            'agy returns nothing when a tool required the "command" permission ' +
            'that headless mode cannot prompt for, so it was auto-denied.',
        },
      ],
    };
    vi.mocked(execa).mockResolvedValue({
      stdout: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
      stderr: '',
      exitCode: 0,
    } as any);

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 2 });
    const got = await brain.ask('plan this', TASKS, 'decompose');

    expect(got.tasks[0]?.title).toBe('Detect auto-denied tool calls in the brain');
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('still retries an ordinary empty response, which may just be a blip', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: 'connection reset', exitCode: 1 } as any);

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 1 });
    const failure = await brain.ask('plan this', TASKS, 'decompose').catch((e: Error) => e);

    expect((failure as Error).message).toMatch(/returned nothing/);
    expect((failure as Error).message).not.toMatch(/TOOL_DENIED/);
    expect(execa).toHaveBeenCalledTimes(2);
  });

  it('does not label the fallback model with the first model\'s failure kind', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: '', stderr: DENIAL_COMMAND, exitCode: 1 } as any)
      .mockResolvedValue({ stdout: '', stderr: 'connection reset', exitCode: 1 } as any);

    const brain = new AgyBrain({ model: 'm1', fallbackModel: 'm2', maxRepairs: 1 });
    const failure = await brain.ask('plan this', TASKS, 'decompose').catch((e: Error) => e);

    // m1 was denied; m2 merely failed. Reporting the last error as TOOL_DENIED
    // would send the next investigation at the wrong problem.
    expect((failure as Error).message).not.toMatch(/TOOL_DENIED/);
    expect(execa).toHaveBeenCalledTimes(3); // m1 x1 (fatal), m2 x2
  });

  it('still classifies a genuine quota failure as quota, not as a denial', async () => {
    vi.mocked(execa).mockResolvedValue({
      stdout: '',
      stderr: 'RESOURCE_EXHAUSTED: quota exceeded for gemini-3.1-pro-high',
      exitCode: 1,
    } as any);

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 2 });
    await expect(brain.ask('plan this', TASKS, 'decompose')).rejects.toThrow(/QUOTA/);
    expect(execa).toHaveBeenCalledTimes(1);
  });
});


/**
 * The 2026-08-18 divergence, reproduced end to end.
 *
 * Two runs of the same milestone. One got `kind: 'placeholder'` - an enum
 * violation, so zod rejected, the loop moved on, the fallback fired, and a real
 * plan came back. The next got a schema-clean `"Sample Task"` that only the
 * planner's own guards could see was worthless; the loop returned it as a
 * success, the fallback was never consulted, and the milestone was closed as
 * unplannable. The stronger model was reachable only by failing badly enough at
 * JSON.
 *
 * These drive the real loop, because the bug was in the loop and a mock of it
 * would have gone on agreeing with itself.
 */
describe('a proposal that satisfies the schema and nothing else', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const answer = (tasks: unknown) =>
    ({ stdout: JSON.stringify({ tasks }), stderr: '', exitCode: 0 }) as any;
  const PLACEHOLDER = [{ title: 'Sample Task' }];
  const REAL = [{ title: 'Move health checks out of app/core' }];

  it('falls back to the next model instead of returning it', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(answer(PLACEHOLDER))
      .mockResolvedValueOnce(answer(PLACEHOLDER))
      .mockResolvedValue(answer(REAL));

    const brain = new AgyBrain({ model: 'm1', fallbackModel: 'm2', maxRepairs: 1 });
    const got = await brain.ask('plan this', TASKS, 'decompose', (d) =>
      d.tasks.some((t) => t.title === 'Sample Task') ? 'placeholder task' : null,
    );

    // The whole point: the answer came from the model the old loop never reached.
    expect(got.tasks[0]?.title).toBe('Move health checks out of app/core');
    expect(execa).toHaveBeenCalledTimes(3); // m1 x2 exhausted, then m2
  });

  it('carries the objection into the repair prompt, not a schema complaint', async () => {
    vi.mocked(execa).mockResolvedValueOnce(answer(PLACEHOLDER)).mockResolvedValue(answer(REAL));

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 1 });
    await brain.ask('plan this', TASKS, 'decompose', (d) =>
      d.tasks.some((t) => t.title === 'Sample Task') ? 'every task is a placeholder' : null,
    );

    // A repair attempt told only "invalid JSON" cannot fix a well-formed answer.
    const repair = vi.mocked(execa).mock.calls[1]?.join(' ') ?? '';
    expect(repair).toContain('every task is a placeholder');
  });

  it('still returns the first answer the caller accepts, without spending a fallback', async () => {
    vi.mocked(execa).mockResolvedValue(answer(REAL));

    const brain = new AgyBrain({ model: 'm1', fallbackModel: 'm2', maxRepairs: 1 });
    const got = await brain.ask('plan this', TASKS, 'decompose', () => null);

    expect(got.tasks[0]?.title).toBe('Move health checks out of app/core');
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('reports the objection as the reason when no model produces a usable answer', async () => {
    vi.mocked(execa).mockResolvedValue(answer(PLACEHOLDER));

    const brain = new AgyBrain({ model: 'm1', fallbackModel: 'm2', maxRepairs: 0 });
    const failure = await brain
      .ask('plan this', TASKS, 'decompose', () => 'every task is a placeholder')
      .catch((e: Error) => e);

    // "returned nothing" would send the investigation at a hang. It answered
    // every time; the answers were worthless.
    expect((failure as Error).message).toContain('every task is a placeholder');
  });
});


/**
 * The 2026-08-18 first-attempt failure.
 *
 * The decompose prompt reached 32804 characters against a 32767 Windows
 * command-line cap, so CreateProcess failed before agy ran: no exit code, both
 * streams empty, back in about 2ms. The loop read that as "the model returned
 * nothing" and charged it one of three attempts - on the first attempt of every
 * model, because every repair prompt after it is short enough to fit.
 */
/**
 * On 2026-08-18 the planner trimmed the decompose prompt to fit
 * `maxPromptChars`, and the spawn still failed with ENAMETOOLONG. Both the
 * budget and the guard measured an argument as `length + 3`, so they agreed
 * with each other and were both wrong: Windows wraps each argument in quotes
 * and turns every " inside it into two characters. The decompose template
 * carries 70 quotes before any ledger content is filled in.
 */
describe('what an argument costs on a Windows command line', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const brain = () => new AgyBrain({ model: 'm1', maxRepairs: 0 });

  it('counts a quote as the two characters it becomes', () => {
    // a"b -> "a\"b": two surrounding quotes, and the inner one doubled.
    expect(brain().promptCost('a"b')).toBe(6);
  });

  it('is more than the length whenever there is a quote at all', () => {
    const json = JSON.stringify({ tasks: [{ title: 'x' }] });
    expect(brain().promptCost(json)).toBeGreaterThan(json.length);
  });

  it('doubles a backslash run before a quote, as CreateProcess does', () => {
    // One backslash then a quote becomes two backslashes then an escaped quote,
    // inside the surrounding pair: 2 + 2 + 2.
    expect(brain().promptCost('\\"')).toBe(6);
  });

  it('doubles a trailing backslash run, which meets the closing quote', () => {
    expect(brain().promptCost('a\\')).toBe(2 + 1 + 2);
  });

  it('charges nothing extra for text with neither quotes nor backslashes', () => {
    expect(brain().promptCost('plain text')).toBe('plain text'.length + 2);
  });

  /*
   * The production failure exactly: a prompt whose raw length is inside the
   * limit but whose escaped form is not. Measured as `length + 3` this spawns
   * and fails silently; measured properly it is refused with a reason.
   */
  it('refuses a prompt that fits by length but not once escaped', async () => {
    const quotes = '"'.repeat(20_000);
    expect(quotes.length).toBeLessThan(32_767);

    await expect(brain().ask(quotes, TASKS, 'decompose')).rejects.toThrow(/PROMPT_TOO_LONG/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('leaves the budget short enough that a prompt filling it can be spawned', () => {
    const b = brain();
    // Fill the budget with the worst case the cost model knows about; the
    // command line it produces must still be inside the limit.
    const worst = '"'.repeat(Math.floor((b.maxPromptChars ?? 0) / 2) - 2);
    expect(b.promptCost(worst)).toBeLessThanOrEqual(b.maxPromptChars ?? 0);
  });
});

describe('a prompt too long to spawn', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is refused before a process is started, so it costs no quota', async () => {
    const brain = new AgyBrain({ model: 'm1', maxRepairs: 2 });
    const huge = 'x'.repeat(40_000);

    await expect(brain.ask(huge, TASKS, 'decompose')).rejects.toThrow(/PROMPT_TOO_LONG/);
    // The whole point: not one provider request was spent finding this out.
    expect(execa).not.toHaveBeenCalled();
  });

  it('says how far over it is, rather than that the model said nothing', async () => {
    const brain = new AgyBrain({ model: 'm1', maxRepairs: 0 });
    const failure = await brain.ask('x'.repeat(40_000), TASKS, 'decompose').catch((e: Error) => e);

    expect((failure as Error).message).toMatch(/over the 32767-char Windows limit/);
    expect((failure as Error).message).toMatch(/prompt alone is 40000/);
  });

  it('leaves a prompt that fits alone', async () => {
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify({ tasks: [{ title: 'a real task' }] }),
      stderr: '',
      exitCode: 0,
    } as any);

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 0 });
    const got = await brain.ask('x'.repeat(30_000), TASKS, 'decompose');

    expect(got.tasks[0]?.title).toBe('a real task');
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('budgets for its own arguments, not just for the cap', () => {
    const brain = new AgyBrain({ model: 'gemini-3.1-pro-high', fallbackModel: 'gemini-3.6-flash-high' });

    expect(brain.maxPromptChars).toBeLessThan(32767);
    // Room for the binary path, --print-timeout, and the widest model name -
    // measured against the widest so the budget does not move on fallback.
    expect(brain.maxPromptChars).toBeGreaterThan(32767 - 1000);
  });

  it('counts its own arguments toward the limit, not just the prompt', async () => {
    /*
     * The real overflow was 37 characters. A guard that weighs only the prompt
     * passes a command line that CreateProcess still refuses, and the failure
     * looks identical to the one this guard exists to prevent.
     */
    const brain = new AgyBrain({ model: 'gemini-3.1-pro-high', maxRepairs: 0 });
    const prompt = 'x'.repeat(32_760);

    expect(prompt.length).toBeLessThan(32767); // fits the cap on its own
    expect(prompt.length).toBeGreaterThan(brain.maxPromptChars); // not once argv is on the line

    await expect(brain.ask(prompt, TASKS, 'decompose')).rejects.toThrow(/PROMPT_TOO_LONG/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('budgets for the widest model it may fall back to', () => {
    // The budget is spent building the prompt, before anyone knows which model
    // will answer. Sizing it to the first model overflows on the fallback.
    const alone = new AgyBrain({ model: 'm1' });
    const withLongFallback = new AgyBrain({ model: 'm1', fallbackModel: 'gemini-3.6-flash-high' });

    expect(withLongFallback.maxPromptChars).toBeLessThan(alone.maxPromptChars);
  });

  it('names a spawn failure instead of reporting exit undefined', async () => {
    /*
     * What the driver actually saw: no exit code and nothing on either stream,
     * because the process never started. `exit undefined` was the entire
     * diagnosis and it reads as a hang or a flaky provider.
     */
    vi.mocked(execa).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: undefined,
      shortMessage: 'Command failed with ENAMETOOLONG: agy.exe -p ...',
    } as any);

    const brain = new AgyBrain({ model: 'm1', maxRepairs: 0 });
    const failure = await brain.ask('plan this', TASKS, 'decompose').catch((e: Error) => e);

    expect((failure as Error).message).toMatch(/ENAMETOOLONG/);
    expect((failure as Error).message).not.toMatch(/exit undefined/);
  });
});
