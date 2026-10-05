import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planNextMilestone, refillBacklog, runwayDays, fitPrompt, shapeIdea } from '../planner.js';
import * as ledger from '../../ledger.js';
import type { AppConfig } from '../../config.js';
import type { BrainDriver } from '../../drivers/contracts.js';
import { DecomposeSchema, type PlannedTask } from '../../schemas.js';
import { log } from '../../logger.js';
import { readRecent } from '../journal.js';
import { apiSurface } from '../context.js';

/*
 * Constants come from the real module, functions are stubs. A hand-declared
 * copy of a constant is a mock lying about the contract in the quietest way
 * there is: the planner would write a status no screen looks for, and this
 * file would agree with itself all the way down.
 */
vi.mock('../../ledger.js', async (importOriginal) => ({
  ALREADY_BUILT_STATUS: (await importOriginal<typeof import('../../ledger.js')>()).ALREADY_BUILT_STATUS,
  reachableBacklog: vi.fn(),
  nextUnplannedMilestone: vi.fn(),
  setMilestoneStatus: vi.fn(),
  knownWork: vi.fn(() => []),
  recentResolutions: vi.fn(() => []),
  insertTasks: vi.fn(() => ['T1']),
  saveClaim: vi.fn(),
  readyTasks: vi.fn(() => []),
  countByStatus: vi.fn(() => ({})),
  addIdea: vi.fn(() => 'I1'),
  addEpic: vi.fn(() => 'E1'),
  addMilestone: vi.fn(() => 'M1'),
  setIdeaStatus: vi.fn(),
}));

// The planner reaches into the repo to build its prompt; none of that is what
// these tests are about.
vi.mock('../../git.js', () => ({
  fileTree: vi.fn(async () => 'src/'),
  headSha: vi.fn(async () => 'abc1234'),
  // Empty is the "cannot tell" set, so the phantom-path check stays out of the
  // way of tests that are about decomposition rather than about paths.
  trackedRoots: vi.fn(async () => new Set<string>()),
}));
vi.mock('../context.js', () => ({
  apiSurface: vi.fn(async () => ''),
  findDuplicate: vi.fn(() => null),
  resolutionDigest: vi.fn(() => ''),
  // No repo on disk here, so no index: the removal check has no opinion, which
  // is what every expectation in this file was written against.
  repoSymbols: vi.fn(() => null),
  // The plan check reads the files the plan named (O23). Non-empty, or the
  // check declines to judge and this file's call-site tests prove nothing.
  hintedBodies: vi.fn(async () => ['--- src/health.ts', 'export function health() {}'].join('\n')),
}));
vi.mock('../journal.js', () => ({ readRecent: vi.fn(() => '') }));

const cfg = {
  system: {
    daily_target: 5,
    limits: { max_files_per_task: 4, min_insertions: 10 },
    backlog: { tasks_per_milestone: [3, 8] },
  },
  repos: [{ id: 'r1', path: 'D:/repo', stack: 'ts', verify_cmd: 'npm test' }],
} as unknown as AppConfig;

/*
 * Honours the real contract, which is the subject of these tests: askWithRepair
 * offers every schema-valid draft to `accept` and returns only one the caller
 * took, throwing once the models are exhausted. A mock that ignored `accept`
 * would quietly hand the planner a proposal its own guards never judged - and
 * would have gone on passing after the guards stopped running at all.
 */
const brainReturning = (
  tasks: Partial<PlannedTask>[],
  nothingToDo?: string,
  /**
   * What the plan check says, when it is asked (O23).
   *
   * Answered by label, because this fixture used to hand every call a
   * decompose-shaped draft whatever was asked. The plan check then read a
   * `drop` that was not there, threw, and was swallowed by its own never-throw
   * guard — so it silently did nothing, and deleting its call site left every
   * test in this file green.
   */
  planCheck: { drop: { index: number; why: string }[] } = { drop: [] },
): BrainDriver =>
  ({
    ask: vi.fn(
      async (
        _text: string,
        _schema: unknown,
        label: string,
        accept?: (draft: { tasks: Partial<PlannedTask>[]; nothing_to_do?: string }) => string | null,
      ) => {
        if (label === 'plancheck') {
          const objection = (accept as unknown as ((d: unknown) => string | null) | undefined)?.(
            planCheck,
          );
          if (objection) throw new Error(objection);
          return planCheck;
        }
        const draft: { tasks: Partial<PlannedTask>[]; nothing_to_do?: string } = { tasks };
        if (nothingToDo !== undefined) draft.nothing_to_do = nothingToDo;
        /*
         * The real loop never offers `accept` a draft the schema already
         * refused. Skipping this let a test assert planner behaviour for
         * `{tasks: []}` with no reason - a shape zod rejects - so a branch that
         * production could never reach looked covered for weeks.
         */
        const parsed = DecomposeSchema.safeParse(draft);
        if (!parsed.success)
          throw new Error(
            `Brain failed for "${label}" after all retries. Last error: ` +
              parsed.error.issues.map((i) => i.message).join('; '),
          );
        const objection = accept?.(draft) ?? null;
        if (objection) throw new Error(`Brain failed for "${label}" after all retries. Last error: ${objection}`);
        return draft;
      },
    ),
  }) as unknown as BrainDriver;

