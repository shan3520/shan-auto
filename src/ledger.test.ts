import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import { CSV_HEADER, serializeLedgerToCsv, type TaskRowToCsv, closeForTest, insertTasks, retryTask, getTask, open, reopenUnrelatedFailures } from './ledger.js';
import type { NormalizedTask } from './schemas.js';

test('serializeLedgerToCsv combines header and rows correctly', () => {
  const rows: TaskRowToCsv[] = [
    {
      id: 'T1',
      milestone_id: 'M1',
      repo: 'repo1',
      title: 'Title 1',
      kind: 'feature',
      instruction: 'Do this',
      acceptance: 'Done',
      files_hint: '[]',
      verify_cmd: 'npm test',
      depends_on: '[]',
      est_lines: 10,
      executor_hint: 'cli',
      breaking: null,
      status: 'pending',
      attempts: 0,
      last_error: null,
      commit_sha: null,
      brief: null,
      ord: 1,
      created_at: '2023-01-01',
      updated_at: '2023-01-01'
    },
    {
      id: 'T2',
      milestone_id: null,
      repo: 'repo1',
      title: 'Title, with comma',
      kind: 'bugfix',
      instruction: 'Fix "bug"',
      acceptance: 'Fixed\nYes',
      files_hint: '[]',
      verify_cmd: 'npm test',
      depends_on: '[]',
      est_lines: 5,
      executor_hint: 'cli',
      breaking: null,
      status: 'ready',
      attempts: 1,
      last_error: 'Error',
      commit_sha: 'sha1',
      brief: null,
      ord: 2,
      created_at: '2023-01-02',
      updated_at: '2023-01-02'
    }
  ];

  const csv = serializeLedgerToCsv(rows);
  
  const expectedHeader = CSV_HEADER.join(',');
  const expectedRow1 = 'T1,M1,repo1,Title 1,feature,Do this,Done,[],npm test,[],10,cli,,pending,0,,,1,2023-01-01,2023-01-01';
  const expectedRow2 = 'T2,,repo1,"Title, with comma",bugfix,"Fix ""bug""","Fixed\nYes",[],npm test,[],5,cli,,ready,1,Error,sha1,2,2023-01-02,2023-01-02';
  
  expect(csv).toBe(`${expectedHeader}\n${expectedRow1}\n${expectedRow2}`);
});

test('serializeLedgerToCsv carries a declared contract change into the export', () => {
  const what = 'callers that index the response break';
  const rows: TaskRowToCsv[] = [
    {
      id: 'T1', milestone_id: 'M1', repo: 'repo1', title: 'Envelope', kind: 'feature',
      instruction: 'Do this', acceptance: 'Done', files_hint: '[]', verify_cmd: 'npm test',
      depends_on: '[]', est_lines: 10, executor_hint: 'cli', breaking: what,
      status: 'committed', attempts: 1, last_error: null, commit_sha: 'sha1', brief: null,
      ord: 1, created_at: '2023-01-01', updated_at: '2023-01-01',
    },
  ];

  const [, row] = serializeLedgerToCsv(rows).split('\n');

  expect(row).toContain(what);
  // In its own column, not appended to the title or the instruction: the export
  // is read by splitting on commas and this sentence has none.
  expect(row!.split(',')[12]).toBe(what);
});

