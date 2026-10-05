import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

/*
 * O28 — nothing kept what an agent was asked, 2026-08-31.
 *
 * Artifacts hold the senior's JSON and the junior's full output stream, per
 * task, per attempt. `reports/`, `journal/`, `runs/*.jsonl` and the ledger all
 * record what came BACK. Neither prompt was written down anywhere.
 *
 * So confirming the AO fix had actually reached a live agent could not be done
 * from run 25's own records. It took a script that reopened the run's database,
 * pulled the task row, re-resolved the idea and rebuilt the prompt by hand —
 * which proves the builder is deterministic, not that the agent saw it. Close
 * enough that day. Not close enough the day a prompt is wrong.
 *
 * This is the same shape as every finding that took three runs to see: O23, AF
 * and AO were all meaning lost between a document and its reader, and in each
 * case the evidence was reconstructed afterwards rather than read.
 */

const archived: { step: string; content: string }[] = [];

vi.mock('../../logger.js', () => ({
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  archive: (step: string, content: string) => {
    archived.push({ step, content });
    return `/artifacts/${step}.md`;
  },
  archiveSafe: (step: string, content: string) => {
    archived.push({ step, content });
    return `/artifacts/${step}.md`;
  },
}));

vi.mock('../../config.js', () => ({
  prompt: () => 'REPAIR: {{ERROR}} / {{PREVIOUS}}',
  fill: (t: string) => t,
}));

const { askWithRepair } = await import('../askloop.js');

const Schema = z.object({ ok: z.boolean() });

/** Only the prompt archives, in the order they were written. */
const prompts = () => archived.filter((a) => a.step.endsWith('-prompt'));

beforeEach(() => {
  archived.length = 0;
});

describe('what a brain call leaves behind', () => {
  it('writes down the prompt, not only the answer', async () => {
    await askWithRepair(
      async () => '```json\n{"ok":true}\n```',
      ['modelA'],
      'WHAT THEY ASKED FOR: rank by retrieval count',
      Schema,
      'accept',
      1,
    );

    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.content).toContain('rank by retrieval count');
    // And the answer is still archived, which is what already worked.
    expect(archived.some((a) => !a.step.endsWith('-prompt'))).toBe(true);
  });

  it('names the label and the model, so a prompt can be matched to its answer', async () => {
    await askWithRepair(
      async () => '```json\n{"ok":true}\n```',
      ['google/gemini-x'],
      'anything',
      Schema,
      'accept',
      1,
    );

    const p = prompts()[0]!;
    expect(p.step).toContain('accept');
    expect(p.step).toContain('gemini');
  });

  it('keeps the prompt even when the call throws', async () => {
    /*
     * Written BEFORE the call, which is the case worth having it for: a prompt
     * that produces a hang, a crash or a refusal is exactly the one somebody
     * will want to read, and it is the one an after-the-fact write would lose.
     */
    await expect(
      askWithRepair(
        async () => {
          throw new Error('provider exploded');
        },
        ['modelA'],
        'the prompt that broke it',
        Schema,
        'brief',
        0,
      ),
    ).rejects.toThrow();

    expect(prompts()[0]?.content).toContain('the prompt that broke it');
  });

  it('keeps each repair attempt separately, since the prompt changes', async () => {
    // A repair sends a DIFFERENT prompt — the objection and the previous answer
    // — and the whole point is being able to read the one that was sent.
    let n = 0;
    await askWithRepair(
      async () => {
        n++;
        return n === 1 ? 'not json at all' : '```json\n{"ok":true}\n```';
      },
      ['modelA'],
      'first ask',
      Schema,
      'decompose',
      2,
    );

    expect(prompts().length).toBeGreaterThan(1);
    expect(prompts()[0]!.content).toContain('first ask');
    expect(prompts()[1]!.content).toContain('REPAIR');
  });
});
