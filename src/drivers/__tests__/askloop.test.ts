import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { askWithRepair, FatalBrainError } from '../askloop.js';

vi.mock('../../logger.js', () => ({
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  archive: () => {},
  // O28: the prompt is archived beside the response now, through the
  // never-throwing variant — a failed archive must not cost a brain call.
  archiveSafe: () => undefined,
}));

const S = z.object({ answer: z.number() });

/**
 * Answers `n` for the named models and throws for the rest, so a test can say
 * "the first choice is down" without describing a transport.
 */
const only = (working: Record<string, number>) => async (_text: string, model: string) => {
  const n = working[model];
  if (n === undefined) throw new FatalBrainError('AUTH', `${model} needs a login`);
  return JSON.stringify({ answer: n });
};

/*
 * zero13, 2026-08-20. Mid-run, on the review of attempt 2:
 *
 *   WARN brain[review-T022wvphjqt] AUTH on gemini-3.1-pro-high - skipping 2
 *   WARN brain[review-T022wvphjqt] falling back off gemini-3.1-pro-high
 *   INFO [T022wvphjqt] reviewed by agy: ship
 *
 * The SHIP that authorised a commit and a push came back in 24 seconds and 297
 * characters from the understudy, after the configured senior burned 70 seconds
 * and failed OAuth. The fallback is correct engineering and is why the run
 * finished. The silence is the fault: nothing that survived the run said which
 * model had done the judging.
 */
describe('the loop says which model actually answered', () => {
  it('names the model on the ordinary path, and calls it no fallback', async () => {
    const seen: { model: string; fallback: boolean }[] = [];

    await askWithRepair(only({ senior: 1 }), ['senior', 'understudy'], 'q', S, 'l', 0, undefined,
      (model, fallback) => seen.push({ model, fallback }));

    expect(seen).toEqual([{ model: 'senior', fallback: false }]);
  });

  it('names the understudy, and says it was a fallback', async () => {
    const seen: { model: string; fallback: boolean }[] = [];

    await askWithRepair(only({ understudy: 2 }), ['senior', 'understudy'], 'q', S, 'l', 0, undefined,
      (model, fallback) => seen.push({ model, fallback }));

    expect(seen).toEqual([{ model: 'understudy', fallback: true }]);
  });

  /*
   * The one that decides whether the flag can be trusted. Reporting on entry to
   * each model would mark the senior as having answered a question it never
   * answered, which is worse than saying nothing at all.
   */
  it('says nothing for a model that was tried and could not answer', async () => {
    const seen: string[] = [];

    await askWithRepair(only({ understudy: 2 }), ['senior', 'understudy'], 'q', S, 'l', 0, undefined,
      (model) => seen.push(model));

    expect(seen).toEqual(['understudy']);
  });

  it('says nothing at all when no model could answer', async () => {
    const seen: string[] = [];

    await expect(
      askWithRepair(only({}), ['senior', 'understudy'], 'q', S, 'l', 0, undefined, (m) => seen.push(m)),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  /*
   * A single configured model is the common case and is not a fallback, however
   * many times it had to be repaired to get there.
   */
  it('does not call a lone model a fallback', async () => {
    const seen: { model: string; fallback: boolean }[] = [];

    await askWithRepair(only({ senior: 3 }), ['senior'], 'q', S, 'l', 0, undefined,
      (model, fallback) => seen.push({ model, fallback }));

    expect(seen).toEqual([{ model: 'senior', fallback: false }]);
  });

  it('still answers callers that do not ask who answered', async () => {
    const out = await askWithRepair(only({ senior: 7 }), ['senior'], 'q', S, 'l', 0);
    expect(out.answer).toBe(7);
  });
});
