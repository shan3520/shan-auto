import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { confirm } from '../ui.js';
import { remoteQuestion } from '../app.js';

/*
 * Which answer the operator gets for free, 2026-08-30.
 *
 * `confirm` opens on "No, go back" — the right default for almost everything,
 * and the wrong one for exactly one question. "Also create it on GitHub?" sat
 * on No, so the operator this program is written for pressed Enter and got a
 * project that never leaves this computer. Nothing reports that as a problem:
 * the runs succeed, the commits land locally, and the work is simply invisible
 * on the profile it was for. This is an "Autonomous daily GitHub contribution
 * system"; that default quietly turned it into a local git repository.
 *
 * Tested by actually pressing the key rather than by reading the option back.
 * A test that asserted `start: 1` would pass against a menu that ignored it,
 * which is the same shape of hole as proving a rule nobody calls: what has to
 * be true is that ENTER, pressed once, says yes.
 */
describe('the answer a single Enter gives', () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    // The menu redraws on every key; none of it belongs in the test output.
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s));
      return true;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  /** Answer the open question with one keypress, the way a person would. */
  const press = async (seq: string, answer: Promise<boolean>) => {
    // A tick, so `readKey` has attached its listener before the key arrives.
    await new Promise((r) => setImmediate(r));
    process.stdin.emit('data', Buffer.from(seq));
    return answer;
  };

  it('says no to an ordinary question, which is what protects everything else', async () => {
    expect(await press('\r', confirm('Delete it?'))).toBe(false);
  });

  /*
   * Asked with the REAL question object the new-project screen uses, not with
   * an inline copy of it. An inline copy proves `confirm` works and proves
   * nothing about what the operator is shown — deleting the default from the
   * screen left this whole file green until the question became data.
   */
  it('says yes to the one question whose cautious answer is the broken one', async () => {
    const asked = confirm(remoteQuestion.question, [...remoteQuestion.detail], remoteQuestion.opts);
    expect(await press('\r', asked)).toBe(true);
  });

  it('is the GitHub question that gets that treatment, and not some other', async () => {
    // If this ever names a different screen, the exception has been moved onto
    // a question nobody argued for.
    expect(remoteQuestion.question).toBe('Also create it on GitHub?');
    expect(remoteQuestion.detail.join(' ')).toContain('PRIVATE');
  });

  it('still lets the operator say no to it, by moving off the default', async () => {
    /*
     * The default must be a starting position, not a decision already taken.
     * Someone who does not want a remote has to be able to refuse it.
     */
    const answer = confirm(remoteQuestion.question, [...remoteQuestion.detail], remoteQuestion.opts);
    await new Promise((r) => setImmediate(r));
    process.stdin.emit('data', Buffer.from('\x1b[A')); // up, onto "No, go back"
    await new Promise((r) => setImmediate(r));
    process.stdin.emit('data', Buffer.from('\r'));
    expect(await answer).toBe(false);
  });

  it('leaves Escape meaning no, whatever the default is', async () => {
    // The way out of a screen cannot depend on which option it opened on.
    expect(await press('\x1b', confirm(remoteQuestion.question, [...remoteQuestion.detail], remoteQuestion.opts))).toBe(
      false,
    );
  });

  it('shows the operator which one is selected', async () => {
    // The default is only honest if it is visible. An invisible pre-selection
    // is worse than no default at all: it answers for them without saying so.
    const answer = press('\r', confirm(remoteQuestion.question, [...remoteQuestion.detail], remoteQuestion.opts));
    await answer;
    const screen = out.join('');
    const yes = screen.lastIndexOf('Yes, do it');
    const no = screen.lastIndexOf('No, go back');
    expect(yes).toBeGreaterThan(-1);
    // The selected row carries the pointer; the other does not.
    const POINTER = '❯';
    const line = screen.slice(screen.lastIndexOf('\n', yes) + 1, yes);
    const otherLine = screen.slice(screen.lastIndexOf('\n', no) + 1, no);
    expect(line).toContain(POINTER);
    expect(otherLine).not.toContain(POINTER);
  });
});
