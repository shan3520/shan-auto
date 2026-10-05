import { describe, it, expect } from 'vitest';
import { verifyTargets, checkCovers } from '../taskprompt.js';

/*
 * These two exist because the prompt stopped printing the gate command.
 *
 * On 2026-08-20 a from-zero run put four tasks through agy and committed none.
 * Two died reaching for the gate command the prompt had just shown them —
 * `python -m pytest -q tests/db/test_search_logs.py` and
 * `python -m pytest -q tests/api/test_stats.py`, character for character — which
 * agy's exact-match allow-list refuses and no allow-list could ever enumerate,
 * since the path changes with every task.
 *
 * The agent still has to know what is being checked. verifyTargets says that in
 * paths rather than in a runnable string, and checkCovers decides whether the
 * agent can be told, honestly, that the command it MAY run already covers it.
 */

describe('verifyTargets', () => {
  it('names the test file, which is the part the agent actually needs', () => {
    expect(verifyTargets('python -m pytest -q tests/db/test_search_logs.py')).toEqual([
      'tests/db/test_search_logs.py',
    ]);
  });

  it('handles the multi-file gates the planner really produces', () => {
    expect(
      verifyTargets('python -m pytest tests/api/test_stats.py tests/services/test_usage.py -q'),
    ).toEqual(['tests/api/test_stats.py', 'tests/services/test_usage.py']);
  });

  it('does not mistake a flag or its value for a path', () => {
    expect(verifyTargets('python -m pytest -q --maxfail=1 tests/x.py')).toEqual(['tests/x.py']);
  });

  it('says nothing when the gate names no file, rather than inventing one', () => {
    expect(verifyTargets('npm test')).toEqual([]);
    expect(verifyTargets('python -m pytest -q')).toEqual([]);
  });

  it('strips the quotes a shell would', () => {
    expect(verifyTargets('pytest "tests/db/test_x.py"')).toEqual(['tests/db/test_x.py']);
  });

  it('gives up on a path containing a space, rather than half-reporting it', () => {
    /*
     * Splitting on whitespace cannot hold `"tests/a b/test_x.py"` together, and
     * a real tokenizer is not worth writing for it: this feeds a sentence to an
     * agent, and no gate the planner has ever produced names such a path. What
     * matters is that the failure is visible here rather than showing the agent
     * a truncated filename it would then go and create.
     */
    expect(verifyTargets('pytest "tests/a b/test_x.py"')).not.toContain('tests/a b/test_x.py');
  });

  it('does not repeat a path the gate names twice', () => {
    expect(verifyTargets('pytest tests/x.py && pytest tests/x.py')).toEqual(['tests/x.py']);
  });
});

describe('checkCovers', () => {
  it('is true when the gate is the permitted command narrowed to a file', () => {
    // The exact example-api shape, and the reason the agent has no need of the
    // narrow spelling it keeps getting denied.
    expect(checkCovers('python -m pytest -q', 'python -m pytest -q tests/db/test_x.py')).toBe(true);
  });

  it('is true when they are the same command', () => {
    expect(checkCovers('npm test', 'npm test')).toBe(true);
  });

  it('is false for a compound gate, which runs something else as well', () => {
    // example-api's real repo gate. compileall is not covered by pytest, and
    // claiming otherwise would be the prompt lying to the agent.
    expect(
      checkCovers('python -m pytest -q', 'python -m compileall -q . && python -m pytest -q'),
    ).toBe(false);
  });

  it('is false when the gate adds a flag rather than a path', () => {
    expect(checkCovers('python -m pytest -q', 'python -m pytest -q --maxfail=1')).toBe(false);
  });

  it('is false across different programs', () => {
    expect(checkCovers('npm test', 'python -m pytest -q tests/x.py')).toBe(false);
  });

  it('is false when there is no permitted command at all', () => {
    expect(checkCovers('', 'python -m pytest -q tests/x.py')).toBe(false);
  });
});
