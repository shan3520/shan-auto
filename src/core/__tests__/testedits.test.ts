import { describe, it, expect } from 'vitest';
import { logicalLines, proofStatements, keepsEveryProof } from '../testedits.js';

/*
 * The two edits this module exists to tell apart. Both are real, both are to
 * `tests/api/test_stats.py` in example-api, and both were undeclared.
 *
 * The first is commit 161b15a, 2026-08-20 — the abuse TEST_TAMPER was written
 * for. The second is the tree in `stash@{0}`, 2026-08-23, deleted by that rule.
 * Reproduced from the diffs, not paraphrased: if the check cannot separate
 * these two it does not matter what else it separates.
 */

const BEFORE_2020 = `
def test_popular_documents_endpoint():
    db = SessionLocal()
    try:
        db.add(log)
        db.commit()

        rs = [DocumentRetrievalLog(query_log_id=log.id, document_id=doc_id) for _ in range(5)]
        db.add_all(rs)
        db.commit()
    finally:
        db.close()

    resp = client.get("/api/stats/popular-documents?limit=10", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
    assert any(d["document_id"] == doc_id and d["count"] >= 5 for d in data)
`;

/** 5 rows became 100 AND the assertion moved with them. */
const AFTER_2020 = BEFORE_2020
  .replace('range(5)', 'range(100)')
  .replace('d["count"] >= 5', 'd["count"] >= 100');

const BEFORE_2023 = `
def test_popular_documents_honors_days_and_raises_on_empty_window():
    db = SessionLocal()
    try:
        db.commit()

        rs = [
            DocumentRetrievalLog(query_log_id=fresh_log.id, document_id=fresh_doc_id)
            for _ in range(3)
        ] + [
            DocumentRetrievalLog(query_log_id=stale_log.id, document_id=stale_doc_id)
            for _ in range(2)
        ]
        db.add_all(rs)
    finally:
        db.close()

    assert resp.status_code == 200
    assert len(resp.json()) == 1
`;

/**
 * The counting changed, so the seeded rows needed a date they never had. The
 * stale document's opens are dated 20 days back — the test is named for that
 * window and still proves it.
 */
const AFTER_2023 = BEFORE_2023
  .replace(
    'DocumentRetrievalLog(query_log_id=fresh_log.id, document_id=fresh_doc_id)',
    'DocumentRetrievalLog(query_log_id=fresh_log.id, document_id=fresh_doc_id, opened_at=now)',
  )
  .replace(
    'DocumentRetrievalLog(query_log_id=stale_log.id, document_id=stale_doc_id)',
    'DocumentRetrievalLog(query_log_id=stale_log.id, document_id=stale_doc_id, ' +
      'opened_at=now - timedelta(days=20))',
  );

describe('the two edits', () => {
  it('refuses the one that moved the assertion (161b15a, 2026-08-20)', () => {
    expect(keepsEveryProof(BEFORE_2020, AFTER_2020)).toBe(false);
  });

  it('allows the one that only dated the seed rows (stash@{0}, 2026-08-23)', () => {
    expect(keepsEveryProof(BEFORE_2023, AFTER_2023)).toBe(true);
  });

  it('would still refuse the 2020 edit if the fixture had been left alone', () => {
    // The fixture is not what made it tampering. The assertion is.
    const assertionOnly = BEFORE_2020.replace('d["count"] >= 5', 'd["count"] >= 100');
    expect(keepsEveryProof(BEFORE_2020, assertionOnly)).toBe(false);
  });

  it('would have allowed the 2020 edit if only the fixture had moved', () => {
    /*
     * Recorded because it is the cost of this check, not because it is
     * comfortable: 100 rows asserted `>= 5` is a weaker test than 5 rows
     * asserted `>= 5`, and nothing here can see that. It goes to the reviewer
     * named, with the hunk, which is the whole reason the file is surfaced
     * rather than waved through.
     */
    const fixtureOnly = BEFORE_2020.replace('range(5)', 'range(100)');
    expect(keepsEveryProof(BEFORE_2020, fixtureOnly)).toBe(true);
  });
});

