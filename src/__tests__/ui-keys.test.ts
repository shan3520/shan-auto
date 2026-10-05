import { describe, it, expect } from 'vitest';
import { nextKey } from '../tui/ui.js';

/**
 * Reading keys out of a chunk that may hold more than one.
 *
 * The reader used to `switch` on the whole chunk, so anything carrying two
 * keypresses matched no case and both were dropped, with the screen redrawn
 * unchanged. Measured 2026-08-15: "\x1B[B\r" moved no cursor and chose nothing,
 * three Downs together moved nothing, and a 40-minute unattended run sat on the
 * main menu waiting for a key that had already been pressed.
 *
 * stdin coalesces whenever input outpaces the reader — a held arrow key, two
 * quick presses, a paste, a connection catching up. So the operator's own
 * keyboard produces these chunks; this is not a test-harness shape.
 */

const ESC = '\x1B';
/** Drain a chunk the way the menu loop does, one key at a time. */
const drain = (s: string) => {
  const out = [];
  let rest = s;
  for (let i = 0; rest && i < 20; i++) {
    const r = nextKey(rest);
    out.push(r.key);
    rest = r.rest;
  }
  return out;
};

describe('nextKey', () => {
  it('reads a single key and leaves nothing behind', () => {
    expect(nextKey(`${ESC}[B`)).toEqual({ key: 'down', rest: '' });
    expect(nextKey('\r')).toEqual({ key: 'enter', rest: '' });
  });

  it('reads the first key of a chunk and keeps the rest', () => {
    // The exact chunk that stalled run 5.
    expect(nextKey(`${ESC}[B\r`)).toEqual({ key: 'down', rest: '\r' });
  });

  it('drains a held arrow key instead of discarding it', () => {
    expect(drain(`${ESC}[B${ESC}[B${ESC}[B`)).toEqual(['down', 'down', 'down']);
  });

  it('drains a move and a choice in one chunk', () => {
    expect(drain(`${ESC}[B\r`)).toEqual(['down', 'enter']);
  });

  it('still returns Escape for a bare ESC', () => {
    /*
     * Escape means "back" on every screen. Grouping it with the unnamed
     * sequences reads it as a key with no meaning, and the operator is left on
     * a screen they cannot leave except by quitting.
     */
    expect(nextKey(ESC)).toEqual({ key: 'escape', rest: '' });
    expect(drain(`${ESC}${ESC}`)).toEqual(['escape', 'escape']);
  });

  it('consumes a whole unnamed sequence rather than typing it into a field', () => {
    // F5 as "[15~" inside a description goes on to the planner as the brief.
    expect(nextKey(`${ESC}[15~`)).toEqual({ key: 'unknown', rest: '' });
    expect(drain(`${ESC}[15~\r`)).toEqual(['unknown', 'enter']);
  });

  it('keeps naming the keys that used to be typed as text', () => {
    expect(nextKey(`${ESC}[1~`).key).toBe('home');
    expect(nextKey(`${ESC}OF`).key).toBe('end');
    expect(nextKey(`${ESC}[6~`).key).toBe('pagedown');
    expect(nextKey(`${ESC}[3~`).key).toBe('delete');
  });

  it('splits typed text one character at a time', () => {
    // Typing faster than the app reads used to arrive as {char:'abc'}, which
    // matches no single-key check anywhere.
    expect(drain('abc')).toEqual([{ char: 'a' }, { char: 'b' }, { char: 'c' }]);
  });

  it('does not lose a keystroke that follows fast typing', () => {
    expect(drain('hi\r')).toEqual([{ char: 'h' }, { char: 'i' }, 'enter']);
  });
});
