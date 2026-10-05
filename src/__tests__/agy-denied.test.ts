import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unrunCommands, deniedCommand } from '../drivers/agy-denied.js';

/**
 * Naming the command agy was refused.
 *
 * Measured 2026-08-15, run Rfbqo6lk9yj: agy's entire output on a denial was one
 * sentence containing the literal placeholder `command(<target>)`. The operator
 * was told to allow-list "the command" with no way to discover which one, and
 * the run's archived artifact held 302 bytes of the same. The real answer —
 * `alembic revision --autogenerate ...` — existed only in agy's own transcript.
 *
 * The shapes below are copied from that transcript, not invented, because the
 * whole value of this code is that it matches what agy actually writes.
 */

/** Step 23: the command agy asked for and was allowed to start. */
const ASK_PYTEST = JSON.stringify({
  step_index: 23,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  tool_calls: [
    { name: 'run_command', args: { CommandLine: 'python -m pytest -q', Cwd: 'D:\\repos\\example-api' } },
  ],
});
/** Step 24: it started. Note it never reached DONE. */
const RAN_PYTEST = JSON.stringify({ step_index: 24, type: 'RUN_COMMAND', status: 'RUNNING' });
/** Step 26: asked for, refused, no step of its own. */
const ALEMBIC = 'alembic revision --autogenerate -m "document groups" --rev-id 0003_document_groups';
const ASK_ALEMBIC = JSON.stringify({
  step_index: 26,
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  tool_calls: [{ name: 'run_command', args: { CommandLine: ALEMBIC } }],
});
const EDIT = JSON.stringify({
  step_index: 20,
  type: 'PLANNER_RESPONSE',
  tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'app/models/group.py' } }],
});

describe('unrunCommands', () => {
  it('names the command that was asked for but never ran', () => {
    expect(unrunCommands([EDIT, ASK_PYTEST, RAN_PYTEST, ASK_ALEMBIC].join('\n'))).toEqual([ALEMBIC]);
  });

  it('says nothing when every command asked for actually started', () => {
    expect(unrunCommands([ASK_PYTEST, RAN_PYTEST].join('\n'))).toEqual([]);
  });

  it('ignores tool calls that are not commands', () => {
    // A run that only edited files was not blocked on a command.
    expect(unrunCommands(EDIT)).toEqual([]);
  });

  it('ignores a non-command tool even when it carries a command line', () => {
    /*
     * Only `run_command` needs the permission that gets refused. Any other tool
     * that happens to hold a CommandLine — a search, a background-task query —
     * would otherwise be reported to the operator as the thing to allow-list,
     * sending them to add a rule that unblocks nothing.
     */
    const other = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'view_task_log', args: { CommandLine: 'python -m pytest -q' } }],
    });
    expect(unrunCommands(other)).toEqual([]);
  });

  it('survives a half-written last line', () => {
    // The transcript is read while agy may still be appending to it.
    expect(unrunCommands([ASK_ALEMBIC, '{"step_index":27,"ty'].join('\n'))).toEqual([ALEMBIC]);
  });

  it('reads past a corrupt line instead of giving up on the rest', () => {
    // One unreadable line in the middle must not hide the command that follows
    // it — that is precisely the line the operator is waiting to be told about.
    expect(unrunCommands(['{"broken": ', ASK_ALEMBIC].join('\n'))).toEqual([ALEMBIC]);
  });

  it('pairs in order, so an earlier refusal is not mistaken for the last one', () => {
    const first = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm install left-pad' } }],
    });
    // Two asked, one ran: the leftovers are reported newest last.
    expect(unrunCommands([first, ASK_ALEMBIC, RAN_PYTEST].join('\n'))).toEqual([ALEMBIC]);
  });

  it('keeps several leftovers in the order they were asked for', () => {
    // The command the agent stopped on is the LAST one, and the operator is
    // shown that one. Reading the list from the wrong end names a command the
    // agent had already moved past.
    const install = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm install left-pad' } }],
    });
    expect(unrunCommands([install, ASK_ALEMBIC].join('\n'))).toEqual(['npm install left-pad', ALEMBIC]);
  });
});

describe('deniedCommand', () => {
  let dir: string;
  const write = (conv: string, body: string, mtime: Date) => {
    const logs = join(dir, conv, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    const file = join(logs, 'transcript_full.jsonl');
    writeFileSync(file, body);
    utimesSync(file, mtime, mtime);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-brain-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the command out of the transcript of the run that just happened', () => {
    write('conv-now', [ASK_PYTEST, RAN_PYTEST, ASK_ALEMBIC].join('\n'), new Date());
    expect(deniedCommand(Date.now() - 60_000, dir)).toBe(ALEMBIC);
  });

  it('ignores an older conversation, whose command is not this run’s', () => {
    /*
     * The brain directory keeps every conversation ever held. Reporting a
     * command from last week would send the operator to allow-list something
     * that was never the blocker, while the real one stays — and they would have
     * no way to tell, because the advice looks exactly as confident either way.
     *
     * Its own directory, so the recent transcript written above cannot answer
     * for it and make this pass without the time bound doing any work.
     */
    const attic = mkdtempSync(join(tmpdir(), 'agy-attic-'));
    try {
      const old = new Date(Date.now() - 7 * 24 * 60 * 60_000);
      const logs = join(attic, 'conv-old', '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      const file = join(logs, 'transcript_full.jsonl');
      writeFileSync(file, ASK_ALEMBIC);
      utimesSync(file, old, old);

      expect(deniedCommand(Date.now() - 60_000, attic)).toBeUndefined();
      // And it is genuinely readable — the silence above is the age, nothing else.
      expect(deniedCommand(old.getTime() - 60_000, attic)).toBe(ALEMBIC);
    } finally {
      rmSync(attic, { recursive: true, force: true });
    }
  });

  it('returns nothing rather than guessing when there is no transcript at all', () => {
    expect(deniedCommand(0, join(dir, 'does-not-exist'))).toBeUndefined();
  });

  it('names the command the agent stopped on, not one it had moved past', () => {
    /*
     * An agent that was refused twice is unblocked by the LAST one; the earlier
     * refusal it already worked around. Naming that one costs the operator a
     * round trip through the whole apply-and-rerun cycle to learn nothing.
     */
    const install = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm install left-pad' } }],
    });
    const two = mkdtempSync(join(tmpdir(), 'agy-two-'));
    try {
      const logs = join(two, 'conv', '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'transcript_full.jsonl'), [install, ASK_ALEMBIC].join('\n'));
      expect(deniedCommand(Date.now() - 60_000, two)).toBe(ALEMBIC);
    } finally {
      rmSync(two, { recursive: true, force: true });
    }
  });

  it('answers from the newest conversation when several are recent', () => {
    /*
     * agy opens a fresh conversation per task, and a run can leave more than one
     * behind. The one that just failed is the newest; an older sibling's command
     * is a different task's problem.
     */
    const many = mkdtempSync(join(tmpdir(), 'agy-many-'));
    const put = (conv: string, body: string, ageMs: number) => {
      const logs = join(many, conv, '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      const file = join(logs, 'transcript_full.jsonl');
      writeFileSync(file, body);
      const when = new Date(Date.now() - ageMs);
      utimesSync(file, when, when);
    };
    try {
      const earlier = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm install left-pad' } }],
      });
      put('conv-earlier', earlier, 20_000);
      put('conv-latest', ASK_ALEMBIC, 1_000);
      expect(deniedCommand(Date.now() - 60_000, many)).toBe(ALEMBIC);
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });
});
