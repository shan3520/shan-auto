import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SystemSchema } from '../schemas.js';
import type { AppConfig } from '../config.js';
import { p } from '../config.js';

/**
 * Quota is the stated binding constraint of this system, and until now nothing
 * counted it: copilot reported `premiumRequests` on every dispatch and the
 * driver logged the number and threw it away. These tests guard the two things
 * that make the count worth having — that it is honest about what it does not
 * know, and that it can never be the reason a run dies.
 */

const dir = mkdtempSync(join(tmpdir(), 'sa-cost-'));
const dbFile = join(dir, 'test.db');
process.env.SHANAUTO_DB = dbFile;

const ledger = await import('../ledger.js');
const { dailyBudget } = await import('../core/budget.js');

/**
 * The smallest config the schema accepts. Built here rather than read from disk,
 * so these tests describe the schema instead of the owner's current settings.
 */
const MINIMAL_SYSTEM = {
  daily_target: 30,
  max_daily_commits: 40,
  work_hours: { start: '00:00', end: '23:59' },
  timeouts: { task_s: 1, verify_s: 1, brain_s: 1 },
  limits: {
    max_attempts: 2,
    max_files_per_task: 4,
    min_insertions: 3,
    scope_blowout_multiplier: 2,
    max_run_hours: 8,
  },
  backlog: { min_ready: 30, tasks_per_milestone: [3, 10] },
  brain: { model: 'x' },
  notify: { on_run_complete: true, on_failure: true },
};

/** Only `system.budget` is read, so nothing else needs to be real. */
function cfgWithBudget(daily_agent_units: number): AppConfig {
  return { system: { budget: { daily_agent_units } } } as unknown as AppConfig;
}

beforeEach(() => {
  ledger.open().exec('DELETE FROM runs; DELETE FROM agent_costs;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('per-run agent cost', () => {
  it('bills a reported figure to the run that spent it', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 1);
    expect(ledger.agentSpendForDay()).toEqual({ units: 1, unmeasured: 0 });
  });

  it('keeps fractional figures intact — copilot bills 0.33 of a premium request', () => {
    // Rounding each dispatch to a whole number would drift the monthly total the
    // allowance is actually measured against.
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 0.33);
    ledger.recordAgentCost(run, 0.33);
    ledger.recordAgentCost(run, 0.33);
    expect(ledger.agentSpendForDay().units).toBeCloseTo(0.99, 5);
  });

  it('sums across every run of the same day', () => {
    ledger.recordAgentCost(ledger.startRun(), 2);
    ledger.recordAgentCost(ledger.startRun(), 1.5);
    expect(ledger.agentSpendForDay().units).toBeCloseTo(3.5, 5);
  });

  it('bills a retry as well as the first attempt, rather than overwriting it', () => {
    // Cost accumulates per dispatch. A task attempted twice cost twice.
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 1);
    ledger.recordAgentCost(run, 1);
    expect(ledger.agentSpendForDay().units).toBe(2);
  });

  it('ignores yesterday when reporting today', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 5);
    // Re-date the DISPATCH, not the run. Spend is bucketed by when the dispatch
    // happened; a run that starts before midnight and works past it splits.
    ledger.open().prepare("UPDATE agent_costs SET at='2000-01-01T12:00:00.000Z'").run();
    expect(ledger.agentSpendForDay()).toEqual({ units: null, unmeasured: 0 });
    expect(ledger.agentSpendForDay('2000-01-01').units).toBe(5);
  });

  /**
   * The reason this moved off runs.day. That column is stamped when a run
   * STARTS, so an overnight run billed the whole night to the day it began
   * while its commits counted towards the next one — two meanings of "today"
   * in one report.
   */
  it('splits a run that crosses midnight across both days', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 2); // before midnight
    ledger.open().prepare("UPDATE agent_costs SET at='2000-01-01T18:00:00.000Z'").run();
    ledger.recordAgentCost(run, 3); // after midnight, same run
    ledger
      .open()
      .prepare("UPDATE agent_costs SET at='2000-01-02T02:00:00.000Z' WHERE units=3")
      .run();

    expect(ledger.agentSpendForDay('2000-01-01').units).toBe(2);
    expect(ledger.agentSpendForDay('2000-01-02').units).toBe(3);
  });
});