const proposal = (over: Partial<PlannedTask> = {}): Partial<PlannedTask> => ({
  title: 'Add health endpoint',
  kind: 'feature',
  instruction: 'add the handler in src/health.ts',
  acceptance: 'it responds',
  files_hint: ['src/health.ts'],
  verify_cmd: 'npm test',
  depends_on: [],
  est_lines: 20,
  executor_hint: 'cli',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ledger.nextUnplannedMilestone).mockReturnValue({
    id: 'M1',
    title: 'Relocate health module',
    detail: 'move it to app/core',
    repo: 'r1',
  });
  vi.mocked(ledger.knownWork).mockReturnValue([]);
  vi.mocked(ledger.recentResolutions).mockReturnValue([]);
});

/**
 * On 2026-08-08 "Relocate health module" was marked `satisfied` after the
 * duplicate check wrongly ate its only proposal. Satisfied milestones are never
 * revisited, so the work vanished and had to be recovered by hand. "Everything I
 * proposed was rejected" and "there is nothing left to do" are opposite
 * conclusions and must not share a status.
 */
describe('a milestone whose every proposal was rejected', () => {
  it('is not recorded as satisfied', async () => {
    const brain = brainReturning([proposal({ title: 'Relocate health module to app/core' })]);
    const n = await planNextMilestone(cfg, brain);

    expect(n).toBe(0);
    const [, status] = vi.mocked(ledger.setMilestoneStatus).mock.calls[0]!;
    expect(status).not.toBe('satisfied');
    expect(status).toBe('rejected');
  });

  it('keeps the reason each proposal was rejected, on the milestone', async () => {
    // A move task that never asserts the old path is gone: the real rejection
    // that emptied this milestone.
    const brain = brainReturning([proposal({ title: 'Relocate health module to app/core' })]);
    await planNextMilestone(cfg, brain);

    const [, , why] = vi.mocked(ledger.setMilestoneStatus).mock.calls[0]!;
    expect(why).toContain('Relocate health module to app/core');
    expect(why).toMatch(/verify_cmd/);
  });

  it('is distinguishable from a milestone the brain says is already built', async () => {
    await planNextMilestone(cfg, brainReturning([], 'HealthRouter already serves this'));
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![1]).toBe('nothing-to-do');
  });

  it('queues nothing, so the reason is the only record there is', async () => {
    await planNextMilestone(cfg, brainReturning([proposal({ title: 'Define HealthConfig type', est_lines: 6 })]));
    expect(ledger.insertTasks).not.toHaveBeenCalled();
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![2]).toContain('declaration-only');
  });

  it('still plans normally when one proposal survives', async () => {
    const brain = brainReturning([proposal(), proposal({ title: 'Define HealthConfig type', est_lines: 6 })]);
    expect(await planNextMilestone(cfg, brain)).toBe(1);
    expect(ledger.setMilestoneStatus).toHaveBeenCalledWith('M1', 'planned');
  });
});

/**
 * Flooring made any backlog below one day's target read "~0 day(s)": it showed 0
 * all night on 2026-08-08 with 16 tasks queued and working, so the figure was
 * read as noise. Zero must mean there is nothing left to run, and nothing else.
 */
/**
 * On 2026-08-18 both models opened with `{"tasks":[]}` for a milestone that was
 * already built - the answer decompose.md asks for - and `.min(1)` called it
 * malformed. The repair loop then drove them into fabricating a placeholder
 * task, which the merits gate rejected. Six model calls, ~140s, nothing
 * planned, because the schema forbade the answer the prompt requested.
 */
