import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeBrain } from './brain.opencode.js';
import { execa } from 'execa';
import { z } from 'zod';
import { FatalBrainError } from './askloop.js';

vi.mock('execa');

describe('OpenCodeBrain', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('init checks if opencode is runnable', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);
    const brain = new OpenCodeBrain({});
    await brain.init();
    expect(execa).toHaveBeenCalledWith('opencode', ['--version'], { reject: false });
  });

  it('init throws if opencode is missing', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as any);
    const brain = new OpenCodeBrain({});
    await expect(brain.init()).rejects.toThrow('is not runnable');
  });

  it('ask calls opencode and returns parsed json', async () => {
    const ocStreamOutput = `{"type":"text","part":{"text":"{\\"answer\\":42}"}}`;
    vi.mocked(execa).mockResolvedValue({ stdout: ocStreamOutput, exitCode: 0 } as any);

    const brain = new OpenCodeBrain({ model: 'test-model' });
    const schema = z.object({ answer: z.number() });
    
    const result = await brain.ask('What is the answer?', schema, 'test-label');
    
    expect(result).toEqual({ answer: 42 });
    expect(execa).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '-m', 'test-model', 'What is the answer?'],
      expect.objectContaining({ reject: false })
    );
  });

  it('ask retries on bad json and throws after max attempts', async () => {
    const badOutput = `{"type":"text","part":{"text":"not json"}}`;
    vi.mocked(execa).mockResolvedValue({ stdout: badOutput, exitCode: 0 } as any);

    const brain = new OpenCodeBrain({ maxRepairs: 1 });
    const schema = z.object({ answer: z.number() });
    
    await expect(brain.ask('question', schema, 'test-label')).rejects.toThrow(/Brain failed for "test-label"/);
    expect(execa).toHaveBeenCalledTimes(2); // Initial + 1 repair
  });

  /*
   * The caller's semantic gate has to survive the trip through this driver.
   * A mutation dropping `accept` from the askWithRepair call survived the whole
   * suite here while the agy driver caught it, which means the gate could have
   * been disconnected on this driver alone and nothing would have said so.
   */
  it('offers a schema-valid answer to the caller gate before returning it', async () => {
    const answer = (n: number) =>
      ({ stdout: `{"type":"text","part":{"text":"{\\"answer\\":${n}}"}}`, exitCode: 0 }) as any;
    vi.mocked(execa).mockResolvedValueOnce(answer(1)).mockResolvedValue(answer(42));

    const brain = new OpenCodeBrain({ maxRepairs: 1 });
    const schema = z.object({ answer: z.number() });
    const seen: number[] = [];

    const got = await brain.ask('question', schema, 'test-label', (d) => {
      seen.push(d.answer);
      return d.answer === 42 ? null : 'not the answer';
    });

    expect(seen).toEqual([1, 42]);
    expect(got.answer).toBe(42);
  });

  it('throws FatalBrainError on fatal opencode errors', async () => {
    const errorOutput = `{"type":"error","error":{"name":"ContextOverflowError","data":{"message":"request too large"}}}`;
    vi.mocked(execa).mockResolvedValue({ stdout: errorOutput, exitCode: 0 } as any);

    const brain = new OpenCodeBrain({});
    const schema = z.object({ answer: z.number() });
    
    await expect(brain.ask('question', schema, 'test-label')).rejects.toThrow(/CONTEXT_OVERFLOW/);
  });

  it('ask succeeds if transient error is followed by success', async () => {
    const successOutput = `{"type":"text","part":{"text":"{\\"answer\\":42}"}}`;
    
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('transient network issue'))
      .mockResolvedValueOnce({ stdout: successOutput, exitCode: 0 } as any);

    const brain = new OpenCodeBrain({ model: 'test-model' });
    const schema = z.object({ answer: z.number() });
    
    const result = await brain.ask('question', schema, 'test-label');
    
    expect(result).toEqual({ answer: 42 });
    expect(execa).toHaveBeenCalledTimes(2);
  });

  it('ask fails after exhausting transient retries and schema repairs', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('transient network issue'));

    // retryDelayMs: 0 — the real 2s backoff is not worth paying in wall clock,
    // and paying it pushed this test past its timeout and turned the suite red.
    const brain = new OpenCodeBrain({ model: 'test-model', retryDelayMs: 0 });
    const schema = z.object({ answer: z.number() });

    await expect(brain.ask('question', schema, 'test-label')).rejects.toThrow(
      /Brain failed for "test-label"/,
    );
    // 3 schema-repair attempts x 2 transient retries inside each.
    expect(execa).toHaveBeenCalledTimes(6);
  });
});
