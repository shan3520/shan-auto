import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repo, TaskRow } from '../../schemas.js';
import type { BrainDriver } from '../../drivers/contracts.js';

/*
 * O25 — a milestone can close over the bug it was opened for, 2026-08-31.
 *
 * Run 22 finished 3 committed / 0 failed and reported the operator's idea done.
 * One of the three commits was a single test file: the task was aimed at a
 * function that already did what the plan wanted, so the junior proved it and
 * committed. True, committed, and beside the point. The milestone closed, the
 * backlog emptied, and the part of the complaint that was still live went
 * unmentioned.
 *
 * The operator was told the work was finished by three separate channels —
 * closed milestone, empty backlog, green run — and the only thing that
 * disagreed was the code. Nothing re-read the original request against what
 * shipped. This is that read.
 */

const store = {
  idea: null as { title: string; body: string } | null,
  milestone: null as { id: string; title: string; detail: string | null } | null,
  shipped: [] as TaskRow[],
  claims: {} as Record<string, { paths: string[]; symbols: string[] }>,
};

vi.mock('../../ledger.js', () => ({
  ideaForMilestone: () => store.idea,
  getMilestone: () => store.milestone,
  committedForMilestone: () => store.shipped,
  getClaim: (id: string) => store.claims[id] ?? null,
}));

const { checkAcceptance, shippedSummary, shortfallReason } = await import('../accept.js');

/** A brain that answers with whatever the test set, and records the prompt. */
const brainSaying = (answer: unknown, seen: { prompt?: string } = {}): BrainDriver =>
  ({
    id: 'stub',
    init: async () => undefined,
    dispose: async () => undefined,
    ask: async (prompt: string, _schema: unknown, _label: string, accept?: (d: unknown) => string | null) => {
      seen.prompt = prompt;
      const objection = accept?.(answer);
      if (objection) throw new Error(objection);
      return answer;
    },
  }) as unknown as BrainDriver;

const task = (title: string, id = 'T1'): TaskRow => ({ id, title }) as TaskRow;

/*
 * Points at a directory with nothing in it, so `hintedBodies` returns the
 * "does not exist yet" lines rather than reading this repository. What the
 * checker does with real file contents is brief-bodies.test.ts's subject; what
 * it does with a verdict is this file's.
 */
const repoAt = (): Repo => ({ id: 'scratch', path: join(tmpdir(), 'sa-accept-none') } as Repo);

beforeEach(() => {
  store.idea = { title: 'Fix retrieval', body: 'Documents with few retrievals must not be ranked top.' };
  store.milestone = { id: 'M1', title: 'Rank the attention list', detail: 'ranking work' };
  store.shipped = [task('Add a test proving combine_scores is correct')];
  store.claims = {};
});

