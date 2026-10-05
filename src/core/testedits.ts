/**
 * Did an edit to an existing test change what it PROVES, or only what it sets up?
 *
 * The gate refuses any edit an agent makes to a test that was already in the
 * repo and that the plan never declared (`TEST_TAMPER`). That rule was written
 * on 2026-08-20 against a real abuse: a task rewrote `tests/api/test_stats.py`,
 * moving a fixture from 5 rows to 100 AND its assertion from `>= 5` to `>= 100`.
 * The suite went green and the gate committed it.
 *
 * On 2026-08-23 the same rule threw away the best work of a run. Task
 * `Th23pq9f3b1` changed how document opens are counted — from a global recent-
 * activity slice to a document's own open records. Two tests in that same
 * `test_stats.py` seed opens with no `opened_at`, so under the new counting they
 * counted nothing and went red. The agent added the field to three seed rows,
 * dating the stale document's opens 20 days back so the "honors days" test still
 * proved what its name says. It touched no assertion. Every test in the repo
 * passed, the fix was mutation-proven by hand, and all of it was reverted.
 *
 * Both files are the same file and both edits are undeclared. What separates
 * them is not WHICH file was touched but WHAT was taken away: one moved the bar,
 * the other moved the ball. So the question this module answers is narrow —
 * is every proof this file already made still being made?
 *
 * Setup can weaken a test too, and this does not pretend otherwise; a seeded row
 * removed is evidence removed. The files that get here are named to the reviewer
 * as undeclared, which is where a judgement about seed data belongs. What is
 * refused without a judgement is the one move that cannot be honest.
 *
 * It errs toward refusing, and that direction is deliberate: the false positive
 * costs one task an attempt — the same answer it got before this module existed
 * — and the false negative costs the gate the evidence it judges everything
 * else by.
 *
 * The formatter case named in O24 is handled rather than tolerated. Joining
 * continuation lines absorbs the wrap, and the trailing comma that Black and
 * Prettier add while exploding a call is normalised away with it, since a comma
 * before a closing bracket asserts nothing. What is left needs a parser to
 * separate from a rewrite, and this has names, brackets and whitespace.
 */

/**
 * A source line, joined across continuations, that carries a test's proof.
 *
 * Assertions and the declarations of the tests that hold them. What switches a
 * test OFF is counted separately below: a skip is a proof lost by addition, and
 * containment only ever sees loss by subtraction.
 */
