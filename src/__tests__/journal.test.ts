import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEntry,
  formatEntry,
  journalDays,
  readDay,
  readRecent,
  readTaskThread,
  journalPath,
} from '../core/journal.js';

const dir = mkdtempSync(join(tmpdir(), 'sa-journal-'));

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AT = new Date(2026, 7, 7, 14, 32); // local, not UTC — see today()

describe('formatEntry', () => {
  it('puts the task, stage and agent on one scannable line', () => {
    const s = formatEntry({
      repo: 'shanauto',
      stage: 'dispatch',
      agent: 'agy',
      taskId: 'T-abc12',
      title: 'add rollup narration',
      detail: 'do the thing',
      at: AT,
    });
    expect(s).toContain('14:32');
    expect(s).toContain('T-abc12');
    expect(s).toContain('dispatch');
    expect(s).toContain('agy');
    expect(s).toContain('add rollup narration');
  });

  it('keeps a long result WHOLE — both ends of it', () => {
    // Entries used to be clipped to 1500 chars, keeping only the tail. The
    // owner asked for the full record, so nothing is dropped on the way in.
    const detail = `OPENING LINE\n${'x'.repeat(40_000)}\nSUMMARY: created rollup.ts`;
    const s = formatEntry({ repo: 'r', stage: 'result', detail, at: AT });
    expect(s).toContain('OPENING LINE');
    expect(s).toContain('SUMMARY: created rollup.ts');
    expect(s).not.toContain('truncated');
    expect(s.length).toBeGreaterThan(40_000);
  });

  it('keeps a long instruction whole too', () => {
    const detail = `INSTRUCTION: do this first\n${'x'.repeat(40_000)}\nAND THIS LAST`;
    const s = formatEntry({ repo: 'r', stage: 'dispatch', detail, at: AT });
    expect(s).toContain('INSTRUCTION: do this first');
    expect(s).toContain('AND THIS LAST');
  });
});