/**
 * The rule that makes the number trustworthy. agy and opencode report nothing,
 * so treating a missing figure as 0 would make a whole night of them read as
 * free — understating spend on exactly the runs there is least data about.
 */
describe('a missing figure is unknown, never zero', () => {
  it('counts a dispatch that reported nothing as unmeasured', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, undefined);
    expect(ledger.agentSpendForDay()).toEqual({ units: null, unmeasured: 1 });
  });

  it('reports a day of unmeasured dispatches as unknown, not as 0', () => {
    const run = ledger.startRun();
    for (let i = 0; i < 3; i++) ledger.recordAgentCost(run, undefined);

    const spend = ledger.agentSpendForDay();
    expect(spend.units).toBeNull();
    expect(spend.unmeasured).toBe(3);

    const line = dailyBudget(cfgWithBudget(0)).line;
    expect(line).toContain('unknown');
    expect(line).not.toMatch(/\b0 unit/);
  });

  it('words a partly-measured day as a floor, so the total is not read as complete', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 1);
    ledger.recordAgentCost(run, undefined);

    expect(ledger.agentSpendForDay()).toEqual({ units: 1, unmeasured: 1 });
    expect(dailyBudget(cfgWithBudget(0)).line).toBe(
      'at least 1 unit(s) · 1 dispatch(es) reported no figure',
    );
  });

  it('treats a nonsense figure as unknown rather than as data', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, Number.NaN);
    ledger.recordAgentCost(run, -1);
    expect(ledger.agentSpendForDay()).toEqual({ units: null, unmeasured: 2 });
  });

  it('keeps a genuine zero, which is measured and not the same as unknown', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 0);
    expect(ledger.agentSpendForDay()).toEqual({ units: 0, unmeasured: 0 });
  });

  it('says nothing was recorded on a day with no dispatches at all', () => {
    expect(ledger.agentSpendForDay()).toEqual({ units: null, unmeasured: 0 });
    expect(dailyBudget(cfgWithBudget(0)).line).toBe('nothing recorded');
  });
});

/**
 * The house rule this feature is most likely to violate: bookkeeping must fail
 * open. By the time cost is recorded the provider request is already spent and
 * the agent's work may be sitting in the worktree waiting for the gate, so a
 * ledger problem must cost a log line — never the run, never the commit.
 */
describe('a recording failure cannot break a run', () => {
  it('swallows a database that cannot be opened', () => {
    ledger.closeForTest();
    // A directory is not a database. This is the closest honest stand-in for the
    // real cases: a locked file, a full disk, a data dir that vanished.
    process.env.SHANAUTO_DB = dir;
    try {
      expect(() => ledger.recordAgentCost('Rwhatever', 1)).not.toThrow();
      expect(() => ledger.recordAgentCost('Rwhatever', undefined)).not.toThrow();
    } finally {
      process.env.SHANAUTO_DB = dbFile;
      ledger.closeForTest();
    }
  });

  it('still counts a cost billed to a run that does not exist', () => {
    /*
     * This used to assert the opposite — that the spend was DROPPED — because
     * cost was an UPDATE against the runs row and an unknown id matched nothing.
     * Recording per dispatch changed the answer, and for the better: the request
     * was really made and really billed, so losing it understates the one number
     * this exists to keep honest. A dispatch outside any run is unusual, not
     * imaginary; an ad-hoc `sa` invocation makes one.
     */
    expect(() => ledger.recordAgentCost('R-no-such-run', 1)).not.toThrow();
    expect(ledger.agentSpendForDay().units).toBe(1);
  });

  it('reports unknown spend and no alarm when the ledger cannot be read', () => {
    ledger.closeForTest();
    process.env.SHANAUTO_DB = dir;
    try {
      const b = dailyBudget(cfgWithBudget(1));
      expect(b.spend).toEqual({ units: null, unmeasured: 0 });
      // An unreadable ledger must not trip a budget nobody can act on.
      expect(b.over).toBe(false);
    } finally {
      process.env.SHANAUTO_DB = dbFile;
      ledger.closeForTest();
    }
  });
});

