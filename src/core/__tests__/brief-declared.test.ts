import { describe, it, expect, vi } from 'vitest';
import type { AppConfig } from '../../config.js';
import type { BrainDriver } from '../../drivers/contracts.js';
import type { Repo, TaskRow } from '../../schemas.js';

/*
 * O21, at the call site.
 *
 * `briefIssues` is covered on its own in brief.test.ts, and every one of those
 * tests passed while `authorBrief` handed it an empty declaration — the rule
 * proven, the caller not. That is the fifth time this shape has appeared in
 * this project, so it gets its own file.
 *
 * What has to be true: the list the PLANNER wrote (`task.files_hint`) reaches
 * the check that compares it against what the SENIOR wrote.
 */

vi.mock('../../git.js', () => ({
  fileTree: async () => 'src/summary.ts\nsrc/summary.test.ts',
}));

/*
 * Kept small deliberately. The real symbol index of this repo runs to tens of
 * thousands of characters, which pushes `fitPrompt` into trimming — and BODIES
 * is one of the sections it trims. That is correct under a real budget and it
 * is not the question these tests are asking.
 */
vi.mock('../context.js', async (orig) => ({
  ...(await orig<typeof import('../context.js')>()),
  apiSurface: async () => 'src/summary.ts: summarise',
}));

/*
 * A stand-in template that renders the sections, and a REAL `fill`. Stubbing
 * fill to the identity made the prompt a constant string, which is fine for the
 * `accept` tests below and useless for asking what the prompt CONTAINS — the
 * question O23 is about.
 */
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  prompt: () =>
    ['TREE:', '{{TREE}}', 'SYMBOLS:', '{{SYMBOLS}}', 'BODIES:', '{{BODIES}}', 'TASK:', '{{TASK}}'].join(
      '\n',
    ),
  fill: (tpl: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), tpl),
}));

const { authorBrief } = await import('../brief.js');

const cfg = {
  system: { limits: { max_files_per_task: 8 } },
} as unknown as AppConfig;

const repo = { id: 'r1', path: 'D:/nowhere', stack: 'python', branch: 'main' } as Repo;

const task = (filesHint: string[]): TaskRow =>
  ({
    id: 'T1',
    title: 'Add a complaint counter',
    kind: 'feature',
    instruction: 'count them',
    acceptance: 'they are counted',
    files_hint: JSON.stringify(filesHint),
  }) as TaskRow;

/** A brain that records the prompt it was handed. */
const brainSeeing = (brief: unknown, seen: { prompt?: string }): BrainDriver =>
  ({
    id: 'stub',
    init: async () => undefined,
    dispose: async () => undefined,
    ask: async (prompt: string) => {
      seen.prompt = prompt;
      return brief;
    },
  }) as unknown as BrainDriver;

/** A brain that returns the given brief and reports what `accept` said of it. */
const brainReturning = (brief: unknown, seen: { objection?: string | null }): BrainDriver =>
  ({
    id: 'stub',
    init: async () => undefined,
    dispose: async () => undefined,
    ask: async (
      _prompt: string,
      _schema: unknown,
      _label: string,
      accept?: (d: unknown) => string | null,
    ) => {
      seen.objection = accept?.(brief) ?? null;
      return brief;
    },
  }) as unknown as BrainDriver;

const draft = (testPath: string) => ({
  objective: 'Add a complaint counter to the feedback summary',
  rationale: 'The weekly report shows totals with no breakdown',
  reuse: [],
  implementation: [{ path: 'src/summary.ts', action: 'modify', steps: ['count complaints'] }],
  tests: [{ path: testPath, must_prove: 'fails if praise is counted as a complaint' }],
  constraints: [],
  acceptance: 'the summary reports complaints separately',
});

describe('the plan\'s file list reaches the check on the senior\'s brief', () => {
  it('objects when the brief plans a test file the plan never declared', async () => {
    const seen: { objection?: string | null } = {};
    await authorBrief(
      cfg,
      brainReturning(draft('src/elsewhere.test.ts'), seen),
      repo,
      task(['src/summary.ts', 'src/summary.test.ts']),
    );

    expect(seen.objection).toBeTruthy();
    expect(seen.objection).toContain('src/elsewhere.test.ts');
  });

  it('says nothing when the brief stays inside what the plan declared', async () => {
    const seen: { objection?: string | null } = {};
    await authorBrief(
      cfg,
      brainReturning(draft('src/summary.test.ts'), seen),
      repo,
      task(['src/summary.ts', 'src/summary.test.ts']),
    );

    expect(seen.objection).toBeNull();
  });

  it('survives a plan whose file list is not readable', async () => {
    /*
     * `files_hint` is text in a database column and `authorBrief` already
     * tolerates it being unparseable. It must not start throwing here, and it
     * must not silently accept every test file either — with nothing declared,
     * a brief that names one is exactly the trap this catches.
     */
    const seen: { objection?: string | null } = {};
    const broken = { ...task([]), files_hint: 'not json' } as TaskRow;

    await expect(
      authorBrief(cfg, brainReturning(draft('src/x.test.ts'), seen), repo, broken),
    ).resolves.toBeTruthy();
    expect(seen.objection).toContain('none were declared');
  });
});


/*
 * O23, at the call site. `hintedBodies` is covered on its own in
 * brief-bodies.test.ts, and emptying the section in `authorBrief` left all
 * seven of those green — the reader proven, the caller not.
 */
describe('the brief author is shown the code it is planning against', () => {
  it('puts the hinted files into the prompt it actually sends', async () => {
    const seen: { prompt?: string } = {};
    await authorBrief(
      cfg,
      brainSeeing(draft('src/summary.test.ts'), seen),
      { ...repo, path: process.cwd() } as Repo,
      task(['package.json']),
    );

    // Read off disk, so this is the file's real content and not a name.
    expect(seen.prompt).toContain('package.json');
    expect(seen.prompt).toContain('"shanauto"');
  });

  it('tells it plainly when a hinted file is not there yet', async () => {
    const seen: { prompt?: string } = {};
    await authorBrief(
      cfg,
      brainSeeing(draft('src/summary.test.ts'), seen),
      { ...repo, path: process.cwd() } as Repo,
      task(['does/not/exist.ts']),
    );

    expect(seen.prompt).toContain('does not exist yet');
  });
});
