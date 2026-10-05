import { z } from 'zod';
import * as ledger from '../ledger.js';
import type { BrainDriver } from '../drivers/contracts.js';
import { fill, prompt } from '../config.js';
import { buildContext, terms } from './retrieve.js';
import { untrusted } from '../util.js';

/**
 * Answer a question about the project's history.
 *
 * Exactly one provider call, and only when asked. Retrieval before it is
 * entirely deterministic, so the model is given evidence rather than asked to
 * remember — which is what keeps the answer checkable and the cost fixed.
 */

const AnswerSchema = z.object({ answer: z.string() });

export interface AskResult {
  answer: string;
  /** How much was retrieved, so a thin answer can be told from a thin question. */
  candidates: number;
  contextChars: number;
}

export async function askMemory(
  repo: string,
  question: string,
  brain: BrainDriver,
  now = new Date(),
): Promise<AskResult> {
  if (terms(question).length === 0) {
    return {
      answer: 'That question has nothing specific to search for — try naming a file, symbol, decision or date.',
      candidates: 0,
      contextChars: 0,
    };
  }

  /*
   * Two pools, deliberately.
   *
   * Reasoning first and unconditionally: decisions, incidents and parks are rare
   * — a few dozen across three years — and are usually what a question is about.
   * Reading only the "most recent N" rows would let them fall out arbitrarily,
   * because bulk ingestion stamps thousands of rows with nearly the same
   * resolved_at, so which ones survive is an accident of insertion order.
   *
   * Commits then fill the rest. They are the mechanics, they are numerous, and
   * old ones are already represented by rollups.
   */
  const reasoning = ledger.resolutionsByKind(
    repo,
    [
      'decision',
      'incident',
      'manual_park',
      'already_done',
      'gate_rejection',
      'qa_rework',
      'task_failed',
      'task_dropped',
      'milestone_dropped',
    ],
    2000,
  );
  /*
   * Journal days are fetched separately, for both of the reasons above at once.
   *
   * They belong with the reasoning: one row per day of work, holding the whole
   * exchange, and they were reachable only through `recentResolutions` below.
   * At roughly sixty commits ingested per day against one journal day, that
   * 3000-row window fills in under two months, after which the oldest days stop
   * being retrievable — exactly the accident-of-insertion-order loss this pool
   * exists to prevent for decisions.
   *
   * They are not simply added to `reasoning` because a day is tens of KB, not
   * hundreds of bytes, and would crowd a shared limit. 400 days is over a year
   * of daily journals; older periods are already covered by rollups. Measured
   * against 400 whole days of the real 57 KB file, scoring costs ~0.75s — paid
   * once, locally, before a call that takes longer than that anyway.
   */
  const journal = ledger.resolutionsByKind(repo, ['journal'], 400);
  const commits = ledger.recentResolutions(repo, 3000);
  const seen = new Set([...reasoning, ...journal].map((r) => r.id));
  const memories = [...reasoning, ...journal, ...commits.filter((c) => !seen.has(c.id))];
  const rollups = ledger.getRollups(repo, undefined, 500);
  const ctx = buildContext(question, memories, rollups, now);

  if (ctx.candidates === 0) {
    // Saying so beats spending a request to have the model say it.
    return {
      answer: `Nothing recorded about that. ${memories.length} memories are stored for "${repo}", but none mention it.`,
      candidates: 0,
      contextChars: 0,
    };
  }

  const out = await brain.ask(
    // CONTEXT is ledger text (LLM-written resolutions/journal) — DATA for the
    // model to reason over, never instructions (SEC-4).
    fill(prompt('ask'), { QUESTION: question, CONTEXT: untrusted('CONTEXT', ctx.text) }),
    AnswerSchema,
    'ask',
  );

  return { answer: out.answer.trim(), candidates: ctx.candidates, contextChars: ctx.used };
}
