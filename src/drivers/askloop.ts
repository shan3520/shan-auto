import type { ZodTypeAny, output } from 'zod';
import { archive, archiveSafe, log } from '../logger.js';
import { extractJson, truncate } from '../util.js';
import { fill, prompt as loadPrompt } from '../config.js';

/** Thrown by a driver when retrying the same model is pointless. */
export class FatalBrainError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'FatalBrainError';
  }
}

export type RawCall = (text: string, model: string) => Promise<string>;

/**
 * Shared validate-and-repair loop for every brain driver.
 *
 * Model output is untrusted input: it is archived, parsed, schema-checked,
 * offered to the caller's `accept` gate, and on failure sent back with the
 * specific reason. Fatal problems (quota, auth, a denied tool call) skip
 * straight to the next model instead of burning attempts on a condition the
 * next attempt reproduces exactly.
 *
 * A schema reject and an `accept` reject are deliberately the same event here.
 * They were not, and the asymmetry decided which model got consulted: on
 * 2026-08-18 the decomposer returned `kind: 'placeholder'` (an enum violation,
 * so zod rejected, the loop continued, the fallback fired, and a real plan came
 * back) and on the next run returned a schema-clean `"Sample Task"` that only
 * the planner's own guard could see was worthless — so this returned success,
 * the fallback never ran, and the milestone was closed as unplannable. The
 * better model was reachable only by failing badly enough at JSON.
 */
export async function askWithRepair<S extends ZodTypeAny>(
  call: RawCall,
  models: string[],
  text: string,
  schema: S,
  label: string,
  maxRepairs: number,
  accept?: (data: output<S>) => string | null,
  /**
   * Called with the model that produced the accepted answer, and whether it was
   * a fallback rather than the configured first choice.
   *
   * A fallback is a decision about WHO did the judging, and until 2026-08-21 it
   * was recorded only as a WARN in the middle of a run's other warnings, while
   * the line the operator actually reads — "reviewed by agy: ship" — named the
   * driver and not the model. On zero13 a SHIP that authorised a commit and a
   * push came back in 24 seconds and 297 characters from the understudy, after
   * the configured senior burned 70 seconds and failed OAuth. Nothing that
   * survives the run said so next to the verdict.
   */
  onAnswered?: (model: string, fallback: boolean) => void,
): Promise<output<S>> {
  let lastRaw = '';
  let lastErr = 'unknown';
  /*
   * Kept so the final throw can name WHY, not just what.
   *
   * A run of auto-denied tool calls on 2026-08-08 surfaced as
   * `Brain failed ... Last error: agy returned nothing` — which reads as a hang
   * or a flaky provider, and sent the investigation at the timeout instead of at
   * the missing permission. The kind is the whole diagnosis, so it goes in the
   * message a caller actually sees.
   */
  let lastFatal: FatalBrainError | undefined;

  for (const [rank, model] of models.entries()) {
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const body =
        attempt === 0
          ? text
          : fill(loadPrompt('repair'), { ERROR: lastErr, PREVIOUS: truncate(lastRaw, 2000) });
      try {
        /*
         * O28. Everything in this system records what came BACK — artifacts,
         * journal, runs/*.jsonl, the ledger — and nothing recorded what was
         * ASKED. Confirming the AO fix had reached a live agent could not be
         * done from run 25's own records: it took a script that reopened the
         * database, re-resolved the idea and rebuilt the prompt by hand, which
         * proves the builder is deterministic and not that the agent saw it.
         * Close enough that day. Not close enough the day a prompt is wrong.
         *
         * Written BEFORE the call, so a prompt that produces a hang or a crash
         * is still on disk afterwards — which is exactly the case worth having
         * it for. This is the one place every brain call passes through, so it
         * covers decompose, brief, qa, accept, shape, narrate and ask at once.
         *
         * Retention was the stated reason this stayed open, and it was already
         * answered: these land in data/artifacts/, which `prune` sweeps on
         * `retention.artifact_days` alongside the responses they belong to.
         */
        const stem = `${label}-${model.replace(/\W/g, '_')}-a${attempt}`;
        archiveSafe(`${stem}-prompt`, body);
        lastRaw = await call(body, model);
        archive(stem, lastRaw);

        const parsed = schema.safeParse(extractJson(lastRaw));
        if (parsed.success) {
          const objection = accept?.(parsed.data) ?? null;
          if (!objection) {
            // Reported on the way out, so it describes the model that actually
            // produced the answer rather than the last one tried.
            onAnswered?.(model, rank > 0);
            return parsed.data;
          }
          // Same bookkeeping as a schema reject, so the repair prompt carries
          // the real objection and the model loop keeps its budget.
          lastErr = objection;
          lastFatal = undefined;
          log.warn(`brain[${label}] rejected on the merits (attempt ${attempt + 1}): ${truncate(objection, 300)}`);
          continue;
        }

        lastErr = parsed.error.issues
          .slice(0, 8)
          .map((i: { path: (string | number)[]; message: string }) =>
            `${i.path.join('.') || '(root)'}: ${i.message}`,
          )
          .join('; ');
        lastFatal = undefined;
        log.warn(`brain[${label}] schema reject (attempt ${attempt + 1}): ${lastErr}`);
      } catch (e) {
        lastErr = (e as Error).message;
        // Always reassigned, so a later ordinary failure cannot inherit an
        // earlier model's kind and label itself QUOTA or TOOL_DENIED.
        lastFatal = e instanceof FatalBrainError ? e : undefined;
        log.warn(`brain[${label}] call failed (attempt ${attempt + 1}): ${lastErr}`);
        if (e instanceof FatalBrainError) {
          log.warn(
            `brain[${label}] ${e.kind} on ${model || 'default'} — skipping ` +
              `${maxRepairs - attempt} remaining attempt(s) on this model`,
          );
          break;
        }
      }
    }
    if (models.length > 1) log.warn(`brain[${label}] falling back off ${model}`);
  }
  throw new Error(
    `Brain failed for "${label}" after all retries. ` +
      (lastFatal ? `Last error (${lastFatal.kind}): ` : 'Last error: ') +
      lastErr,
  );
}