describe('a milestone the brain says is already built', () => {
  const built = (reason = 'Document.chunks in app/models already implements this') =>
    brainReturning([], reason);

  it('is taken as an answer, not repaired into a fabricated task', async () => {
    const brain = built();
    expect(await planNextMilestone(cfg, brain)).toBe(0);
    // One call: no repair round, no fallback model. The answer was complete.
    expect(vi.mocked(brain.ask)).toHaveBeenCalledTimes(1);
    expect(ledger.insertTasks).not.toHaveBeenCalled();
  });

  it('records the reasoning, which is the only evidence the operator gets', async () => {
    await planNextMilestone(cfg, built('ChunkingService.split() already covers every part'));
    const [, , why] = vi.mocked(ledger.setMilestoneStatus).mock.calls[0]!;
    expect(why).toContain('ChunkingService.split() already covers every part');
  });

  it('is not marked failed, because nothing failed', async () => {
    await planNextMilestone(cfg, built());
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![1]).not.toBe('failed');
  });

  /*
   * The hazard this whole status exists to avoid. `satisfied` is terminal, so
   * accepting a model's word for it would let one call close real work with no
   * way back - exactly how "Relocate health module" was lost on 2026-08-08.
   */
  it('is not marked satisfied, because a model saying so does not make it true', async () => {
    await planNextMilestone(cfg, built());
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![1]).not.toBe('satisfied');
  });

  it('lands on a status the operator can see and undo', async () => {
    await planNextMilestone(cfg, built());
    const [id, status] = vi.mocked(ledger.setMilestoneStatus).mock.calls[0]!;
    expect(id).toBe('M1');
    // Not live, so stuckMilestones lists it and `sa retry` can requeue it -
    // without either query being taught this status name.
    expect(['unplanned', 'planned']).not.toContain(status);
    expect(status).toBe('nothing-to-do');
  });

  it('tells the operator both ways out', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await planNextMilestone(cfg, built());
    const said = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(said).toMatch(/already built/);
    expect(said).toMatch(/sa -- retry M1/);
    warn.mockRestore();
  });

  /*
   * Asserting on the number of `ask` calls cannot see this: the mock collapses
   * the repair loop into one call, so an objection and an acceptance look
   * identical from outside, and both end at the same milestone status. What
   * separates them is what the gate returned - null takes the answer, anything
   * else spends a repair round and then the fallback model re-asking a question
   * that has already been answered.
   */
  it('takes the answer at the gate instead of sending it back for repair', async () => {
    let objection: string | null | undefined;
    const brain = {
      ask: vi.fn(
        async (
          _text: string,
          _schema: unknown,
          _label: string,
          accept?: (d: { tasks: Partial<PlannedTask>[]; nothing_to_do?: string }) => string | null,
        ) => {
          const draft = { tasks: [], nothing_to_do: 'Document.chunks already implements this' };
          objection = accept?.(draft) ?? null;
          return draft;
        },
      ),
    } as unknown as BrainDriver;

    await planNextMilestone(cfg, brain);
    expect(objection).toBeNull();
  });

  it('is refused by the schema when the brain gives no reason for the emptiness', async () => {
    // "Already built" and "I would rather not" must not share an answer shape.
    const parsed = DecomposeSchema.safeParse({ tasks: [] });
    expect(parsed.success).toBe(false);
  });

  it('sends the model the way out, not just the complaint', async () => {
    const parsed = DecomposeSchema.safeParse({ tasks: [] });
    // This message is what the repair prompt shows the model as REASON.
    const msg = parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' ');
    expect(msg).toContain('nothing_to_do');
  });

  it('does not treat whitespace as a reason', async () => {
    expect(DecomposeSchema.safeParse({ tasks: [], nothing_to_do: '   ' }).success).toBe(false);
  });

  /*
   * The verdict must come from this milestone's answer only. If `nothingToDo`
   * survived a run in which the brain was exhausted, a milestone whose
   * proposals were all rejected would be filed as already built.
   */
  it('does not file an exhausted brain as already built', async () => {
    const brain = brainReturning([proposal({ title: 'Relocate health module to app/core' })]);
    await planNextMilestone(cfg, brain);
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![1]).toBe('rejected');
  });
});

describe('runwayDays', () => {
  const at = (target: number) => ({ system: { daily_target: target } }) as AppConfig;

  it('reports a fraction of a day rather than zero when work is queued', () => {
    vi.mocked(ledger.reachableBacklog).mockReturnValue(16);
    expect(runwayDays(at(20))).toBe(0.8);
  });

  it('never rounds a non-empty backlog down to the empty answer', () => {
    vi.mocked(ledger.reachableBacklog).mockReturnValue(1);
    expect(runwayDays(at(400))).toBe(0.1);
  });

  it('returns zero only when no reachable work is left', () => {
    vi.mocked(ledger.reachableBacklog).mockReturnValue(0);
    expect(runwayDays(at(5))).toBe(0);
  });

  it('reports whole days to a tenth', () => {
    vi.mocked(ledger.reachableBacklog).mockReturnValue(10);
    expect(runwayDays(at(3))).toBe(3.3);
    vi.mocked(ledger.reachableBacklog).mockReturnValue(15);
    expect(runwayDays(at(5))).toBe(3);
  });

  it('treats a zero or negative daily target as one, rather than dividing by it', () => {
    vi.mocked(ledger.reachableBacklog).mockReturnValue(5);
    expect(runwayDays(at(0))).toBe(5);
    expect(runwayDays(at(-2))).toBe(5);
  });
});

/**
 * The guards are wired into the real planning path, not just exported.
 *
 * Written after a mutation that reverted `validateTasks(cfg, tasks, rejected,
 * roots, repo)` to the four-argument call survived the whole suite. Unit tests
 * on the guard functions all passed, because they call validateTasks directly —
 * so wrongToolForStack could have been silently disconnected in production and
 * nothing would have said so. A guard nothing reaches is not a guard.
 */