describe('checking that what shipped is what was asked for', () => {
  it('accepts work the checker says answers the request', async () => {
    const out = await checkAcceptance(brainSaying({ satisfied: true, missing: [] }), 'M1', repoAt);
    expect(out.satisfied).toBe(true);
    expect(out.asked).toBe(true);
  });

  it('reports the shortfall the checker names', async () => {
    const out = await checkAcceptance(
      brainSaying({
        satisfied: false,
        missing: ['nothing enforces a minimum retrieval count before ranking'],
      }),
      'M1',
      repoAt,
    );
    expect(out.satisfied).toBe(false);
    expect(out.missing[0]).toContain('minimum retrieval count');
  });

  it('shows the checker the REQUEST, not just the plan', async () => {
    /*
     * The whole point. Judging against the plan cannot catch a plan that was a
     * wrong guess, and a wrong guess is the failure this exists for.
     */
    const seen: { prompt?: string } = {};
    await checkAcceptance(brainSaying({ satisfied: true, missing: [] }, seen), 'M1', repoAt);
    expect(seen.prompt).toContain('Documents with few retrievals must not be ranked top');
    expect(seen.prompt).toContain('Rank the attention list');
  });

  it('shows it what shipped, by title and file', async () => {
    const seen: { prompt?: string } = {};
    store.claims = { T1: { paths: ['app/services/document_stats.py'], symbols: [] } };
    await checkAcceptance(brainSaying({ satisfied: true, missing: [] }, seen), 'M1', repoAt);
    expect(seen.prompt).toContain('Add a test proving combine_scores is correct');
    expect(seen.prompt).toContain('app/services/document_stats.py');
  });

  /*
   * The correction, and the reason it is here.
   *
   * On this check's first live run it reopened two milestones for an expense
   * report that "does not show each category with its total and its percentage"
   * and had "no warning line when a category exceeds half the month's
   * spending". Both were in cli.py and both printed when the command was run by
   * hand. The checker called them missing because the task title that shipped
   * them read "Implement CLI report command for monthly spending".
   *
   * It was shown names and asked what the things behind them do — O23, inside
   * the fix for O25, on the day O23 was fixed.
   */
  it('shows the checker the CODE, not only what the tasks were called', async () => {
    const seen: { prompt?: string } = {};
    store.claims = { T1: { paths: ['src/expense_tracker/cli.py'], symbols: [] } };
    // A real directory with a real file, because the point is the contents.
    const dir = mkdtempSync(join(tmpdir(), 'sa-accept-'));
    mkdirSync(join(dir, 'src/expense_tracker'), { recursive: true });
    writeFileSync(
      join(dir, 'src/expense_tracker/cli.py'),
      ['def report_expenses(month):', '    print(f"{category}: {pct:.1f}%")'].join('\n'),
      'utf8',
    );

    try {
      await checkAcceptance(
        brainSaying({ satisfied: true, missing: [] }, seen),
        'M1',
        () => ({ id: 'scratch', path: dir }) as Repo,
      );
      // The percentage is nowhere in the task title. It is in the file.
      expect(seen.prompt).toContain('report_expenses');
      expect(seen.prompt).toContain('pct:.1f');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts silently when there is no request recorded to judge against', async () => {
    // A milestone from before ideas were kept has nothing for this to read, and
    // that is not a shortfall.
    store.idea = null;
    const out = await checkAcceptance(brainSaying({ satisfied: false, missing: ['x'] }), 'M1', repoAt);
    expect(out.satisfied).toBe(true);
    expect(out.asked).toBe(false);
  });

  it('leaves the work finished when the checker cannot be reached', async () => {
    /*
     * A second opinion on a decision already made correctly by its own lights.
     * A checker that is down must not start failing finished work.
     */
    const broken = {
      id: 'stub',
      ask: async () => {
        throw new Error('provider unreachable');
      },
    } as unknown as BrainDriver;

    const out = await checkAcceptance(broken, 'M1', repoAt);
    expect(out.satisfied).toBe(true);
    expect(out.asked).toBe(false);
  });

  it('refuses a "no" that names nothing, because nobody could act on it', async () => {
    /*
     * Reopening the work and handing the planner an empty list is worse than
     * accepting: it spends the next run re-planning against no information.
     * The objection goes back for repair the same way a schema failure does.
     */
    const seen: { prompt?: string } = {};
    const out = await checkAcceptance(
      brainSaying({ satisfied: false, missing: ['   '] }, seen),
      'M1',
      repoAt,
    );
    // The stub throws the objection, which is caught and treated as unreachable.
    expect(out.satisfied).toBe(true);
    expect(out.asked).toBe(false);
  });
});

describe('what the checker is shown about the shipped work', () => {
  it('says nothing shipped when nothing did', () => {
    expect(shippedSummary([])).toContain('nothing shipped');
  });

  it('names each task and the files it touched', () => {
    store.claims = { T1: { paths: ['cli.py', 'tests/test_cli.py'], symbols: [] } };
    const out = shippedSummary([task('Add the summary command')]);
    expect(out).toContain('Add the summary command');
    expect(out).toContain('cli.py');
  });

  it('copes with a task whose plan recorded no files', () => {
    expect(shippedSummary([task('Something')])).toBe('- Something');
  });
});

describe('what the milestone record says about a shortfall', () => {
  it('leads with the distinction that matters', () => {
    const why = shortfallReason(['there is no command that totals spending by category']);
    expect(why).toContain('the jobs finished but the request did not');
    expect(why).toContain('totals spending by category');
  });

  it('joins several without losing any', () => {
    const why = shortfallReason(['first thing', '  ', 'second thing']);
    expect(why).toContain('first thing');
    expect(why).toContain('second thing');
    // The blank is dropped rather than rendered as an empty clause.
    expect(why).not.toContain('; ;');
  });
});
