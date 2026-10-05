import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ledger from '../ledger.js';
import type { Repo, TaskRow } from '../schemas.js';

/**
 * Checking a claim that the work was already there.
 *
 * O27. A dropped task is the only outcome nobody reviews. A commit gets a gate
 * result and a QA review; a failure gets a journal entry, a stashed tree and a
 * retry; `ALREADY_DONE` gets a sentence from the agent that made the claim, and
 * the task closes. The two guards on that path — `NO_CHANGES` and
 * `saysAlreadyDone` — both ask whether the claim was ASSERTED, which it was.
 * Nothing asked whether it was TRUE.
 *
 * It is also the most expensive outcome to get wrong. A drop writes
 * `already_done` into the reasoning pool and the planner's dedupe, so a wrong
 * one teaches the brain the work exists and suppresses the proposal that would
 * have built it. A wrong failure costs an attempt; a wrong drop costs the
 * feature, permanently, and nothing retracts it. Run 24: the junior's claim was
 * sincere, careful and wrong, and the models it said were there had never been
 * written.
 *
 * The issue was recorded rather than fixed because the obvious answer — route a
 * drop through the QA reviewer — means teaching a reviewer that reads diffs to
 * judge a claim about code that did not change. That is still true. What
 * changed is that the plan already wrote down what this task was going to add,
 * in `task_claims`, and nothing was reading it back:
 *
 *     T4uxha4ldlc  paths ["src/expense_tracker/cli.py", "tests/test_cli.py"]
 *                  symbols ["main", "add_expense"]
 *
 * That task was dropped as already-done on 2026-08-30 and the claim happened to
 * be true. Deciding that took no model and no diff — the names are either in the
 * file or they are not.
 */

/** What could be established about a drop, and on what evidence. */
export type DropCheck =
  | { verdict: 'confirmed'; evidence: string }
  | { verdict: 'contradicted'; missing: string[]; evidence: string }
  | { verdict: 'unchecked'; evidence: string };

/**
 * Deliberately the weakest test that cannot be wrong.
 *
 * Not `publicSymbols`, which is the right tool for the dead-export gate and the
 * wrong one here: it reads module-level definitions only, skips decorated ones
 * and skips a leading underscore, all correct for "does anything reference
 * this" and all sources of a FALSE ACCUSATION here. A method on a class, a
 * decorated route, a `_helper` — each is real work that `publicSymbols` does not
 * report, and calling that a lie would send a genuinely finished task back to
 * fail twice and end up `failed`.
 *
 * So the question asked is only: does this name occur in the file at all, as a
 * whole word. If `add_expense` appears nowhere in `cli.py`, the work is not
 * there and no parsing subtlety changes that. If it appears, this says nothing
 * about whether it is CORRECT — that is the reviewer's job, and the reviewer
 * has no diff to read. Catching "it was never written" is the whole ambition,
 * because that is the failure on record.
 */
function mentions(src: string, name: string): boolean {
  // Escaped: a symbol name is data, and a plan that ever produced a regex
  // metacharacter would otherwise throw here rather than answer.
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${safe}\\b`).test(src);
}

/**
 * Was the work this task was planned to do actually found in the tree?
 *
 * Never throws: a check that cannot run returns `unchecked`, because an
 * unreadable file is a reason to say nothing, not a reason to accuse.
 */
export function checkDropClaim(repo: Repo, task: TaskRow): DropCheck {
  const claim = ledger.getClaim(task.id);
  const paths = claim?.paths ?? [];
  const symbols = claim?.symbols ?? [];

  if (!paths.length) {
    return {
      verdict: 'unchecked',
      evidence: 'the plan named no files for this task, so there is nothing to look for',
    };
  }

  /*
   * A named file that does not exist contradicts the claim on its own, whatever
   * the symbols say. This is the run-24 shape: "the app/ SQLAlchemy structure"
   * reported as present in a workspace that did not contain it.
   *
   * Test paths are held to the same standard deliberately. "The work is already
   * there" is a claim about the tests as much as the code, and a task that was
   * planned to add `tests/test_cli.py` has not been done if that file is absent.
   */
  const missingFiles = paths.filter((f) => !existsSync(join(repo.path, f)));
  if (missingFiles.length) {
    return {
      verdict: 'contradicted',
      missing: missingFiles,
      evidence:
        `the plan said this task would change ${paths.length} file(s) and ` +
        `${missingFiles.length} of them do not exist: ${missingFiles.join(', ')}`,
    };
  }

  if (!symbols.length) {
    /*
     * Files present, nothing named to look for inside them. Not confirmation —
     * the files may well have existed before this task was ever planned — but
     * not a contradiction either, and saying so is more useful than a verdict
     * this cannot support. 27 of 77 claims in the ledger are in this state.
     */
    return {
      verdict: 'unchecked',
      evidence:
        `every file the plan named exists, but it declared no symbols, so ` +
        `whether THIS task's work is among them cannot be established here`,
    };
  }

  let text = '';
  for (const f of paths) {
    try {
      text += `\n${readFileSync(join(repo.path, f), 'utf8')}`;
    } catch {
      // Unreadable rather than absent — existsSync passed a moment ago. Say
      // nothing rather than accuse on the strength of a race or a permission.
      return {
        verdict: 'unchecked',
        evidence: `${f} exists but could not be read, so the claim was not checked`,
      };
    }
  }

  const missing = symbols.filter((s) => !mentions(text, s));
  if (missing.length) {
    return {
      verdict: 'contradicted',
      missing,
      evidence:
        `the plan said this task would add ${symbols.join(', ')}, and ` +
        `${missing.join(', ')} appear${missing.length === 1 ? 's' : ''} nowhere in ` +
        `${paths.join(', ')}`,
    };
  }

  return {
    verdict: 'confirmed',
    evidence: `${symbols.join(', ')} are all present in ${paths.join(', ')}`,
  };
}

/** What the next attempt is told when its claim did not survive the check. */
export function contradictedNote(check: Extract<DropCheck, { verdict: 'contradicted' }>): string {
  return (
    `You reported this work as ALREADY_DONE. It is not.\n\n` +
    `${check.evidence}.\n\n` +
    `Look again before deciding: the plan for this task named those, and they ` +
    `are not there. If you believe the work is genuinely present under other ` +
    `names, say which and where, in those words — but if it is missing, write ` +
    `it. A claim that the work exists closes this task for good and teaches the ` +
    `planner never to propose it again, so it is the one answer that cannot be ` +
    `taken back.`
  );
}