describe('the plan-time guards are actually reached', () => {
  // A real directory with no package.json: wrongToolForStack looks at the disk,
  // and "cannot tell" is deliberately not "wrong", so a fake path proves nothing.
  const dir = mkdtempSync(join(tmpdir(), 'sa-plan-'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const pyCfg = {
    ...cfg,
    repos: [{ id: 'r1', path: dir, stack: 'python', verify_cmd: 'pytest -q' }],
  } as unknown as AppConfig;

  it('rejects a node check planned for a python repo', async () => {
    // Tzyqrdo67z0, example-api: two dispatches, then diagnosed by hand three days on.
    await planNextMilestone(pyCfg, brainReturning([proposal({ verify_cmd: 'npm test' })]));
    expect(ledger.insertTasks).not.toHaveBeenCalled();
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![2]).toMatch(/package\.json/);
  });

  it('rejects a placeholder instruction', async () => {
    await planNextMilestone(
      pyCfg,
      brainReturning([proposal({ instruction: 'Execute primary task specification according to project guidelines.' })]),
    );
    expect(ledger.insertTasks).not.toHaveBeenCalled();
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![2]).toMatch(/placeholder/);
  });

  it('rejects a check that only restates the diff', async () => {
    await planNextMilestone(
      pyCfg,
      brainReturning([proposal({ verify_cmd: 'grep -q "better-sqlite3" package.json' })]),
    );
    expect(ledger.insertTasks).not.toHaveBeenCalled();
    expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![2]).toMatch(/diff already shows/);
  });

  it('rejects work no check in this repo could judge', () => {
    // Run 18 pushed 391 lines of TypeScript into a python repo this way, and
    // reported both tasks as clean successes.
    return planNextMilestone(
      pyCfg,
      brainReturning([proposal({ files_hint: ['frontend/src/components/SearchBar.tsx'], verify_cmd: 'pytest -q' })]),
    ).then(() => {
      expect(ledger.insertTasks).not.toHaveBeenCalled();
      expect(vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![2]).toMatch(/TypeScript/);
    });
  });

  it('still plans a task none of them object to', async () => {
    // The repo is python, so the control case has to be a python file: the
    // fixture's default `src/health.ts` is exactly what the guard above
    // rejects, and it was in here until run 18 gave anything a reason to look.
    expect(
      await planNextMilestone(
        pyCfg,
        brainReturning([proposal({ files_hint: ['app/health.py'], verify_cmd: 'pytest -q' })]),
      ),
    ).toBe(1);
  });

  it('tells the brain WHY a well-formed proposal was unusable, so the next model is consulted', async () => {
    // The gate returning null on a proposal it rejected is invisible from the
    // outcome - the milestone is rejected either way. The difference is that
    // the loop stops looking, which is what stranded this exact milestone.
    let verdict: string | null | undefined;
    const brain = {
      ask: vi.fn(async (_t: string, _s: unknown, _l: string, accept?: (d: unknown) => string | null) => {
        verdict = accept?.({ tasks: [proposal({ verify_cmd: 'npm test' })] });
        throw new Error('exhausted');
      }),
    } as unknown as BrainDriver;

    await planNextMilestone(pyCfg, brain);

    expect(verdict).toBeTruthy();
    expect(verdict).toMatch(/package\.json/);
  });

  it('records the verdict of the last attempt, not of every attempt', async () => {
    // Two attempts, two different objections. Reporting both reads as one
    // proposal that failed twice as hard, and buries how close the brain got.
    const brain = {
      ask: vi.fn(async (_t: string, _s: unknown, _l: string, accept?: (d: unknown) => string | null) => {
        accept?.({ tasks: [proposal({ verify_cmd: 'npm test' })] });
        accept?.({ tasks: [proposal({ instruction: 'Execute primary task specification according to project guidelines.' })] });
        throw new Error('exhausted');
      }),
    } as unknown as BrainDriver;

    await planNextMilestone(pyCfg, brain);

    const why = vi.mocked(ledger.setMilestoneStatus).mock.calls[0]![2]!;
    expect(why).toMatch(/placeholder/);
    expect(why).not.toMatch(/package\.json/);
  });

  it('fits the prompt to what the driver says it can carry', async () => {
    /*
     * The planner cannot know that agy spawns a process, and agy cannot know
     * which parts of the prompt are elastic. Asking the driver for its budget
     * is the only thing that keeps a 32804-char prompt off a 32767-char
     * command line.
     */
    vi.mocked(ledger.knownWork).mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        title: `an earlier task, number ${i}, with a reasonably long title`,
        paths: ['app/core/health.py'],
      })) as unknown as ReturnType<typeof ledger.knownWork>,
    );

    let seen = 0;
    const brainWithBudget = (maxPromptChars?: number) =>
      ({
        maxPromptChars,
        ask: vi.fn(async (text: string) => {
          seen = text.length;
          throw new Error('probe: not calling a provider');
        }),
      }) as unknown as BrainDriver;

    await planNextMilestone(pyCfg, brainWithBudget(undefined)).catch(() => {});
    const natural = seen;
    expect(natural).toBeGreaterThan(2000);

    await planNextMilestone(pyCfg, brainWithBudget(natural - 500)).catch(() => {});
    expect(seen).toBeLessThanOrEqual(natural - 500);
  });

  /*
   * The wiring, not the arithmetic. fitPrompt could budget in cost units all it
   * liked while the planner kept handing it none - which is exactly the shape
   * of the 2026-08-18 spawn failure, where every piece was individually right.
   */
  it('fits the prompt to what the driver charges, not just to what it declares', async () => {
    // The other sections are mocked empty here, so without this there is
    // nothing elastic and fitPrompt can only throw.
    vi.mocked(readRecent).mockReturnValue('j'.repeat(3000));

    let seen = 0;
    const brainCharging = (cost?: (t: string) => number, budget?: number) =>
      ({
        maxPromptChars: budget,
        promptCost: cost,
        ask: vi.fn(async (text: string) => {
          seen = text.length;
          throw new Error('probe: not calling a provider');
        }),
      }) as unknown as BrainDriver;

    await planNextMilestone(pyCfg, brainCharging(undefined, undefined)).catch(() => {});
    const natural = seen;
    expect(natural).toBeGreaterThan(2000);

    // Comfortably inside the budget by length, over it at two per character,
    // and reachable by trimming - so a wrong measure shows up as an oversized
    // prompt rather than as an exception.
    const budget = natural * 2 - 500;
    seen = -1;
    await planNextMilestone(pyCfg, brainCharging((t) => t.length * 2, budget)).catch(() => {});

    expect(seen, 'the prompt never reached the driver').toBeGreaterThan(0);
    expect(seen).toBeLessThan(natural);
    expect(seen * 2).toBeLessThanOrEqual(budget);

    vi.mocked(readRecent).mockReturnValue('');
  });

  it('does not record a verdict when the brain never got as far as proposing', async () => {
    /*
     * A quota error, a timeout or a denied tool call says nothing about this
     * milestone. Writing 'rejected' for one is the conflation that closed
     * "Relocate health module" as satisfied and cost a hand re-entry - so this
     * has to surface as a failure of the run, not a conclusion about the work.
     */
    const brain = {
      ask: vi.fn(async () => {
        throw new Error('QUOTA: quota exceeded for gemini-3.1-pro-high');
      }),
    } as unknown as BrainDriver;

    await expect(planNextMilestone(pyCfg, brain)).rejects.toThrow(/QUOTA/);
    expect(ledger.setMilestoneStatus).not.toHaveBeenCalled();
    expect(ledger.insertTasks).not.toHaveBeenCalled();
  });
});


