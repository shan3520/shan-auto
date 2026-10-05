import type { TaskRow } from '../schemas.js';

/**
 * The two pure decisions behind `sa resolve` (F9), extracted so they can be
 * tested without a config, a git repo and a live gate. `src/index.ts` is the
 * glue: it loads the config, runs the gate, commits, and marks the task.
 */

/**
 * May this task be resolved by an explicit owner action?
 *
 * Returns an error message when the guard fails, null when it passes.
 *
 * `sa resolve` exists to finish a task the agent HANDED OFF. Committing a task
 * that is 'failed' or 'ready' — where the ledger's history says work was never
 * attempted or already rejected — would invent a commit for work the record
 * does not back. `--force` is the explicit override for "the ledger is wrong,
 * this IS the task, commit it anyway".
 */
export function resolveStatusError(task: TaskRow, force: boolean): string | null {
  if (force || task.status === 'handoff') return null;
  return (
    `${task.id} is '${task.status}', not 'handoff'. ` +
    `\`sa resolve\` exists to commit work the agent handed to you; use ` +
    `\`sa resolve ${task.id} --force\` if you really want to commit this task anyway.`
  );
}

export interface CommitFileChoice {
  /** The pathspec to commit. Empty when `refused` is set. */
  files: string[];
  /** Reason nothing may be committed (the intersection was empty). Null otherwise. */
  refused: string | null;
}

/**
 * Commit exactly the files this task was about, not whatever else happens to be
 * in the tree.
 *
 * The gate sees the whole diff — it must, it is the honest measurement of what
 * changed — but the commit's pathspec is the intersection with files_hint.
 * `--force` keeps the old whole-tree behaviour for the owner who knows better.
 */
export function resolveCommitFiles(
  gateFiles: string[],
  filesHintJson: string,
  force: boolean,
): CommitFileChoice {
  if (force) return { files: [...gateFiles], refused: null };

  let hint: string[] = [];
  try {
    hint = JSON.parse(filesHintJson) as string[];
  } catch {
    hint = [];
  }
  const allowed = new Set(hint.map((h) => h.replace(/\\/g, '/')));
  const files = gateFiles.filter((f) => allowed.has(f.replace(/\\/g, '/')));
  if (files.length === 0) {
    return {
      files: [],
      refused:
        `the change that passes the gate is none of this task's files. ` +
        `Hinted: ${hint.length ? hint.join(', ') : '(none)'}; gate saw: ${gateFiles.join(', ')}. ` +
        `Either the wrong work landed, or you mean \`--force\` to commit it as-is. ` +
        `Nothing was committed.`,
    };
  }
  return { files, refused: null };
}