describe('the soft budget', () => {
  /*
   * These read the SCHEMA's behaviour, not the owner's file.
   *
   * They used to parse the real config/system.yaml and assert the budget was 0 —
   * so setting a budget, which that file's own comment invites, turned the suite
   * red with the production code entirely correct. A test that fails when the
   * owner uses a documented setting is testing the owner, not the code.
   */
  it('is off unless a number is given, so spend is only ever reported', () => {
    const system = SystemSchema.parse({ ...MINIMAL_SYSTEM, budget: {} });
    expect(system.budget.daily_agent_units).toBe(0);
  });

  it('defaults to off when the config predates it, leaving behaviour unchanged', () => {
    const system = SystemSchema.parse(MINIMAL_SYSTEM);
    expect(system.budget.daily_agent_units).toBe(0);
  });

  it('honours a budget the owner actually sets', () => {
    const system = SystemSchema.parse({ ...MINIMAL_SYSTEM, budget: { daily_agent_units: 5 } });
    expect(system.budget.daily_agent_units).toBe(5);
  });

  it('never trips while unlimited, however much was spent', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 9999);
    expect(dailyBudget(cfgWithBudget(0)).over).toBe(false);
  });

  it('stays quiet under the limit', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 4);
    expect(dailyBudget(cfgWithBudget(5)).over).toBe(false);
  });

  it('trips once measured spend passes the limit', () => {
    const run = ledger.startRun();
    ledger.recordAgentCost(run, 5.5);
    const b = dailyBudget(cfgWithBudget(5));
    expect(b.over).toBe(true);
    expect(b.line).toContain('of a 5 soft budget');
  });

  it('cannot trip on unknown spend, which would be an alarm on a guess', () => {
    const run = ledger.startRun();
    for (let i = 0; i < 50; i++) ledger.recordAgentCost(run, undefined);
    expect(dailyBudget(cfgWithBudget(1)).over).toBe(false);
  });
});

/**
 * A database created before any of this existed must still open, and must not
 * pretend its old runs were free. Migrations here are additive and idempotent.
 */
describe('migrating a ledger that predates cost tracking', () => {
  it('adds the columns and leaves the old runs unmeasured rather than zero', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const old = join(dir, 'legacy.db');

    const pre = new DatabaseSync(old);
    pre.exec(
      'CREATE TABLE runs (id TEXT PRIMARY KEY, day TEXT, started_at TEXT, ended_at TEXT,' +
        ' attempted INTEGER DEFAULT 0, committed INTEGER DEFAULT 0, notes TEXT)',
    );
    pre.prepare("INSERT INTO runs (id,day) VALUES ('R-old','2026-01-01')").run();
    pre.close();

    ledger.closeForTest();
    process.env.SHANAUTO_DB = old;
    try {
      const row = ledger
        .open()
        .prepare("SELECT agent_cost, agent_cost_unknown FROM runs WHERE id='R-old'")
        .get() as { agent_cost: number | null; agent_cost_unknown: number | null };

      // NULL, not 0: nobody measured that run, and claiming it cost nothing
      // would understate history.
      expect(row.agent_cost).toBeNull();
      expect(row.agent_cost_unknown).toBeNull();
      expect(ledger.agentSpendForDay('2026-01-01')).toEqual({ units: null, unmeasured: 0 });

      // Idempotent: opening again must not fail on the columns already existing.
      ledger.closeForTest();
      expect(() => ledger.open()).not.toThrow();
    } finally {
      ledger.closeForTest();
      process.env.SHANAUTO_DB = dbFile;
    }
  });
});