/**
 * The prompt has to be deliverable, not merely correct.
 *
 * agy is spawned as a process and the prompt rides in argv, which Windows caps
 * at 32767 characters for the whole command line. The decompose prompt reached
 * 32804 and the spawn failed with both streams empty and no exit code - read by
 * the loop as "the model returned nothing", charged one of three attempts, on
 * the first attempt of every model.
 */
describe('fitting the prompt to what the driver can carry', () => {
  const sections = { JOURNAL: 'j'.repeat(500), RESOLVED: 'r'.repeat(500), SYMBOLS: 's'.repeat(500) };
  const render = (s: Record<string, string>) => `HEAD${s.JOURNAL}${s.RESOLVED}${s.SYMBOLS}`;

  it('leaves a prompt that already fits completely alone', () => {
    expect(fitPrompt(render, sections, 10_000)).toBe(render(sections));
  });

  it('leaves it alone when the driver declares no limit', () => {
    // opencode does not spawn with the prompt in argv, and must not pay for a
    // constraint that is not its own.
    expect(fitPrompt(render, sections, undefined)).toBe(render(sections));
  });

  it('spends the journal before the API surface', () => {
    /*
     * Order is the whole design. The surface is what tells the decomposer the
     * work already exists; hiding it is what had the planner proposing a file
     * move that had happened weeks earlier. Commentary goes first.
     */
    const out = fitPrompt(render, sections, 1200);

    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out).toContain('s'.repeat(500)); // surface intact
    expect(out).toContain('r'.repeat(500)); // resolutions intact
    expect(out).not.toContain('j'.repeat(500)); // journal trimmed
  });

  /*
   * The review prompt's own order, which is not the decompose prompt's. A
   * reviewer asked to judge a change needs the change (PATCH) above all, and
   * needs the junior's account of it above a symbol index — the index answers
   * one question, "does this reinvent something", and is already being cut in
   * half to fit on a repo of any size. Buying room out of the report first is
   * how the reviewer goes back to not being told why a brief step is missing,
   * which on 2026-08-21 cost a correct change and a whole task.
   */
  it('spends the symbols before the junior report, and the report before the patch', () => {
    const review = {
      SYMBOLS: 's'.repeat(500),
      REPORT: 'e'.repeat(500),
      PATCH: 'p'.repeat(500),
    };
    const draw = (s: Record<string, string>) => `HEAD${s.SYMBOLS}${s.REPORT}${s.PATCH}`;

    const symbolsGone = fitPrompt(draw, review, 1200);
    expect(symbolsGone).toContain('p'.repeat(500)); // the change itself, intact
    expect(symbolsGone).toContain('e'.repeat(500)); // why it looks like that, intact
    expect(symbolsGone).not.toContain('s'.repeat(500));

    const reportGoneToo = fitPrompt(draw, review, 700);
    expect(reportGoneToo).toContain('p'.repeat(500)); // still the last to go
    expect(reportGoneToo).not.toContain('e'.repeat(500));
  });

  it('gives up the surface only once everything else is gone', () => {
    const out = fitPrompt(render, sections, 600);

    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).not.toContain('j'.repeat(100));
    expect(out).not.toContain('r'.repeat(100));
    expect(out).toContain('s'); // some surface survives; it is the last to go
  });

  /*
   * The 2026-08-18 regression. fitPrompt trimmed the decompose prompt until
   * `text.length` was inside maxPromptChars, reported success, and the spawn
   * failed with ENAMETOOLONG anyway - because on a Windows command line the
   * prompt costs more than it measures. A budget is only meaningful in the
   * same units the driver charges in.
   */
  it('budgets in the units the driver charges in, not in characters', () => {
    // A driver that charges two per character: 1500 chars of sections cost 3000.
    const double = (t: string) => t.length * 2;

    // By length this fits 2000 easily and nothing would be trimmed.
    expect(render(sections).length).toBeLessThan(2000);
    const out = fitPrompt(render, sections, 2000, double);

    expect(double(out)).toBeLessThanOrEqual(2000);
    expect(out).not.toBe(render(sections));
  });

  it('measures the retry against the cost too, not just the first pass', () => {
    const double = (t: string) => t.length * 2;
    // Tight enough that one section is not enough and it must keep going.
    const out = fitPrompt(render, sections, 1400, double);
    expect(double(out)).toBeLessThanOrEqual(1400);
  });

  it('still measures by length when the driver names no cost of its own', () => {
    expect(fitPrompt(render, sections, 10_000)).toBe(render(sections));
  });

  it('says so rather than handing over a prompt that cannot be spawned', () => {
    // The fixed parts alone do not fit. Silence here is what cost eight days.
    const fixed = (s: Record<string, string>) => `${'H'.repeat(5000)}${s.JOURNAL}`;

    expect(() => fitPrompt(fixed, { JOURNAL: 'j'.repeat(100) }, 1000)).toThrow(/do not fit/);
  });

  it('refuses at the end in cost units too, not just in characters', () => {
    /*
     * With every elastic section emptied, the fixed part is 500 characters and
     * costs 1000. Checking the leftover by length says 500 < 900 and hands back
     * a prompt that cannot be spawned - silently, which is how this class of
     * failure reaches production as "the model returned nothing".
     */
    const fixed = (x: Record<string, string>) => `${'H'.repeat(500)}${x.JOURNAL}`;
    const double = (t: string) => t.length * 2;

    expect(() => fitPrompt(fixed, { JOURNAL: 'j'.repeat(100) }, 900, double)).toThrow(/do not fit/);
  });

  it('reports what it trimmed and by how much', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    fitPrompt(render, sections, 1200);

    // A prompt quietly missing a section is the defect this repo fixed once
    // already; the warning is what makes the next one a one-line diagnosis.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/trimmed JOURNAL from 500 to \d+ chars/);
    warn.mockRestore();
  });
});

