import { z } from 'zod';
import { prompt, fill } from '../config.js';
import { log } from '../logger.js';
import * as ledger from '../ledger.js';
import type { BrainDriver } from '../drivers/contracts.js';
import type { Repo, TaskRow } from '../schemas.js';
import { hintedBodies } from './context.js';

/**
 * Whether the person got what they asked for, as opposed to whether the jobs
 * finished.
 *
 * O25. Completion is measured by tasks committing, and a task that commits
 * something true but beside the point counts exactly like one that fixes the
 * bug. Run 22 finished 3 committed / 0 failed and reported the operator's idea
 * done; one of those commits was a test file proving a function already did
 * what the plan wanted, and the part of the complaint that was still live — a
 * `min_retrievals` floor — went unmentioned. The operator was told the work was
 * finished by three separate channels: closed milestone, empty backlog, green
 * run. The only thing that disagreed was the code.
 *
 * Nothing re-read the original idea against what shipped. This is that read,
 * and it is the last point at which it can happen: after this the milestone is
 * `done`, the backlog is empty, and the request is gone from every screen.
 *
 * Deliberately biased towards accepting. A false shortfall reopens finished
 * work and spends a day re-planning it, and the prompt says so — "if you cannot
 * tell, answer true". The failure this catches is silent and permanent; the
 * failure it can cause is noisy and self-correcting, and `MILESTONE_AUTO_REPLANS`
 * bounds it either way.
 */
const AcceptSchema = z.object({
  satisfied: z.boolean(),
  missing: z.array(z.string()).default([]),
});

export type Acceptance = z.infer<typeof AcceptSchema>;

/** The files this milestone's committed work touched, deduped. */
export function shippedPaths(tasks: TaskRow[]): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    for (const p of ledger.getClaim(t.id)?.paths ?? []) {
      const norm = p.trim().replace(/\\/g, '/');
      if (norm && !out.includes(norm)) out.push(norm);
    }
  }
  return out;
}

/**
 * What the checker is shown of the work that landed.
 *
 * Titles and file names, and then the CODE. That last part is a correction.
 *
 * The first version showed only titles and paths, on the reasoning that the
 * junior's own report is what talked everyone into closing run 22's milestone.
 * That half is right, and the report is still excluded. What was wrong was the
 * replacement.
 *
 * On its first live run, 2026-08-31, this reopened two milestones for an
 * expense report that "does not show each category with its total and its
 * percentage" and had "no warning line when a category exceeds half the
 * month's spending". Both were present in `cli.py`, and both printed correctly
 * when the command was run by hand. The checker called them missing because the
 * task title that shipped them read "Implement CLI report command for monthly
 * spending" and mentioned neither.
 *
 * That is O23 — deciding about code it has never read — committed here, inside
 * the fix for O25, on the day O23 was fixed. A bias towards accepting does not
 * rescue a reader with no evidence, because it does not know it is guessing.
 */
export function shippedSummary(tasks: TaskRow[], bodies = ''): string {
  if (!tasks.length) return '(nothing shipped under it)';
  const titles = tasks
    .map((t) => {
      const paths = ledger.getClaim(t.id)?.paths ?? [];
      return `- ${t.title}${paths.length ? ` — touched ${paths.join(', ')}` : ''}`;
    })
    .join('\n');
  return bodies ? `${titles}\n\nTHE CODE AS IT NOW STANDS:\n${bodies}` : titles;
}

/**
 * Ask whether the shipped work answers the request.
 *
 * Never throws. A brain that cannot answer leaves the milestone `done`, because
 * this is a second opinion on a decision that has already been made correctly by
 * its own lights — a checker that is down must not start failing finished work.
 */
export async function checkAcceptance(
  brain: BrainDriver,
  milestoneId: string,
  /**
   * How to find a repo on disk. Injected rather than imported so this stays
   * testable without a config, and because every caller already holds one.
   */
  repoFor: (id: string) => Repo,
): Promise<Acceptance & { asked: boolean }> {
  const idea = ledger.ideaForMilestone(milestoneId);
  const milestone = ledger.getMilestone(milestoneId);
  const shipped = ledger.committedForMilestone(milestoneId);

  /*
   * No idea text means nothing to judge against. That is not a pass or a fail:
   * a milestone created before ideas were recorded, or one whose idea body is
   * empty, has no request for this to read.
   */
  if (!idea?.body?.trim() || !milestone) return { satisfied: true, missing: [], asked: false };

  try {
    const answer = await brain.ask(
      fill(prompt('accept'), {
        IDEA: `${idea.title}\n\n${idea.body}`.trim(),
        MILESTONE: `${milestone.title}\n${milestone.detail ?? ''}`.trim(),
        SHIPPED: shippedSummary(
          shipped,
          await hintedBodies(repoFor(milestone.repo), shippedPaths(shipped)),
        ),
      }),
      AcceptSchema,
      'accept',
      /*
       * A "no" with nothing named is unusable: it reopens the work and gives
       * the planner nothing to plan. Rejecting on the merits sends it back for
       * repair rather than taking an answer nobody can act on.
       */
      (d) =>
        d.satisfied || d.missing.some((m) => m.trim())
          ? null
          : 'you answered `satisfied: false` and listed nothing missing — say what is absent, or answer true',
    );
    return { ...answer, asked: true };
  } catch (e) {
    log.warn(`acceptance check skipped for ${milestoneId}: ${(e as Error).message}`);
    return { satisfied: true, missing: [], asked: false };
  }
}

/** What the milestone's record says when the request was not answered. */
export function shortfallReason(missing: string[]): string {
  return (
    `the jobs finished but the request did not: ` +
    missing.map((m) => m.trim()).filter(Boolean).join('; ')
  );
}
