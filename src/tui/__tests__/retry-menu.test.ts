import { describe, it, expect } from 'vitest';
import { stoppedActions, overviewState } from '../app.js';

/*
 * The retry menu, 2026-08-27.
 *
 * `sa status` has always been able to say that work has stopped, and every way
 * out of it was a terminal command printed at the bottom of the screen:
 * `npm run sa -- retry --failed`. The operator this program is written for does
 * not work in a terminal. On the day this was written there were four stopped
 * jobs in example-ledger and no button anywhere in the TUI that could move them.
 *
 * What is tested here is the mapping from "what is stopped" to "what the button
 * does" — deliberately a pure function, so the label and the command it runs
 * come from the same object and cannot drift apart. Four times in two days a
 * rule in this project was proven correct while nothing proved anyone called
 * it; a menu that builds rows in one list and dispatches from a switch on the
 * index is that same shape.
 */
describe('what the "some work has stopped" screen offers', () => {
  const ms = (id: string, title: string) => ({ id, title });

  it('offers nothing when nothing has stopped', () => {
    // This is what keeps the screen quiet on a good day. A menu that always
    // says "put the stopped jobs back" teaches the reader to ignore it.
    expect(stoppedActions(0, [])).toEqual([]);
  });

  it('offers to requeue the stopped jobs, and says how many', () => {
    const [a] = stoppedActions(4, []);
    expect(a?.label).toBe('Put the stopped jobs back');
    expect(a?.value).toBe('4');
  });

  it('runs the same command the status screen tells the operator to type', () => {
    /*
     * The whole point of the button. If these drift, the screen documents one
     * cure and the button performs another.
     */
    expect(stoppedActions(1, [])[0]?.args).toEqual(['retry', '--failed']);
  });

  it('offers each stopped milestone by name, not by id', () => {
    const out = stoppedActions(0, [ms('M1', 'Rule-based spending categorization')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe('Plan again: Rule-based spending categorization');
    // The id is what the command needs and the operator should never have to
    // read; it belongs in args, not on screen.
    expect(out[0]?.label).not.toContain('M1');
  });

  it('passes that milestone id to retry, so the right one is re-planned', () => {
    const out = stoppedActions(0, [ms('Mkr2vmdglt4', 'Rule-based spending categorization')]);
    expect(out[0]?.args).toEqual(['retry', 'Mkr2vmdglt4']);
  });

  it('keeps every row pointing at its own milestone', () => {
    // One `retry <id>` for the wrong milestone is a wasted planning pass and a
    // screen that still shows the problem afterwards.
    const out = stoppedActions(0, [ms('M1', 'first'), ms('M2', 'second'), ms('M3', 'third')]);
    expect(out.map((a) => a.args)).toEqual([
      ['retry', 'M1'],
      ['retry', 'M2'],
      ['retry', 'M3'],
    ]);
  });

  it('puts the requeue-everything option above the per-milestone ones', () => {
    // It is the one an operator wants most often and the one that needs no
    // choosing between things they cannot tell apart.
    const out = stoppedActions(2, [ms('M1', 'first')]);
    expect(out[0]?.args).toEqual(['retry', '--failed']);
    expect(out[1]?.args).toEqual(['retry', 'M1']);
  });

  it('gives every row something to run and something to explain it', () => {
    for (const a of stoppedActions(3, [ms('M1', 'first'), ms('M2', 'second')])) {
      expect(a.args.length, a.label).toBeGreaterThan(0);
      expect(a.args[0], a.label).toBe('retry');
      expect(a.help, a.label).toBeTruthy();
      expect(a.title, a.label).toBeTruthy();
    }
  });

  it('says what it will do in words a non-technical reader can act on', () => {
    /*
     * No ids, no "milestone", no "requeue". The rule at the top of app.ts:
     * written for someone who does not work in a terminal.
     */
    const out = stoppedActions(1, [ms('M1', 'first')]);
    const prose = out.map((a) => `${a.label} ${a.help}`).join(' ');
    expect(prose).not.toMatch(/milestone|requeue|ledger|CLI|\bid\b/i);
  });
});

/*
 * The front page, 2026-08-27.
 *
 * Driven as an operator would drive it, the first screen read:
 *
 *   ● Running   today 2/30   jobs waiting 0   projects 3
 *   Nothing to build. Choose the first option and tell it what you want.
 *
 * There were four stopped jobs and a stopped milestone. `waiting` counts ready
 * plus pending; stopped work is neither, so it was invisible — and the screen
 * did not merely omit it, it actively sent the reader to "Tell it what to
 * build". A second idea typed into a system that has given up on the first.
 *
 * The retry menu built the same afternoon sits behind "What is it doing?" —
 * a door this screen was telling people not to open.
 *
 * The bug is precedence, not wording, so precedence is what is tested.
 */
describe('what the front page says is going on', () => {
  const state = (over: Partial<Parameters<typeof overviewState>[0]> = {}) =>
    overviewState({
      ready: 0,
      pending: 0,
      stopped: 0,
      ideasWaiting: false,
      running: true,
      ...over,
    });

  it('says work has stopped rather than "nothing to build"', () => {
    // The exact state of the ledger on the day this was found.
    expect(state({ stopped: 5 })).toBe('stopped');
  });

  it('still says "nothing to build" when that is actually true', () => {
    expect(state()).toBe('nothing');
  });

  it('puts stopped work above a waiting idea', () => {
    /*
     * Both are true and only one is a dead end. "Start working now" will plan
     * the idea; nothing a run does will move a job that has no attempts left.
     */
    expect(state({ stopped: 1, ideasWaiting: true })).toBe('stopped');
  });

  it('puts queued work above stopped work, because a run clears the queue', () => {
    // Deliberately the other way round: with jobs ready, the useful next
    // action is to run them. The header still carries the stopped count.
    expect(state({ ready: 3, stopped: 4 })).toBe('ready');
    expect(state({ ready: 3, stopped: 4, running: false })).toBe('ready-paused');
  });

  it('counts a stopped milestone even when no job is stopped', () => {
    // A milestone whose every task was superseded has no failed jobs under it
    // and is still work that will never happen on its own.
    expect(state({ stopped: 1 })).toBe('stopped');
  });

  it('does not call pending-only work ready, as it once did', () => {
    // The second of the two miscounts this screen has already survived:
    // selectBatch cannot pick a pending job, so offering to start one lies.
    expect(state({ pending: 3 })).toBe('all-pending');
  });

  it('keeps the paused distinction, so it never promises a start it cannot make', () => {
    expect(state({ ready: 2, running: false })).toBe('ready-paused');
    expect(state({ ready: 2, running: true })).toBe('ready');
  });

  it('reports the idea when there is one and nothing has stopped', () => {
    expect(state({ ideasWaiting: true })).toBe('idea-waiting');
  });
});