/**
 * A refill pass can end three ways, and the operator has to be able to tell
 * which one happened.
 *
 * All three used to be a bare `break`. On 2026-08-20 an idea produced seven
 * milestones, the per-pass cap planned six, and the seventh sat `unplanned`
 * with nothing on screen, in the log or in the journal to say it existed. The
 * operator saw "Backlog: +6 task(s)" and had no way to tell a finished pass
 * from a truncated one — and the operator here is not going to read the code
 * to find out.
 */
describe('refillBacklog says why it stopped', () => {
  const refillCfg = {
    system: {
      daily_target: 5,
      limits: { max_files_per_task: 4, min_insertions: 10 },
      backlog: { tasks_per_milestone: [3, 8], min_ready: 5 },
    },
    repos: [{ id: 'r1', path: 'D:/repo', stack: 'ts', verify_cmd: 'npm test' }],
  } as unknown as AppConfig;

  it('names a full backlog instead of stopping in silence', async () => {
    vi.mocked(ledger.readyTasks).mockReturnValue(new Array(6).fill({}) as never);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    const added = await refillBacklog(refillCfg, brainReturning([proposal()]));

    expect(added).toBe(0);
    expect(info.mock.calls.flat().join(' ')).toMatch(/backlog is full \(6 ready, min 5\)/i);
    info.mockRestore();
  });

  it('says the cap stopped it, and that work is still waiting', async () => {
    // Nothing ever becomes ready, so only the cap can end this.
    vi.mocked(ledger.readyTasks).mockReturnValue([]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const added = await refillBacklog(refillCfg, brainReturning([proposal()]));

    const said = warn.mock.calls.flat().join(' ');
    expect(added).toBe(6); // the cap, not the whole queue
    expect(said).toMatch(/the per-pass cap/i);
    // The half that makes it actionable: something is still unplanned, and
    // running plan again is what clears it.
    expect(said).toMatch(/still unplanned/i);
    expect(said).toMatch(/npm run plan/);
    warn.mockRestore();
  });

  it('does not claim work is waiting when none is', async () => {
    vi.mocked(ledger.readyTasks).mockReturnValue([]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // Exactly six milestones, each leaving the queue as its status is written,
    // so the cap and the end of the queue fall on the same pass.
    const queue = ['a', 'b', 'c', 'd', 'e', 'f'].map((title, i) => ({
      id: `M${i + 1}`,
      title,
      detail: 'd',
      repo: 'r1',
    }));
    vi.mocked(ledger.nextUnplannedMilestone).mockImplementation(() => queue[0] as never);
    vi.mocked(ledger.setMilestoneStatus).mockImplementation(((id: string) => {
      if (queue[0]?.id === id) queue.shift();
    }) as never);

    await refillBacklog(refillCfg, brainReturning([proposal()]));

    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/the per-pass cap/i);
    expect(said).toMatch(/nothing is left unplanned/i);
    expect(said).not.toMatch(/still unplanned/i);
    warn.mockRestore();
  });

  it('leaves an empty queue to planNextMilestone rather than talking over it', async () => {
    vi.mocked(ledger.readyTasks).mockReturnValue([]);
    vi.mocked(ledger.nextUnplannedMilestone).mockReturnValue(undefined as never);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const added = await refillBacklog(refillCfg, brainReturning([proposal()]));

    expect(added).toBe(0);
    // planNextMilestone has already said why it got nothing. A second, vaguer
    // message here would only bury it.
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/per-pass cap/i);
    warn.mockRestore();
  });
});