describe('appendEntry', () => {
  it('writes a dated file with a heading, once', () => {
    appendEntry({ repo: 'r', stage: 'note', detail: 'first', at: AT }, dir);
    appendEntry({ repo: 'r', stage: 'note', detail: 'second', at: AT }, dir);
    const body = readDay('2026-08-07', dir);
    expect(body.match(/# Work journal/g)).toHaveLength(1);
    expect(body).toContain('first');
    expect(body).toContain('second');
  });

  it('preserves order — the journal is the sequence, not a set', () => {
    for (const n of ['alpha', 'beta', 'gamma']) {
      appendEntry({ repo: 'r', stage: 'note', detail: n, at: AT }, dir);
    }
    const body = readDay('2026-08-07', dir);
    expect(body.indexOf('alpha')).toBeLessThan(body.indexOf('beta'));
    expect(body.indexOf('beta')).toBeLessThan(body.indexOf('gamma'));
  });

  it('files entries under the LOCAL day', () => {
    // A UTC date here would file a 23:30 local entry under tomorrow. That exact
    // off-by-one once filed a whole report under the wrong day.
    appendEntry({ repo: 'r', stage: 'note', detail: 'late', at: new Date(2026, 7, 7, 23, 30) }, dir);
    expect(journalDays(dir)).toEqual(['2026-08-07']);
  });

  it('never throws when the journal cannot be written', () => {
    // Bookkeeping must not cost a task that would otherwise have committed.
    const file = journalPath('2026-08-07', dir);
    mkdirSync(dir, { recursive: true });
    mkdirSync(file, { recursive: true }); // a directory where the file should be
    expect(() =>
      appendEntry({ repo: 'r', stage: 'note', detail: 'x', at: AT }, dir),
    ).not.toThrow();
  });
});

describe('readRecent', () => {
  const write = (day: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(journalPath(day, dir), body, 'utf8');
  };

  it('returns nothing when there is no journal yet', () => {
    expect(readRecent(3000, join(dir, 'does-not-exist'))).toBe('');
  });

  it('crosses the day boundary, so a 07:00 run is not cold', () => {
    write('2026-08-06', '# day one\nyesterday work');
    write('2026-08-07', '# day two\ntoday work');
    const out = readRecent(3000, dir);
    expect(out).toContain('yesterday work');
    expect(out).toContain('today work');
  });

  it('reads oldest-to-newest so the narrative runs forwards', () => {
    write('2026-08-06', 'yesterday work');
    write('2026-08-07', 'today work');
    const out = readRecent(3000, dir);
    expect(out.indexOf('yesterday work')).toBeLessThan(out.indexOf('today work'));
  });

  it('drops the OLDEST when over budget, keeping what just happened', () => {
    write('2026-08-06', `ancient ${'x'.repeat(3000)}`);
    write('2026-08-07', 'the thing that just happened');
    const out = readRecent(200, dir);
    expect(out).toContain('the thing that just happened');
    expect(out).not.toContain('ancient');
  });

  it('respects the budget — this is prompt real estate', () => {
    write('2026-08-07', 'x'.repeat(50_000));
    expect(readRecent(500, dir).length).toBeLessThanOrEqual(520);
  });

  it('returns nothing for a zero budget rather than everything', () => {
    write('2026-08-07', 'work');
    expect(readRecent(0, dir)).toBe('');
  });

  it('ignores files that are not day journals', () => {
    write('2026-08-07', 'real');
    writeFileSync(join(dir, 'notes.md'), 'not a journal', 'utf8');
    expect(journalDays(dir)).toEqual(['2026-08-07']);
    expect(readRecent(3000, dir)).not.toContain('not a journal');
  });
});

describe('the pointer back to the untrimmed output', () => {
  /**
   * Result entries are clipped from the tail, so anything written above a long
   * output is precisely what gets discarded. The pointer to the full copy is
   * the one line that must survive — it is the only route back to what the
   * agent actually said.
   */
  it('survives the clip on a very long result', () => {
    const detail = `${'x'.repeat(9000)}\n\n— ok in 84s · full output: data/artifacts/r1/1-agent-agy-T1.md`;
    const s = formatEntry({ repo: 'r', stage: 'result', detail, at: AT });
    expect(s).toContain('full output: data/artifacts/r1/1-agent-agy-T1.md');
    expect(s).toContain('ok in 84s');
  });

  it('is still there when the output is short', () => {
    const detail = 'did the thing\n\n— ok in 4s · full output: data/artifacts/x.md';
    expect(formatEntry({ repo: 'r', stage: 'result', detail, at: AT })).toContain('full output');
  });
});

/**
 * The bug this exists for: a retry was being handed the wrong task's history.
 *
 * `readRecent` answers "what has been going on here", and the executor was using
 * it to answer "why was I sent back". Those two coincide only while one task is
 * in flight. With two, the other task's brief and result land between a
 * rejection and its retry, and the shared window opens after the findings.
 */
describe('one task and its own thread', () => {
  const at = (h: number, m: number) => new Date(2026, 7, 7, h, m);
  const put = (
    taskId: string,
    stage: 'dispatch' | 'gate' | 'review' | 'result' | 'note',
    detail: string,
    when: Date,
  ) => appendEntry({ repo: 'example-api', stage, taskId, detail, at: when }, dir);

  it('finds findings the shared window has already scrolled past', () => {
    put('T-mine', 'review', 'REWORK: the status filter is never asserted on', at(9, 0));
    // The other task, doing what other tasks do: a 3k brief and a long result.
    put('T-other', 'dispatch', `briefed by the senior:\n${'b'.repeat(3000)}`, at(9, 10));
    put('T-other', 'result', 'x'.repeat(3000), at(9, 20));
    put('T-other', 'review', 'SHIP: fine', at(9, 30));

    expect(readRecent(3000, dir)).not.toContain('status filter is never asserted');
    expect(readTaskThread('T-mine', 2000, dir)).toContain('status filter is never asserted');
  });

  it('answers with that task and nothing else', () => {
    put('T-mine', 'review', 'REWORK: mine', at(9, 0));
    put('T-other', 'review', 'REWORK: theirs', at(9, 5));

    const out = readTaskThread('T-mine', 2000, dir);
    expect(out).toContain('mine');
    expect(out).not.toContain('theirs');
  });

  /*
   * A task's own dispatch entry IS its brief, and the retry is handed the brief
   * again in full by the prompt. At ~3k it would spend the entire budget saying
   * something already on the page — and push out the findings to do it.
   */
  it('leaves out the brief it is about to be given again anyway', () => {
    put('T-mine', 'dispatch', 'briefed by the senior: build the endpoint', at(9, 0));
    put('T-mine', 'result', 'I built the endpoint', at(9, 1));
    put('T-mine', 'gate', 'GATE_FAIL: two tests red', at(9, 2));

    const out = readTaskThread('T-mine', 2000, dir);
    expect(out).toContain('two tests red');
    expect(out).not.toContain('build the endpoint');
    expect(out).not.toContain('I built the endpoint');
  });


  /*
   * The stage that exists for exactly this reader. A `note` is written when an
   * attempt fails before producing a verdict, and it is the only thing standing
   * between that retry and starting from nothing — see the agent-failure path in
   * executor.ts. Result entries stay out: they run to thousands of characters
   * and are kept from the front, which is the wrong end of an agent transcript.
   */
  it('carries a note left for the next attempt', () => {
    put('T-mine', 'result', 'x'.repeat(3000), at(9, 0));
    put('T-mine', 'note', 'attempt 1 stopped early; its changes were reverted', at(9, 1));

    const out = readTaskThread('T-mine', 2000, dir);
    expect(out).toContain('stopped early');
    expect(out).not.toContain('xxx');
  });

  it('reads oldest first, so the last word is the last thing read', () => {
    put('T-mine', 'gate', 'GATE_FAIL: first go', at(9, 0));
    put('T-mine', 'review', 'REWORK: second go', at(9, 5));

    const out = readTaskThread('T-mine', 2000, dir);
    expect(out.indexOf('first go')).toBeLessThan(out.indexOf('second go'));
  });

  /*
   * Cut from the front, not the back. A budget too small for the whole thread
   * must keep the most recent rejection: that is the one this attempt has to
   * answer, and an older one may already have been fixed.
   */
  it('drops the oldest rejection when it cannot afford both', () => {
    put('T-mine', 'gate', `GATE_FAIL: ancient\n${'a'.repeat(400)}`, at(9, 0));
    put('T-mine', 'review', `REWORK: current\n${'c'.repeat(400)}`, at(9, 5));

    const out = readTaskThread('T-mine', 500, dir);
    expect(out).toContain('current');
    expect(out).not.toContain('ancient');
    expect(out.length).toBeLessThanOrEqual(500);
  });

  it('keeps the head of a single entry too big for the whole budget', () => {
    put('T-mine', 'review', `REWORK: the summary is up here\n${'f'.repeat(5000)}`, at(9, 0));

    const out = readTaskThread('T-mine', 300, dir);
    expect(out).toContain('the summary is up here');
    expect(out.length).toBeLessThanOrEqual(302); // the room, plus the ellipsis
  });

  it('is empty for a task with no history, rather than borrowing another one', () => {
    put('T-other', 'review', 'REWORK: theirs', at(9, 0));
    expect(readTaskThread('T-mine', 2000, dir)).toBe('');
    expect(readTaskThread('', 2000, dir)).toBe('');
  });

  it('does not match a task whose id merely starts the same way', () => {
    put('T-mine2', 'review', 'REWORK: the other one', at(9, 0));
    expect(readTaskThread('T-mine', 2000, dir)).toBe('');
  });
});

/*
 * The journal is two things at once, and it took an intern reading ShanAuto's
 * own filesystem to notice they had different requirements.
 *
 * `executor.ts` appends "· full output: <absolute path>" to every result entry
 * so the operator can open the untrimmed transcript. `readRecent()` then hands
 * that same text to the next agent as context. On 2026-08-21 an intern read the
 * path to its own previous attempt's transcript — inside .zero12/artifacts —
 * out of its prompt and tried to open it. `external_directory: deny` held, so
 * nothing leaked; the cost was the step it spent finding the door locked.
 *
 * The path is an operator's convenience with no value to any model: none of
 * them can open it, and the one that tried was told so.
 */
describe('the operator keeps the pointer, the agent never sees it', () => {
  const AT2 = new Date(2026, 7, 7, 15, 0);
  const withPointer =
    'I built the endpoint\n\n— ok in 84s · full output: D:\\repos\\shanauto\\.zero12\\artifacts\\r1\\1-x.md';

  it('is gone from the context handed to the next agent', () => {
    appendEntry({ repo: 'example-api', stage: 'result', taskId: 'T1', detail: withPointer, at: AT2 }, dir);
    const context = readRecent(3000, dir);
    expect(context).not.toContain('full output');
    expect(context).not.toContain('.zero12');
    // What the entry was actually for survives intact.
    expect(context).toContain('I built the endpoint');
    expect(context).toContain('ok in 84s');
  });

  /*
   * Stripped on the way OUT, never on the way in. The file on disk is the
   * operator's record; rewriting it to protect a model from a path it cannot
   * open would destroy the only route back to the untrimmed output.
   */
  it('is still on disk, where the operator reads it', () => {
    appendEntry({ repo: 'example-api', stage: 'result', taskId: 'T1', detail: withPointer, at: AT2 }, dir);
    expect(readDay('2026-08-07', dir)).toContain('full output');
  });

  it('is gone from a retry thread too, which is the prompt that matters most', () => {
    appendEntry({ repo: 'example-api', stage: 'review', taskId: 'T1', detail: withPointer, at: AT2 }, dir);
    const thread = readTaskThread('T1', 2000, dir);
    expect(thread).not.toContain('full output');
    expect(thread).toContain('I built the endpoint');
  });

  /*
   * The pointer is the tail of its own line and nothing else. A pattern that ate
   * past the newline would take the entries below it with it — silently, and
   * only when a result happened to be followed by something.
   */
  it('takes the pointer and not the entry underneath it', () => {
    appendEntry({ repo: 'r', stage: 'result', taskId: 'T1', detail: withPointer, at: AT2 }, dir);
    appendEntry({ repo: 'r', stage: 'review', taskId: 'T1', detail: 'SHIP: looks right', at: AT2 }, dir);
    expect(readRecent(3000, dir)).toContain('SHIP: looks right');
  });
});