describe('what counts as losing a proof', () => {
  const src = `
def test_a():
    assert one() == 1

def test_b():
    assert two() == 2
`;

  it('a deleted assertion', () => {
    expect(keepsEveryProof(src, src.replace('    assert two() == 2\n', ''))).toBe(false);
  });

  it('a deleted test', () => {
    expect(keepsEveryProof(src, 'def test_a():\n    assert one() == 1\n')).toBe(false);
  });

  it('a renamed test — the name is what the runner reports and the reader reads', () => {
    expect(keepsEveryProof(src, src.replace('def test_b()', 'def test_b_disabled()'))).toBe(false);
  });

  it('a skip mark, which is an assertion deleted with extra steps', () => {
    const skipped = src.replace('def test_b():', '@pytest.mark.skip(reason="flaky")\ndef test_b():');
    expect(keepsEveryProof(src, skipped)).toBe(false);
  });

  it('a `pytest.skip()` dropped into a test that was running', () => {
    const off = src.replace('def test_b():\n', 'def test_b():\n    pytest.skip("later")\n');
    expect(keepsEveryProof(src, off)).toBe(false);
  });

  it('an `it.only` added, which silences every sibling it does not name', () => {
    /*
     * The one disabler with no name to attribute it to: the tests it switches
     * off are the ones it says nothing about. So it is counted, not named.
     */
    const ts = "it('a', () => {\n  expect(1).toBe(1);\n});\n";
    /*
     * Added as a NEW test, so nothing that was here went missing and nothing
     * that was here is named skip. Every other rule in this module says yes.
     * `it('a')` never runs again all the same.
     */
    const added = `${ts}\nit.only('b', () => {\n  expect(2).toBe(2);\n});\n`;
    expect(keepsEveryProof(ts, added)).toBe(false);
  });

  it('one of two identical assertions', () => {
    const twice = 'def test_a():\n    assert one() == 1\n    assert one() == 1\n';
    const once = 'def test_a():\n    assert one() == 1\n';
    expect(keepsEveryProof(twice, once)).toBe(false);
    // ...and the other direction is an addition, which is always fine.
    expect(keepsEveryProof(once, twice)).toBe(true);
  });

  it('an assertion buried in a continuation line', () => {
    const before = 'def test_a():\n    assert rows == [\n        1,\n        2,\n    ]\n';
    const after = 'def test_a():\n    assert rows == [\n        1,\n        3,\n    ]\n';
    // Nothing on the changed line looks like an assertion. It is one.
    expect(keepsEveryProof(before, after)).toBe(false);
  });
});

describe('what does not count', () => {
  const src = 'def test_a():\n    setup(rows=5)\n    assert one() == 1\n';

  it('adding a test', () => {
    expect(keepsEveryProof(src, `${src}\ndef test_b():\n    assert two() == 2\n`)).toBe(true);
  });

  it('adding an assertion to a test that is already there', () => {
    expect(keepsEveryProof(src, src.replace('assert one() == 1', 'assert one() == 1\n    assert one() > 0'))).toBe(true);
  });

  it('changing setup', () => {
    expect(keepsEveryProof(src, src.replace('setup(rows=5)', 'setup(rows=5, opened_at=now)'))).toBe(true);
  });

  it('moving a test within its file', () => {
    const two = 'def test_a():\n    assert one() == 1\n\ndef test_b():\n    assert two() == 2\n';
    const swapped = 'def test_b():\n    assert two() == 2\n\ndef test_a():\n    assert one() == 1\n';
    expect(keepsEveryProof(two, swapped)).toBe(true);
  });

  it('reindenting', () => {
    expect(keepsEveryProof(src, src.replace('    assert', '\t assert'))).toBe(true);
  });

  it('adding a test that is itself skipped', () => {
    /*
     * The file gained a skip mark, and refusing on that alone would mean an
     * agent could never land a test it knows is not ready — which the brief
     * does sometimes ask for. Only a test that was HERE and RUNNING has
     * anything to lose, which is why skips are tracked by name.
     */
    const added = `${src}\n@pytest.mark.skip\ndef test_b():\n    assert two() == 2\n`;
    expect(keepsEveryProof(src, added)).toBe(true);
  });

  it('a file with no proofs in it at all', () => {
    // conftest.py, fixtures, helpers. Nothing to lose, so nothing is refused.
    expect(keepsEveryProof('import pytest\n\n@pytest.fixture\ndef db():\n    yield 1\n', 'x = 2\n')).toBe(true);
  });
});

