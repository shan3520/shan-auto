import { describe, it, expect } from 'vitest';
import { resolveStatusError, resolveCommitFiles } from '../resolve.js';
import type { TaskRow } from '../../schemas.js';

/**
 * F9 regression: `sa resolve` must refuse to commit a task the ledger does not
 * back, and must commit exactly the files the task was about — not whatever
 * else happens to be in the tree.
 *
 * These are the two pure decisions, extracted from index.ts so they can be
 * tested without a config, a git repo and a live gate run. The index.ts glue
 * (load config -> gate -> commit -> markCommitted) is exercised as a subprocess
 * in the Part 3 CLI tests.
 */

const task = (over: Partial<TaskRow> = {}): TaskRow =>
  ({ id: 'T1', status: 'handoff', files_hint: '["src/a.ts"]', ...over } as TaskRow);

describe('resolveStatusError — the handoff guard', () => {
  it('allows a handoff task without --force', () => {
    expect(resolveStatusError(task(), false)).toBeNull();
  });

  it('rejects a non-handoff task without --force, naming the task and its state', () => {
    const err = resolveStatusError(task({ id: 'R7', status: 'ready' }), false);
    expect(err).toContain("R7 is 'ready', not 'handoff'");
    expect(err).toContain('--force');
  });

  it('rejects failed tasks too — the ledger says the work was rejected', () => {
    expect(resolveStatusError(task({ status: 'failed' }), false)).toMatch(/not 'handoff'/);
    expect(resolveStatusError(task({ status: 'blocked' }), false)).toMatch(/not 'handoff'/);
  });

  it('--force bypasses the status guard for any state', () => {
    expect(resolveStatusError(task({ status: 'failed' }), true)).toBeNull();
    expect(resolveStatusError(task({ status: 'ready' }), true)).toBeNull();
  });
});

describe('resolveCommitFiles — the files_hint intersection', () => {
  const gateFiles = ['src/a.ts', 'src/b.ts', 'docs/unrelated.md'];

  it('commits only the files that are both changed and hinted', () => {
    const { files, refused } = resolveCommitFiles(gateFiles, '["src/a.ts","src/b.ts"]', false);
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(refused).toBeNull();
  });

  it('matches a backslash gate path against a forward-slash hint', () => {
    // diffStat hands back git's forward-slash paths in practice; the
    // backslash normalisation is the defensive Windows path. The hint must
    // still match, and the path is returned as the gate reported it.
    expect(resolveCommitFiles(['src\\a.ts', 'src/b.ts'], '["src/a.ts"]', false).files).toEqual([
      'src\\a.ts',
    ]);
  });

  it('refuses when no changed file is in the hint, and says what went wrong', () => {
    const { files, refused } = resolveCommitFiles(gateFiles, '["src/other.ts"]', false);
    expect(files).toEqual([]);
    expect(refused).toMatch(/none of this task's files/);
    expect(refused).toContain('src/other.ts');
    expect(refused).toMatch(/--force/);
  });

  it('treats a malformed hint as empty — nothing matches, nothing commits', () => {
    const { files, refused } = resolveCommitFiles(gateFiles, 'not json', false);
    expect(files).toEqual([]);
    expect(refused).toMatch(/\(none\)/);
  });

  it('--force commits the whole verified diff regardless of the hint', () => {
    const { files, refused } = resolveCommitFiles(gateFiles, '["src/a.ts"]', true);
    expect(files).toEqual(gateFiles);
    expect(refused).toBeNull();
  });
});