describe('retryTask (resetTaskStatus logic)', () => {
  beforeEach(() => {
    process.env.SHANAUTO_DB = ':memory:';
  });

  afterEach(() => {
    closeForTest();
  });

  test('resets a failed task to ready when it has no dependencies', () => {
    const tasks: NormalizedTask[] = [{
      title: 'Task 1',
      kind: 'feature',
      instruction: 'Do it',
      acceptance: 'Done',
      files_hint: [],
      verify_cmd: 'npm test',
      depends_on: [],
      est_lines: 10,
      executor_hint: 'cli'
    }];
    const [id] = insertTasks(null, 'repo1', tasks);
    if (!id) throw new Error('Expected task ID');
    
    // manually fail it, set attempts and last error
    open().prepare("UPDATE tasks SET status='failed', attempts=3, last_error='boom' WHERE id=?").run(id);

    const before = getTask(id);
    expect(before?.status).toBe('failed');
    expect(before?.attempts).toBe(3);
    expect(before?.last_error).toBe('boom');

    const result = retryTask(id);
    expect(result).toBe(true);

    const after = getTask(id);
    expect(after?.status).toBe('ready'); // ready because no deps
    expect(after?.attempts).toBe(0);
    expect(after?.last_error).toBeNull();
  });

  test('resets a failed task to pending if dependencies are not met', () => {
    const tasks: NormalizedTask[] = [
      {
        title: 'Dep',
        kind: 'feature',
        instruction: 'Dep',
        acceptance: 'Done',
        files_hint: [],
        verify_cmd: 'npm test',
        depends_on: [],
        est_lines: 10,
        executor_hint: 'cli'
      },
      {
        title: 'Task',
        kind: 'feature',
        instruction: 'Task',
        acceptance: 'Done',
        files_hint: [],
        verify_cmd: 'npm test',
        depends_on: [0], // depends on first task
        est_lines: 10,
        executor_hint: 'cli'
      }
    ];
    const ids = insertTasks(null, 'repo1', tasks);
    const id = ids[1];
    if (!id) throw new Error('Expected task ID');
    
    open().prepare("UPDATE tasks SET status='failed', attempts=2, last_error='err' WHERE id=?").run(id);

    const result = retryTask(id);
    expect(result).toBe(true);

    const after = getTask(id);
    expect(after?.status).toBe('pending'); // because dep is not committed
    expect(after?.attempts).toBe(0);
    expect(after?.last_error).toBeNull();
  });

  test('ignores non-failed/blocked tasks', () => {
    const tasks: NormalizedTask[] = [{
      title: 'Task 1',
      kind: 'feature',
      instruction: 'Do it',
      acceptance: 'Done',
      files_hint: [],
      verify_cmd: 'npm test',
      depends_on: [],
      est_lines: 10,
      executor_hint: 'cli'
    }];
    const [id] = insertTasks(null, 'repo1', tasks);
    if (!id) throw new Error('Expected task ID');
    
    // status is 'ready' by default
    const result = retryTask(id);
    expect(result).toBe(false);

    const after = getTask(id);
    expect(after?.status).toBe('ready'); // Unchanged
  });
});

/*
 * A task the gate PROVED innocent must not stay dead once the repo is fixed.
 *
 * Run 5 on 2026-08-20: the repair landed, the held work resumed and committed,
 * and the one task reverted as VERIFY_UNRELATED stayed failed. Nothing retries a
 * failed task except an operator typing `sa retry --failed`, and the operator
 * drives a TUI.
 */
describe('reopenUnrelatedFailures', () => {
  beforeEach(() => {
    process.env.SHANAUTO_DB = ':memory:';
  });

  afterEach(() => {
    closeForTest();
  });

  const task = (title: string): NormalizedTask => ({
    title,
    kind: 'feature',
    instruction: 'Do it',
    acceptance: 'Done',
    files_hint: [],
    verify_cmd: 'npm test',
    depends_on: [],
    est_lines: 10,
    executor_hint: 'cli',
  });

  const fail = (id: string, err: string) =>
    open()
      .prepare("UPDATE tasks SET status='failed', attempts=1, last_error=? WHERE id=?")
      .run(err, id);

  test('revives a task reverted for somebody else failing test', () => {
    const [id] = insertTasks(null, 'repo1', [task('Innocent')]);
    if (!id) throw new Error('no id');
    fail(id, 'VERIFY_UNRELATED: the project own check was ALREADY failing');

    expect(reopenUnrelatedFailures('repo1')).toEqual([id]);
    expect(getTask(id)?.status).toBe('ready');
  });

  test('leaves a task that actually broke something alone', () => {
    const [id] = insertTasks(null, 'repo1', [task('Guilty')]);
    if (!id) throw new Error('no id');
    fail(id, 'VERIFY_FAIL: 3 tests failed');

    expect(reopenUnrelatedFailures('repo1')).toEqual([]);
    expect(getTask(id)?.status).toBe('failed');
  });

  test('does not reach into another repo', () => {
    const [mine] = insertTasks(null, 'repo1', [task('Mine')]);
    const [theirs] = insertTasks(null, 'repo2', [task('Theirs')]);
    if (!mine || !theirs) throw new Error('no id');
    fail(mine, 'VERIFY_UNRELATED: already red');
    fail(theirs, 'VERIFY_UNRELATED: already red');

    expect(reopenUnrelatedFailures('repo1')).toEqual([mine]);
    expect(getTask(theirs)?.status).toBe('failed');
  });

  /*
   * Attempts are not reset on purpose. A second chance is a second chance; if
   * the repo goes red again the count is what stops this becoming a loop.
   */
  test('keeps the attempt count it already spent', () => {
    const [id] = insertTasks(null, 'repo1', [task('Innocent')]);
    if (!id) throw new Error('no id');
    fail(id, 'VERIFY_UNRELATED: already red');

    reopenUnrelatedFailures('repo1');
    // Both halves matter: revived, and revived WITHOUT its history wiped. The
    // attempts assertion alone passes even when nothing is revived at all.
    expect(getTask(id)?.status).toBe('ready');
    expect(getTask(id)?.attempts).toBe(1);
  });
});