/**
 * A milestone worth one complete change should produce one. That is the design,
 * not a shortfall: decompose.md tells the model NEVER to pad, and system.yaml
 * explains why fragments that land alone are dead code the gate rejects.
 *
 * Until 2026-08-21 the planner warned about it anyway, against a floor of three
 * left behind by the change that made a task a complete change rather than a
 * fragment. It fired on ten consecutive milestones without once being silent,
 * which told a non-technical operator that the planner was misbehaving while it
 * was doing exactly what it was built to do.
 *
 * These pin the quiet. Note the fixture config still carries a floor of three,
 * so a reintroduced check would fail them whatever the configured number.
 */
describe('a milestone that is genuinely worth a single task', () => {
  it('keeps the task and still reports the count, without calling it a shortfall', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    // One valid task against a fixture floor of three.
    const n = await planNextMilestone(cfg, brainReturning([proposal()]));

    expect(n).toBe(1); // kept: padding is worse than a short milestone
    // The operator is still told what happened, just not alarmed by it.
    expect(info.mock.calls.flat().join(' ')).toMatch(/1 task\(s\)/);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/floor|tasks_per_milestone|min_ready/);

    info.mockRestore();
    warn.mockRestore();
  });

  it('is equally quiet when the milestone produced several', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const n = await planNextMilestone(
      cfg,
      brainReturning([
        proposal({ title: 'Add health endpoint' }),
        proposal({ title: 'Add readiness endpoint', files_hint: ['src/ready.ts'] }),
        proposal({ title: 'Add liveness endpoint', files_hint: ['src/live.ts'] }),
      ]),
    );

    expect(n).toBe(3);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/floor|tasks_per_milestone/);
    warn.mockRestore();
  });
});

/**
 * A milestone that queues nothing must not end the pass.
 *
 * From-zero run, 2026-08-20: one idea shaped into five milestones, three
 * planned, the fourth had every proposal rejected — and the fifth was never
 * attempted and never named anywhere the operator looks. "+3 task(s)" read
 * exactly like a finished job.
 */
describe('refillBacklog after a milestone that planned nothing', () => {
  const refillCfg = {
    system: {
      daily_target: 5,
      limits: { max_files_per_task: 4, min_insertions: 10 },
      backlog: { tasks_per_milestone: [3, 8], min_ready: 5 },
    },
    repos: [{ id: 'r1', path: 'D:/repo', stack: 'ts', verify_cmd: 'npm test' }],
  } as unknown as AppConfig;

  const ms = (id: string) => ({ id, title: `milestone ${id}`, detail: 'd', repo: 'r1' });

  it('carries on to the next one instead of ending the pass', async () => {
    // The real queue advances when a status is written, so the mock does too:
    // a head that never moves would make this test agree with itself.
    const queue = [ms('M1'), ms('M2')];
    vi.mocked(ledger.readyTasks).mockReturnValue([]);
    vi.mocked(ledger.nextUnplannedMilestone).mockImplementation(() => queue[0] as never);
    vi.mocked(ledger.setMilestoneStatus).mockImplementation(((id: string) => {
      if (queue[0]?.id === id) queue.shift();
    }) as never);

    await refillBacklog(refillCfg, brainReturning([], 'this is already built'));

    const seen = vi.mocked(ledger.setMilestoneStatus).mock.calls.map((c) => c[0]);
    expect(seen).toContain('M1');
    expect(seen).toContain('M2'); // never reached before this fix
  });

  it('stops and names the milestone when the queue head does not move', async () => {
    // setMilestoneStatus left as a no-op: whatever the reason, the same
    // milestone comes back, and retrying it would spend the cap on one loop.
    vi.mocked(ledger.readyTasks).mockReturnValue([]);
    vi.mocked(ledger.nextUnplannedMilestone).mockReturnValue(ms('M1') as never);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const brain = brainReturning([], 'this is already built');

    await refillBacklog(refillCfg, brain);

    expect(vi.mocked(brain.ask)).toHaveBeenCalledTimes(1); // not six
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/"milestone M1" is still unplanned/);
    expect(said).toMatch(/npm run plan/);
    warn.mockRestore();
  });
});

