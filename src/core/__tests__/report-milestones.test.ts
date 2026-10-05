import { describe, it, expect } from 'vitest';
import { milestonesSection } from '../reporter.js';
import {
  ALREADY_BUILT_STATUS,
  MILESTONE_AUTO_REPLANS,
  type StuckMilestone,
} from '../../ledger.js';

/*
 * O29 — the report could not tell "nothing to do" from "cannot go on".
 *
 * Every figure in the daily report is task-level: committed, failed, dropped,
 * backlog, runway. A run whose every milestone is blocked prints
 *
 *     1 committed · backlog ready 0 · runway ~0 day(s)
 *
 * which is character for character what a run with nothing left to do prints.
 * Run 25 printed exactly that over three stalled milestones and nobody could
 * have known from the document. `sa status` has said the difference since the
 * milestone stall was fixed; this report is what gets read when nobody is
 * watching, which is the case the whole system exists for.
 *
 * The test that matters is the last one: the two days must not read the same.
 */

const ms = (over: Partial<StuckMilestone> = {}): StuckMilestone =>
  ({
    id: 'M1',
    title: 'Rank the attention list',
    repo: 'example-api',
    last_error: 'it did not ship: gate rejected: DEAD_EXPORT',
    status: 'blocked',
    replans: 0,
    ...over,
  }) as StuckMilestone;

const text = (rows: StuckMilestone[]) => milestonesSection(rows).join('\n');

describe('what the report says about where the work stands', () => {
  it('says nothing is stuck on a day nothing is', () => {
    expect(text([ms({ status: 'done', last_error: null })])).toContain('Nothing is stuck');
  });

  it('counts the finished work rather than listing it', () => {
    // A finished milestone asks nothing of the reader. It is a number, not a list.
    const out = text([ms({ status: 'done' }), ms({ id: 'M2', status: 'done' })]);
    expect(out).toContain('**Finished:** 2');
  });

  it('says plainly that the next run handles a milestone with retries left', () => {
    const out = text([ms({ status: 'blocked', replans: 0 })]);
    expect(out).toContain('the next run will plan them again by itself');
    expect(out).toContain('Nothing to do');
    // Not bolded as a problem, because it is not one.
    expect(out).not.toContain('nothing will pick them up');
  });

  it('says plainly when nothing is going to try again', () => {
    const out = text([ms({ status: 'blocked', replans: MILESTONE_AUTO_REPLANS })]);
    expect(out).toContain('nothing will pick');
    expect(out).toContain('Every automatic re-plan is used up');
  });

  it('leads with the worse news when both kinds are present', () => {
    /*
     * A day with one stranded milestone and nine recoverable ones is a day that
     * needs the operator. Opening with "nothing to do" because most of it is
     * fine would bury the one line that matters.
     */
    const out = text([
      ms({ id: 'M1', replans: MILESTONE_AUTO_REPLANS }),
      ms({ id: 'M2', replans: 0 }),
      ms({ id: 'M3', replans: 0 }),
    ]);
    const stranded = out.indexOf('nothing will pick');
    const fine = out.indexOf('The other 2 stopped too');
    expect(stranded).toBeGreaterThan(-1);
    expect(stranded).toBeLessThan(fine);
  });

  it('gives the reason, not the id', () => {
    // The id exists for a command the operator should not have to run. The
    // reason is what tells them whether to care.
    const out = text([ms({ id: 'Mkpr4xc81so', replans: MILESTONE_AUTO_REPLANS })]);
    expect(out).toContain('DEAD_EXPORT');
    expect(out).toContain('Rank the attention list');
    expect(out).not.toContain('Mkpr4xc81so');
  });

  it('names work the brain reported as already built', () => {
    // Neither stuck nor finished, and the one bucket only a person can settle.
    const out = text([
      // The real status string, from the ledger's own constant.
      ms({ status: ALREADY_BUILT_STATUS, last_error: 'the brain found no work left: it is all there' }),
    ]);
    expect(out).toContain('already built');
    expect(out).toContain('it is all there');
  });

  it('does not print ten screens of milestones', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      ms({ id: `M${i}`, title: `job ${i}`, replans: MILESTONE_AUTO_REPLANS }),
    );
    const out = text(many);
    expect(out).toContain('job 0');
    expect(out).not.toContain('job 20');
    expect(out).toContain('(15 more)');
  });

  /*
   * The finding itself. Everything above is detail; this is O29.
   */
  it('reads differently on a stalled day than on a quiet one', () => {
    const quiet = text([ms({ status: 'done', last_error: null })]);
    const stalled = text([ms({ status: 'blocked', replans: MILESTONE_AUTO_REPLANS })]);

    expect(quiet).not.toBe(stalled);
    expect(quiet).toContain('Nothing is stuck');
    expect(stalled).not.toContain('Nothing is stuck');
  });
});
