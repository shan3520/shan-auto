import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Repo, TaskRow } from '../../schemas.js';

/*
 * O27 — the one outcome nobody checked, 2026-08-30.
 *
 * A commit gets a gate result and a QA review. A failure gets a journal entry,
 * a stashed tree and a retry. `ALREADY_DONE` got a sentence from the agent that
 * made the claim, and the task closed. Both guards on that path — `NO_CHANGES`
 * and `saysAlreadyDone` — ask whether the claim was ASSERTED. Nothing asked
 * whether it was TRUE.
 *
 * It is the most expensive one to get wrong: a drop writes `already_done` into
 * the planner's dedupe, so a false claim suppresses the proposal that would have
 * built the thing, permanently, and nothing retracts it. Run 24's junior was
 * sincere, careful and wrong.
 *
 * The evidence was already in the ledger the whole time. Every task's plan
 * records which files and symbols it will add, and nothing read it back.
 */

let dir: string;
let checkDropClaim: typeof import('../dropcheck.js').checkDropClaim;
let contradictedNote: typeof import('../dropcheck.js').contradictedNote;

const claimStore: { value: { paths: string[]; symbols: string[] } | null } = { value: null };

vi.mock('../../ledger.js', () => ({
  getClaim: () => claimStore.value,
}));

const task = () => ({ id: 'T1', title: 'Implement the add command' }) as TaskRow;
const repo = () => ({ id: 'example-tracker', path: dir } as Repo);

/** Put a file in the scratch repo, creating its folder. */
const file = (rel: string, body: string) => {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sa-drop-'));
  claimStore.value = null;
  ({ checkDropClaim, contradictedNote } = await import('../dropcheck.js'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('checking a claim that the work was already there', () => {
  it('confirms it when every symbol the plan named is in the files it named', () => {
    /*
     * The real claim from T4uxha4ldlc, which was dropped on 2026-08-30 and
     * happened to be true. Deciding that took no model and no diff.
     */
    claimStore.value = {
      paths: ['src/expense_tracker/cli.py', 'tests/test_cli.py'],
      symbols: ['main', 'add_expense'],
    };
    file('src/expense_tracker/cli.py', 'def add_expense(amount):\n    pass\n\ndef main():\n    pass\n');
    file('tests/test_cli.py', 'def test_add():\n    pass\n');

    const out = checkDropClaim(repo(), task());
    expect(out.verdict).toBe('confirmed');
    expect(out.evidence).toContain('add_expense');
  });

  it('contradicts it when a symbol appears nowhere', () => {
    claimStore.value = { paths: ['cli.py'], symbols: ['add_expense', 'summarise'] };
    file('cli.py', 'def add_expense(amount):\n    pass\n');

    const out = checkDropClaim(repo(), task());
    expect(out.verdict).toBe('contradicted');
    if (out.verdict !== 'contradicted') throw new Error('unreachable');
    // Names the missing one only. "Some of this is missing" is not actionable.
    expect(out.missing).toEqual(['summarise']);
    expect(out.evidence).toContain('summarise');
    expect(out.evidence).not.toMatch(/\badd_expense appears\b/);
  });

  it('contradicts it when a file the plan named does not exist at all', () => {
    /*
     * The run-24 shape, and the one that needs no symbols to catch: copilot
     * reported the `app/` SQLAlchemy structure as present in a workspace that
     * did not contain it.
     */
    claimStore.value = { paths: ['app/models/document.py'], symbols: [] };

    const out = checkDropClaim(repo(), task());
    expect(out.verdict).toBe('contradicted');
    expect(out.evidence).toContain('app/models/document.py');
  });

  it('holds the tests to the same standard as the code', () => {
    // "The work is already there" is a claim about the tests too.
    claimStore.value = { paths: ['cli.py', 'tests/test_cli.py'], symbols: [] };
    file('cli.py', 'def add_expense():\n    pass\n');

    expect(checkDropClaim(repo(), task()).verdict).toBe('contradicted');
  });

  it('says it could not check rather than guessing, when nothing was declared', () => {
    // 27 of 77 claims in the ledger are in this state. A verdict this cannot
    // support is worse than an honest absence of one.
    claimStore.value = { paths: ['cli.py'], symbols: [] };
    file('cli.py', 'anything at all');

    const out = checkDropClaim(repo(), task());
    expect(out.verdict).toBe('unchecked');
    expect(out.evidence).toContain('declared no symbols');
  });

  it('says it could not check when the task has no claim at all', () => {
    claimStore.value = null;
    expect(checkDropClaim(repo(), task()).verdict).toBe('unchecked');
  });

  /*
   * The false-accusation cases. Each is real work that a stricter reader would
   * call a lie, and a wrong contradiction sends a genuinely finished task back
   * to fail twice and end up `failed`.
   */
  it('accepts a method on a class, which is not a module-level definition', () => {
    claimStore.value = { paths: ['cli.py'], symbols: ['summarise'] };
    file('cli.py', 'class Report:\n    def summarise(self):\n        pass\n');

    expect(checkDropClaim(repo(), task()).verdict).toBe('confirmed');
  });

  it('accepts a decorated route, which is the whole FastAPI idiom', () => {
    claimStore.value = { paths: ['api.py'], symbols: ['get_clustered_queries'] };
    file('api.py', '@router.get("/clustered")\ndef get_clustered_queries():\n    pass\n');

    expect(checkDropClaim(repo(), task()).verdict).toBe('confirmed');
  });

  it('accepts a private helper, which is correct design and not a missing symbol', () => {
    claimStore.value = { paths: ['cli.py'], symbols: ['_load'] };
    file('cli.py', 'def _load():\n    pass\n');

    expect(checkDropClaim(repo(), task()).verdict).toBe('confirmed');
  });

  it('does not match a symbol inside a longer name', () => {
    // `add` must not be satisfied by `add_expense`, or the check confirms
    // anything whose name happens to be a prefix of something present.
    claimStore.value = { paths: ['cli.py'], symbols: ['add'] };
    file('cli.py', 'def add_expense():\n    pass\n');

    expect(checkDropClaim(repo(), task()).verdict).toBe('contradicted');
  });

  it('survives a symbol name that looks like a regex', () => {
    // A plan is written by a model; a symbol name is data, and this must
    // answer rather than throw.
    claimStore.value = { paths: ['cli.py'], symbols: ['add(*'] };
    file('cli.py', 'def add_expense():\n    pass\n');

    expect(() => checkDropClaim(repo(), task())).not.toThrow();
    expect(checkDropClaim(repo(), task()).verdict).toBe('contradicted');
  });
});

describe('what a contradicted claim tells the next attempt', () => {
  it('names what is missing and why the claim cannot be taken back', () => {
    const note = contradictedNote({
      verdict: 'contradicted',
      missing: ['summarise'],
      evidence: 'the plan said this task would add summarise, and summarise appears nowhere in cli.py',
    });

    expect(note).toContain('ALREADY_DONE');
    expect(note).toContain('summarise');
    // The stake, stated: this is why the agent should look again rather than
    // repeat itself with more confidence.
    expect(note).toMatch(/cannot be taken back/i);
  });
});