const PROOF = [
  // Python
  /^assert\b/,
  /^self\.assert\w*\s*\(/,
  /^self\.fail\s*\(/,
  /\bpytest\.(raises|warns|fail|approx|deprecated_call)\b/,
  /^(async\s+)?def\s+test\w*\s*\(/,
  // TypeScript / JavaScript
  /^expect\s*\(/,
  /^await\s+expect\s*\(/,
  /^assert\s*[.(]/,
  /^(it|test|describe)\s*\(/,
];

/**
 * Switching a test off is the one way to weaken a file by ADDING to it.
 *
 * Containment only ever notices something going missing, and
 * `@pytest.mark.skip` above a test takes nothing away: the `def` line is still
 * there, every assertion under it is still there, and none of them will ever
 * run again. (`it.skip(` happens to be caught anyway — writing it rewrites the
 * `it(` line, so the original goes missing — but that is luck of syntax, and
 * Python's decorator, sitting on a line of its own, proves it does not
 * generalise.)
 *
 * So these are tracked BY NAME rather than counted. A count would also refuse a
 * task for adding a new test it marked skip, which weakens nothing and is
 * occasionally what the brief asked for. What is refused is a test that was
 * running before this task and is not running now.
 */
const DECORATED_OFF = /^@pytest\.mark\.(skip|skipif|xfail)\b/;
const DECLARED_OFF = /^(x(it|describe|test)\s*\(|(it|test|describe)\.(skip|todo|failing)\b)/;
const CALLED_OFF = /\bpytest\.(skip|xfail)\s*\(/;

/**
 * `.only` is a switch on every OTHER test, so it is counted, not named.
 *
 * One `it.only` in a file silences every sibling it has, including ones this
 * task never looked at. There is no name to attribute that to — the tests it
 * disables are the ones it does not mention — so the question can only be
 * whether the file gained one.
 */
const ONLY = /^(it|test|describe)\.only\b/;

/** The test a line declares, by the name a runner would report. */
function testName(line: string): string | null {
  const py = /^(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
  if (py) return py[1] ?? null;
  const ts = /^x?(?:it|test|describe)(?:\.\w+)?\s*\(\s*(['"`])(.*?)\1/.exec(line);
  return ts?.[2] ?? null;
}

/** Every test this source declares, by that same name. */
export function declaredTests(src: string): Set<string> {
  const out = new Set<string>();
  for (const line of logicalLines(src)) {
    const name = testName(line);
    if (name) out.add(name);
  }
  return out;
}

/** Which tests this source has switched off. */
export function disabledTests(src: string): Set<string> {
  const off = new Set<string>();
  let decorated = false;
  let current: string | null = null;

  for (const line of logicalLines(src)) {
    if (DECORATED_OFF.test(line)) {
      decorated = true;
      continue;
    }
    const name = testName(line);
    if (name) {
      current = name;
      if (decorated || DECLARED_OFF.test(line)) off.add(name);
      decorated = false;
      continue;
    }
    // A bare `pytest.skip(...)` in a body switches off the test it is inside.
    if (current && CALLED_OFF.test(line)) off.add(current);
  }
  return off;
}

/** How many tests this source silences its siblings for. */
function countOnly(src: string): number {
  return logicalLines(src).filter((l) => ONLY.test(l)).length;
}

/**
 * A brace that opens a BLOCK rather than a value.
 *
 * `it('x', () => {` and `expect(x).toEqual({` both end on an open brace with an
 * open paren still standing, and they have to be split in opposite directions.
 * The first is a statement that is finished; everything after it is separate
 * statements, and joining them makes one logical line out of a whole test file.
 * The second is a statement mid-sentence: the object being matched IS the
 * assertion, and splitting it puts the values out of reach.
 *
 * What tells them apart is the character before the brace. After `=>`, after a
 * closed parameter list, after `else`, `try`, `do` — a block. After `(`, after
 * `==`, after `return` — a value.
 */
const BLOCK_OPEN = /(?:=>|\)|\belse\b|\btry\b|\bdo\b)\s*\{$/;

/**
 * Logical lines: source lines joined until the statement they start is over.
 *
 * A line-by-line scan is not enough and the gap is exactly where an edit would
 * hide. `assert result == [\n  1, 2, 3,\n]` spends its second line on the values
 * being asserted and that line holds no keyword at all — changing a 3 to a 4
 * there is an assertion rewritten out of the reach of any per-line rule.
 *
 * Strings are not parsed. A bracket inside a quoted string can leave the depth
 * wrong and glue the next statements onto this one, which produces a logical
 * line that matches nothing and, on the other side of the comparison, a
 * different one. The two sides then disagree and the edit is refused — the safe
 * direction, and the same answer the gate gave before this module existed.
 */
export function logicalLines(src: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;

  const flush = (): void => {
    if (buf) out.push(buf);
    buf = '';
    depth = 0;
  };

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (depth === 0) flush();
      continue;
    }
    buf = buf ? `${buf} ${line}` : line;
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    // depth <= 0: the statement closed. Negative means the count was already
    // lost — a bracket inside a string — and resetting beats swallowing every
    // line after it.
    if (depth <= 0 || BLOCK_OPEN.test(line)) flush();
  }
  flush();
  /*
   * Whitespace, then the trailing comma a formatter leaves behind.
   *
   * O24's remaining bullet: "an assertion rewrapped across lines by a formatter
   * normalises to a different string and reads as a rewrite, so a task can be
   * rejected for changing nothing". Joining continuation lines already handles
   * the wrap itself. What it did not handle is the comma that comes WITH the
   * wrap — Black and Prettier both explode a call across lines and add a
   * trailing comma while doing it, so `assertEqual(a, b)` comes back as
   * `assertEqual(a, b, )` and reads as a different proof.
   *
   * Safe to normalise because it cannot hide anything: a trailing comma before
   * a closing bracket carries no value and asserts nothing. Every other
   * difference still reads as a difference, which is the whole point of a rule
   * whose false negative costs the gate the evidence it judges by.
   */
  return out.map((l) =>
    l
      .replace(/\s+/g, ' ')
      // The comma a formatter adds when it explodes a call, and the padding the
      // join leaves at each bracket. None of it is asserted.
      .replace(/,\s*([)\]}])/g, '$1')
      .replace(/([([{])\s+/g, '$1')
      .replace(/\s+([)\]}])/g, '$1')
      .trim(),
  );
}

/**
 * Every proof this source makes, normalised, in file order.
 *
 * Order is kept for the reader; the comparison below is by count, so moving a
 * test within its file is not a change to what it proves.
 */
export function proofStatements(src: string): string[] {
  return logicalLines(src).filter((line) => PROOF.some((re) => re.test(line)));
}

/**
 * Is every proof `before` made still made by `after`?
 *
 * Containment, not equality, and by count. New assertions and whole new tests
 * are additions — a suite is not weakened by being added to, and a task that
 * strengthens a test it found on its way past should not be punished for it.
 * What may not happen is a proof going missing: an assertion deleted, an
 * assertion rewritten (which is a deletion and an addition), a test removed, or
 * one of two identical assertions dropped.
 *
 * Switching a test off is checked first and separately, because that one takes
 * a proof away by adding a line and containment would see nothing.
 */
export function keepsEveryProof(before: string, after: string): boolean {
  const ran = declaredTests(before);
  const wasOff = disabledTests(before);
  for (const name of disabledTests(after)) {
    // Only a test that was here and running has anything to lose. A new test
    // the task wrote and marked skip weakens nothing.
    if (ran.has(name) && !wasOff.has(name)) return false;
  }
  if (countOnly(after) > countOnly(before)) return false;

  const left = proofStatements(before);
  if (left.length === 0) return true;

  const remaining = new Map<string, number>();
  for (const p of proofStatements(after)) remaining.set(p, (remaining.get(p) ?? 0) + 1);

  for (const p of left) {
    const n = remaining.get(p) ?? 0;
    if (n === 0) return false;
    remaining.set(p, n - 1);
  }
  return true;
}