describe('TypeScript', () => {
  const src = `
describe('adder', () => {
  it('adds', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('handles zero', () => {
    expect(add(0, 0)).toBe(0);
  });
});
`;

  it('a block is one statement and its body is separate statements', () => {
    /*
     * The whole point of BLOCK_OPEN. Joining on brackets alone makes the outer
     * `describe(` swallow every line under it, and a file that is one logical
     * line cannot have anything compared against it.
     */
    expect(proofStatements(src).length).toBeGreaterThan(4);
  });

  it('refuses a changed expectation', () => {
    expect(keepsEveryProof(src, src.replace('toBe(3)', 'toBe(4)'))).toBe(false);
  });

  it('refuses an `it` turned into `it.skip`', () => {
    expect(keepsEveryProof(src, src.replace("it('handles zero'", "it.skip('handles zero'"))).toBe(false);
  });

  it('allows a changed input that both sides still assert on', () => {
    const s = "it('adds', () => {\n  const a = 1;\n  expect(add(a, 2)).toBe(3);\n});\n";
    expect(keepsEveryProof(s, s.replace('const a = 1;', 'const a = 1; // seeded'))).toBe(true);
  });

  it('keeps a multi-line matcher object whole', () => {
    const before = "it('x', () => {\n  expect(r).toEqual({\n    a: 1,\n  });\n});\n";
    const after = before.replace('a: 1,', 'a: 2,');
    expect(keepsEveryProof(before, after)).toBe(false);
  });
});

describe('logicalLines', () => {
  it('joins a statement that spans lines', () => {
    // The trailing comma goes with the wrap: a formatter that explodes a call
    // adds one, and a comma before a closing bracket asserts nothing. See
    // logicalLines.
    expect(logicalLines('assert x == [\n  1,\n  2,\n]\n')).toEqual(['assert x == [1, 2]']);
  });

  /*
   * O24's last bullet. The rule "errs toward refusing", and the named cost was
   * a task rejected for changing nothing — because Black and Prettier explode a
   * call across lines AND add a trailing comma while doing it. Both spellings
   * assert the same thing, so both must read the same.
   */
  it('reads a formatter rewrap as the same proof it was before', () => {
    const before = logicalLines('self.assertEqual(total, 340)\n');
    const after = logicalLines('self.assertEqual(\n    total,\n    340,\n)\n');
    expect(after).toEqual(before);
  });

  it('still reads a changed value as a different proof', () => {
    // The normalisation must not reach past the comma into what is asserted.
    const before = logicalLines('self.assertEqual(total, 340)\n');
    const after = logicalLines('self.assertEqual(\n    total,\n    341,\n)\n');
    expect(after).not.toEqual(before);
  });

  it('splits at a block opener even with a paren still open', () => {
    expect(logicalLines("it('x', () => {\n  expect(1).toBe(1);\n});\n")).toEqual([
      "it('x', () => {",
      'expect(1).toBe(1);',
      '});',
    ]);
  });

  it('does not lose the last statement in a file that ends unbalanced', () => {
    // A bracket inside a string leaves the count wrong. Whatever is buffered
    // still comes out; it simply will not match the other side, and the edit is
    // refused. That is the safe direction.
    expect(logicalLines('assert x == ")"\nassert y == 1\n').join(' | ')).toContain('assert y == 1');
  });
});
