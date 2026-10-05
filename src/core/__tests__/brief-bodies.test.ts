import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hintedBodies } from '../context.js';
import type { Repo } from '../../schemas.js';

/*
 * O23 — the brain decided about code it had never read, 2026-08-31.
 *
 * The planner, the brief author and the reviewer got a file tree and the names
 * each file declares. A name proves a thing exists and nothing else.
 *
 * Run 21 is what that cost. A plan instructed a task to remove an iterative
 * fetch from a one-line function that contained no loop; the brief hardened the
 * claim into its objective; and the junior — which cannot decline without
 * losing the attempt — made the sentence true by hanging a value nothing reads.
 * Committed, reviewed "ship".
 *
 * Three prompts forbid the move and prompts were the whole of the guard,
 * because every cheap mechanical detector is a name scan and a name scan passes
 * that exact commit. The real fix was always "let it read the code", recorded
 * as blocked on prompt budget. It is affordable for the files the task actually
 * touches — one to four — as opposed to the repo.
 */

let dir: string;
const repo = () => ({ id: 'r1', path: dir } as Repo);

const file = (rel: string, body: string) => {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-bodies-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what the brief author is shown of the files it is planning against', () => {
  it('gives it the actual code, not the name of it', async () => {
    file('src/stats.py', 'def top_documents(n):\n    return _cache[:n]\n');

    const out = await hintedBodies(repo(), ['src/stats.py']);

    expect(out).toContain('src/stats.py');
    expect(out).toContain('return _cache[:n]');
  });

  it('says a file does not exist yet, rather than leaving a silence', async () => {
    /*
     * The fact a brief author most needs before it writes `action: "modify"`,
     * and an absence reads as "not shown to you" as easily as "not there".
     */
    const out = await hintedBodies(repo(), ['src/new.py']);

    expect(out).toContain('src/new.py');
    expect(out).toContain('does not exist yet');
  });

  it('shows every file the plan named, not just the first', async () => {
    file('a.py', 'def a(): pass');
    file('b.py', 'def b(): pass');

    const out = await hintedBodies(repo(), ['a.py', 'b.py']);

    expect(out).toContain('def a()');
    expect(out).toContain('def b()');
  });

  it('caps each file, so one large one cannot crowd out the rest', async () => {
    file('big.py', `# ${'x'.repeat(20000)}\n`);
    file('small.py', 'def small(): pass');

    const out = await hintedBodies(repo(), ['big.py', 'small.py']);

    expect(out).toContain('CUT OFF HERE');
    // The point of the cap: the second file still gets through.
    expect(out).toContain('def small()');
    expect(out.length).toBeLessThan(20000);
  });

  /*
   * The cap was 2,500 and it produced a false verdict on 2026-08-31: `cli.py`
   * was 7,393 characters, `report_expenses` sat at line 125, and the acceptance
   * check was shown the first third and reported the budget handling absent. It
   * was there, and it worked when the command was run by hand.
   *
   * An ordinary source file has to arrive whole, or the reader is guessing
   * about the part it cannot see without knowing that is what it is doing.
   */
  it('shows an ordinary source file whole', async () => {
    file('cli.py', `# header\n${'def f():\n    pass\n'.repeat(300)}def last_one():\n    pass\n`);

    const out = await hintedBodies(repo(), ['cli.py']);

    expect(out).toContain('last_one');
    expect(out).not.toContain('CUT OFF HERE');
  });

  it('says what a cut costs, not just that there was one', async () => {
    /*
     * "… (truncated)" is a footnote, and a footnote is what got read past. The
     * reader needs the RULE that follows: you cannot conclude absence from a
     * file you were shown two thirds of.
     */
    file('big.py', `# ${'x'.repeat(20000)}\n`);

    const out = await hintedBodies(repo(), ['big.py']);

    expect(out).toMatch(/more characters of big\.py/);
    expect(out).toMatch(/Nothing can be concluded to be ABSENT/i);
  });

  it('lets a caller that cannot afford the room ask for less', async () => {
    // fitPrompt trims BODIES on purpose; that is different from a flat cap
    // hiding the end of a file by accident.
    file('cli.py', 'x'.repeat(500));

    const out = await hintedBodies(repo(), ['cli.py'], 100);

    expect(out).toContain('CUT OFF HERE');
  });

  it('stops at a handful of files, whatever the plan declared', async () => {
    for (let i = 0; i < 12; i++) file(`f${i}.py`, `def f${i}(): pass`);

    const out = await hintedBodies(
      repo(),
      Array.from({ length: 12 }, (_, i) => `f${i}.py`),
    );

    expect(out).toContain('def f0()');
    expect(out).not.toContain('def f11()');
  });

  it('says nothing at all when the plan declared no files', async () => {
    expect(await hintedBodies(repo(), [])).toBe('');
  });

  it('does not throw on a path that is a directory', async () => {
    // A plan is written by a model and its file list is data. This has to
    // answer rather than take the run down with it.
    mkdirSync(join(dir, 'src'), { recursive: true });

    const out = await hintedBodies(repo(), ['src']);

    expect(out).toContain('src');
    expect(out).toContain('could not be read');
  });
});
