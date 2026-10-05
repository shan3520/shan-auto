import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DOUBT, dropTasksPlanningAgainstNothing } from '../planner.js';
import type { BrainDriver } from '../../drivers/contracts.js';
import type { NormalizedTask, Repo } from '../../schemas.js';

/*
 * O23's other half — the PLANNER decided about code it had never read.
 *
 * The brief author reads the files it plans against now. The decomposer that
 * wrote the plan still worked from a file tree and a list of names, and a name
 * proves a thing exists and nothing else. Run 21: a job said "remove the
 * iterative fetch" from a one-line function containing no loop; the brief
 * hardened that into its objective; the junior, which cannot decline without
 * losing its attempt, made the sentence true by hanging a value nothing reads.
 * Committed, and reviewed "ship".
 *
 * The issue recorded this as blocked on prompt budget — the whole repo will not
 * fit beside a decompose prompt. It does not have to: by this point the plan has
 * NAMED its files, so the question is a second, small pass over one to four.
 *
 * The guards below matter as much as the check. Earlier the same day, the
 * acceptance check made this exact mistake inside its own fix — judged from
 * titles, and reopened two finished milestones. What keeps this one honest is
 * that it sees the code and leans towards keeping.
 */

let dir: string;

const task = (over: Partial<NormalizedTask> = {}): NormalizedTask =>
  ({
    title: 'Remove the iterative fetch from top_documents',
    instruction: 'It loops over every document; slice the cache instead.',
    files_hint: ['stats.py'],
    ...over,
  }) as NormalizedTask;

const repo = () => ({ id: 'r1', path: dir }) as Repo;

const file = (rel: string, body: string) => {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
};

/** A brain that answers with the given verdict and records what it was shown. */
const brainSaying = (answer: unknown, seen: { prompt?: string } = {}): BrainDriver =>
  ({
    id: 'stub',
    ask: async (
      prompt: string,
      _schema: unknown,
      _label: string,
      accept?: (d: unknown) => string | null,
    ) => {
      seen.prompt = prompt;
      const objection = accept?.(answer);
      if (objection) throw new Error(objection);
      return answer;
    },
  }) as unknown as BrainDriver;

const ms = { title: 'Rank the attention list', detail: 'ranking' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-plancheck-'));
  file('stats.py', 'def top_documents(n):\n    return _cache[:n]\n');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('dropping jobs that plan against code which is not there', () => {
  it('drops one whose premise the code contradicts, and records why', async () => {
    const rejected: string[] = [];
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({
        drop: [{ index: 0, why: 'top_documents has no loop; it slices a cached list' }],
      }),
      repo(),
      ms,
      [task(), task({ title: 'Add a --json flag', files_hint: ['stats.py'] })],
      rejected,
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Add a --json flag');
    expect(rejected.join(' ')).toContain('has no loop');
  });

  it('keeps everything when the checker finds nothing wrong', async () => {
    const rejected: string[] = [];
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({ drop: [] }),
      repo(),
      ms,
      [task(), task({ title: 'Second' })],
      rejected,
    );

    expect(out).toHaveLength(2);
    expect(rejected).toEqual([]);
  });

  it('shows it the CODE, which is the whole reason this pass exists', async () => {
    const seen: { prompt?: string } = {};
    await dropTasksPlanningAgainstNothing(brainSaying({ drop: [] }, seen), repo(), ms, [task()], []);

    expect(seen.prompt).toContain('return _cache[:n]');
    expect(seen.prompt).toContain('Remove the iterative fetch');
  });

  /*
   * The guards. A wrong drop throws away work the operator asked for, and the
   * gate is still downstream of a wrong keep.
   */
  it('refuses to empty a plan wholesale, and keeps it instead', async () => {
    // Four separate fictions is far less likely than one misread file, and the
    // cost of being wrong that way is the entire milestone.
    const rejected: string[] = [];
    const tasks = [task(), task({ title: 'B' }), task({ title: 'C' })];
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({ drop: [0, 1, 2].map((index) => ({ index, why: 'no' })) }),
      repo(),
      ms,
      tasks,
      rejected,
    );

    expect(out).toHaveLength(3);
  });

  /*
   * Found on the first live run. A single-task milestone had its premise
   * correctly disputed and was kept in full, because dropping it would have
   * emptied the plan — and "four fictions are less likely than one misread" is
   * hollow at one task, where the two are equally likely. Run 21, the case this
   * check exists for, was a single task.
   *
   * So the doubt travels with the work rather than being discarded with it.
   */
  it('attaches the doubt to a lone task it cannot drop', async () => {
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({
        drop: [{ index: 0, why: 'the chunks relationship already has that cascade' }],
      }),
      repo(),
      ms,
      [task()],
      [],
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.instruction).toContain('already has that cascade');
    expect(out[0]!.instruction).toContain(DOUBT.slice(0, 30));
    // The plan it disputes is still there to be disputed.
    expect(out[0]!.instruction).toContain('slice the cache instead');
  });

  it('leaves a task it did not dispute exactly as it was', async () => {
    const plain = task({ title: 'B', instruction: 'add a flag' });
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({
        drop: [
          { index: 0, why: 'no loop here' },
          { index: 1, why: 'also nothing' },
        ],
      }),
      repo(),
      ms,
      [task(), plain],
      [],
    );

    // Both kept (dropping all would empty it), and both carry their own reason.
    expect(out[1]!.instruction).toContain('also nothing');
    expect(out[1]!.instruction).toContain('add a flag');
  });

  it('keeps everything when the checker cannot be reached', async () => {
    const broken = {
      id: 'stub',
      ask: async () => {
        throw new Error('provider down');
      },
    } as unknown as BrainDriver;

    const out = await dropTasksPlanningAgainstNothing(broken, repo(), ms, [task()], []);
    expect(out).toHaveLength(1);
  });

  it('keeps everything when there is no code to read', async () => {
    // Nothing readable is not a verdict. A plan against files that do not exist
    // yet is the ordinary greenfield case, not a fiction.
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({ drop: [{ index: 0, why: 'nope' }] }),
      { id: 'r1', path: join(tmpdir(), 'sa-plancheck-empty') } as Repo,
      ms,
      [task({ files_hint: [] })],
      [],
    );

    expect(out).toHaveLength(1);
  });

  it('ignores an index that is not a job', async () => {
    // The answer is model output and its indices are data.
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({ drop: [{ index: 9, why: 'out of range' }] }),
      repo(),
      ms,
      [task()],
      [],
    );

    expect(out).toHaveLength(1);
  });

  it('refuses a drop that explains nothing', async () => {
    /*
     * An unexplained drop removes work the operator asked for and records no
     * reason anyone could argue with. The objection goes back for repair, and
     * the stub turns that into a throw — which keeps every task, as it should.
     */
    const out = await dropTasksPlanningAgainstNothing(
      brainSaying({ drop: [{ index: 0, why: '   ' }] }),
      repo(),
      ms,
      [task()],
      [],
    );

    expect(out).toHaveLength(1);
  });

  it('does nothing at all when there are no jobs', async () => {
    const seen: { prompt?: string } = {};
    const out = await dropTasksPlanningAgainstNothing(brainSaying({ drop: [] }, seen), repo(), ms, [], []);

    expect(out).toEqual([]);
    // And spends no model call on the question.
    expect(seen.prompt).toBeUndefined();
  });
});