/*
 * The shaper decides WHAT the system is going to build, and it was the one
 * planning step working blind.
 *
 * Its whole view of the repo was `fileTree` — a list of PATHS. It could see
 * that `app/api/unanswered_queries.py` exists and nothing whatever about the
 * fact that the file already serves grouped, counted, most-frequent-first
 * failing questions. On 2026-08-21 it shaped an epic that built a second one,
 * and the resulting plan contained BOTH a new /api/stats/failed-searches and a
 * rewrite of the existing /api/unanswered-queries/frequent, from one idea, in
 * one pass.
 *
 * The decomposer and the reviewer have had the surface for a while, and both
 * are downstream of this decision: by the time either could notice the
 * duplicate, the epic asking for it is already in the ledger and the milestones
 * are already split on it.
 */
describe('the shaper can see what the repo already serves', () => {
  const idea = { title: 'Show which searches fail', body: 'operators want to see failing queries', repo: 'r1' };
  const shapeBrain = () =>
    ({
      ask: vi.fn(async () => ({
        epics: [{ title: 'E', summary: 's', milestones: [{ title: 'M', detail: 'd' }] }],
      })),
    }) as unknown as BrainDriver;

  it('puts the api surface into the prompt it sends', async () => {
    vi.mocked(apiSurface).mockResolvedValue('app/api/unanswered_queries.py: /api/unanswered-queries/frequent');
    const brain = shapeBrain();
    await shapeIdea(cfg, brain, idea);

    const sent = vi.mocked(brain.ask).mock.calls[0]![0] as string;
    expect(sent).toContain('/api/unanswered-queries/frequent');
  });

  /*
   * The drift this actually guards. A placeholder in the template with no key in
   * the fill call does not throw — it ships the literal `{{SURFACE}}` to the
   * model, which reads it as an empty section and plans exactly as blindly as
   * before, with nothing anywhere reporting a fault.
   */
  it('leaves no placeholder unfilled', async () => {
    const brain = shapeBrain();
    await shapeIdea(cfg, brain, idea);
    expect(vi.mocked(brain.ask).mock.calls[0]![0] as string).not.toMatch(/\{\{\w+}}/);
  });

  /*
   * Deliberately a smaller budget than the decomposer's, which takes the
   * default. This step has to RECOGNISE what exists, not implement against it.
   */
  it('asks for the surface on its own budget', async () => {
    await shapeIdea(cfg, shapeBrain(), idea);
    const [, budget] = vi.mocked(apiSurface).mock.calls[0]!;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(16_000);
  });
});


/*
 * O23's other half, at the call site.
 *
 * `dropTasksPlanningAgainstNothing` is covered on its own in
 * plancheck.test.ts, and deleting the one line in `planNextMilestone` that
 * calls it left all 140 of those green — because this file's brain fixture
 * answered the check with a decompose draft, so it threw and no-opped. Sixth
 * time this shape has appeared in this project.
 */
describe('the plan is checked against the code before its jobs are queued', () => {
  it('does not queue a job whose premise the code contradicts', async () => {
    const brain = brainReturning(
      [
        proposal({ title: 'Slice the cache in top_documents' }),
        proposal({
          title: 'Add a --json flag to the report',
          instruction: 'add the flag in src/report.ts',
          files_hint: ['src/report.ts'],
        }),
      ],
      undefined,
      { drop: [{ index: 0, why: 'top_documents already slices; there is no loop to change' }] },
    );

    await planNextMilestone(cfg, brain);

    const queued = vi.mocked(ledger.insertTasks).mock.calls.at(-1)?.[2] ?? [];
    expect(queued.map((x) => x.title)).toEqual(['Add a --json flag to the report']);
  });

  it('queues everything when the code bears the plan out', async () => {
    const brain = brainReturning([
      proposal({ title: 'Slice the cache in top_documents' }),
      proposal({
        title: 'Add a --json flag to the report',
        instruction: 'add the flag in src/report.ts',
        files_hint: ['src/report.ts'],
      }),
    ]);

    await planNextMilestone(cfg, brain);

    const queued = vi.mocked(ledger.insertTasks).mock.calls.at(-1)?.[2] ?? [];
    expect(queued).toHaveLength(2);
  });
});
