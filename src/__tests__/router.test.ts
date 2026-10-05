import { describe, it, expect } from 'vitest';
import { isComplex, route, poolFor, pickFromPool, repoRouting, reroute } from '../core/router.js';
import type { AppConfig } from '../config.js';
import type { Repo, TaskRow } from '../schemas.js';

function cfg(
  routing: Partial<AppConfig['drivers']['routing']> = {},
  repos: Partial<Repo>[] = [],
): AppConfig {
  return {
    system: {} as AppConfig['system'],
    repos,
    drivers: {
      brain: { active: 'opencode', registry: {} },
      chat: { active: 'chatgpt', enabled: false, registry: {} },
      agents: {
        registry: {
          opencode: { module: 'x', kind: 'cli' },
          agy: { module: 'y', kind: 'cli' },
          copilot: { module: 'c', kind: 'cli' },
          antigravity: { module: 'z', kind: 'ide' },
        },
      },
      routing: {
        default: 'opencode',
        complex_agents: ['agy', 'copilot'],
        simple_agents: ['opencode'],
        complexity: { min_est_lines: 25, min_files: 2, complex_kinds: ['feature', 'refactor', 'bugfix'] },
        rules: [],
        ...routing,
      },
    },
  } as unknown as AppConfig;
}

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T1',
    repo: 'r1',
    kind: 'config',
    est_lines: 5,
    files_hint: '[]',
    executor_hint: 'cli',
    title: 't',
    ...over,
  } as TaskRow;
}

describe('isComplex', () => {
  it('treats feature/refactor/bugfix as complex regardless of size', () => {
    for (const kind of ['feature', 'refactor', 'bugfix'] as const) {
      expect(isComplex(cfg(), task({ kind, est_lines: 1 })).complex).toBe(true);
    }
  });

  it('treats a large edit as complex even for a simple kind', () => {
    expect(isComplex(cfg(), task({ kind: 'config', est_lines: 40 })).complex).toBe(true);
  });

  it('treats a multi-file edit as complex', () => {
    expect(isComplex(cfg(), task({ files_hint: '["a.ts","b.ts"]' })).complex).toBe(true);
  });

  it('treats a small single-file config change as simple', () => {
    expect(isComplex(cfg(), task({ files_hint: '["a.ts"]' })).complex).toBe(false);
  });

  it('survives malformed files_hint rather than throwing', () => {
    expect(() => isComplex(cfg(), task({ files_hint: 'not json' }))).not.toThrow();
  });
});

describe('route — by task size, never by project', () => {
  const big = () => task({ id: 'T-big', kind: 'feature', est_lines: 40 });
  const small = () => task({ id: 'T-small', kind: 'config', est_lines: 5 });

  it('sends big work to a capable agent and small work to the cheap one', () => {
    expect(['agy', 'copilot']).toContain(route(cfg(), big()).agent);
    expect(route(cfg(), small()).agent).toBe('opencode');
  });

  it('shares complex work between agy and copilot rather than loading one', () => {
    // Both are capable; splitting the hard jobs draws on two independent
    // provider quotas, and quota is what actually stops this system.
    const picked = new Set(
      Array.from({ length: 60 }, (_, i) => route(cfg(), task({ id: `T${i}`, kind: 'feature', est_lines: 40 })).agent),
    );
    expect(picked).toEqual(new Set(['agy', 'copilot']));
  });

  it('gives the same task the same agent every time', () => {
    // A retry must go back to the worker that has already seen the repo, and
    // `sa route` must show what a run will really do rather than a guess.
    const first = route(cfg(), big()).agent;
    for (let i = 0; i < 20; i++) expect(route(cfg(), big()).agent).toBe(first);
  });

  it('ignores which project the task belongs to', () => {
    const a = route(cfg(), task({ id: 'T-x', repo: 'alpha', kind: 'feature', est_lines: 40 })).agent;
    const b = route(cfg(), task({ id: 'T-x', repo: 'omega', kind: 'feature', est_lines: 40 })).agent;
    expect(a).toBe(b);
  });

  it('says who it shared the pool with, so the choice is inspectable', () => {
    expect(route(cfg(), big()).reason).toMatch(/shared with/);
  });

  it('falls back to the default when a pool names nothing usable', () => {
    expect(route(cfg({ complex_agents: ['ghost'] }), big()).agent).toBe('opencode');
  });

  it('lets an explicit kind rule win over the size split', () => {
    const c = cfg({ rules: [{ kinds: ['feature'], agent: 'opencode' }] });
    expect(route(c, big()).agent).toBe('opencode');
  });

  it('collapses to one agent when the pool holds one', () => {
    expect(route(cfg({ complex_agents: ['agy'] }), big()).agent).toBe('agy');
  });
});

describe('reroute — an exhausted agent must not take the run down with it', () => {
  /*
   * Measured through the real screen on 2026-08-15: 4 ready jobs, all four
   * hashed to copilot, copilot answered QUOTA on the first, and the run ended
   * 38 seconds in with 0 committed while agy, opencode and antigravity were
   * healthy. copilot's quota resets 2026-09-01 — 16 days of runs that would
   * each have stopped on their first job.
   */
  const big = (id = 'T-big') => task({ id, kind: 'feature', est_lines: 40 });
  const none = new Set<string>();

  it('changes nothing while the routed agent is healthy', () => {
    expect(reroute(cfg(), big(), none)).toBe(route(cfg(), big()).agent);
  });

  it('hands the task to its pool-mate when the routed agent is out', () => {
    for (const id of ['T-a', 'T-b', 'T-c', 'T-d']) {
      const mine = route(cfg(), big(id)).agent;
      const other = mine === 'agy' ? 'copilot' : 'agy';
      expect(reroute(cfg(), big(id), new Set([mine]))).toBe(other);
    }
  });

  it('gives up only when the whole pool is out', () => {
    expect(reroute(cfg(), big(), new Set(['agy', 'copilot']))).toBeNull();
  });

  it('does not promote an agent the pool for this size excludes', () => {
    // opencode is healthy and idle, and still must not be handed complex work:
    // "not trusted with a job this size" does not change because someone else
    // ran out.
    expect(reroute(cfg(), big(), new Set(['agy', 'copilot']))).toBeNull();
    // and the reverse — a simple task never climbs into the complex pool.
    const small = task({ id: 'T-small', kind: 'config', est_lines: 5 });
    expect(reroute(cfg(), small, new Set(['opencode']))).toBeNull();
  });

  it('leaves a task pinned by an explicit rule pinned', () => {
    // The operator chose that agent by name; it waits for them rather than
    // going somewhere they did not pick.
    const c = cfg({ rules: [{ kinds: ['feature'], agent: 'copilot' }] });
    expect(reroute(c, big(), new Set(['copilot']))).toBeNull();
  });
});

describe('pickFromPool', () => {
  it('returns the only member without hashing', () => {
    expect(pickFromPool(['agy'], 'anything')).toBe('agy');
  });

  it('spreads different ids across the pool', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => pickFromPool(['a', 'b'], `T${i}`)));
    expect(seen.size).toBe(2);
  });
});

describe('poolFor', () => {
  it('uses the configured lists', () => {
    expect(poolFor(cfg(), true)).toEqual(['agy', 'copilot']);
    expect(poolFor(cfg(), false)).toEqual(['opencode']);
  });

  it('drops ids that are not registered agents', () => {
    expect(poolFor(cfg({ complex_agents: ['agy', 'ghost'] }), true)).toEqual(['agy']);
  });

  /*
   * Borrowing routing.default when the named list is empty is the right
   * behaviour — running nothing is worse — but on the complex side it is a
   * capability downgrade: heavy multi-file work goes to the simple-work agent.
   *
   * It stopped being hypothetical on 2026-08-15. `agy-access.ps1 -Revoke`, the
   * one-click button for pulling agy's shell access, drops agy from
   * complex_agents; copilot's removal that day left agy the only member, so the
   * panic button now empties the array. It routed a 400-line, 3-file feature to
   * opencode giving the reason "complex: kind=feature" — indistinguishable from
   * a deliberate choice.
   */
  const big = () => task({ id: 'T-big', kind: 'feature', est_lines: 400, files_hint: '["a","b","c"]' });
  const small = () => task({ id: 'T-small', kind: 'config', est_lines: 5 });

  it('says so when a size has no agent and the default is being borrowed', () => {
    const empty = cfg({ complex_agents: [] });
    expect(poolFor(empty, true)).toEqual(['opencode']); // still routed, not refused

    const d = route(empty, big());
    expect(d.agent).toBe('opencode');
    expect(d.reason).toMatch(/NO complex agent is configured/);
    expect(d.reason).toContain('opencode');
    // 'pool' would have reroute hunting for pool-mates that do not exist.
    expect(d.via).toBe('default');
  });

  it('does not cry fallback when the pool is real', () => {
    const d = route(cfg(), big());
    expect(d.via).toBe('pool');
    expect(d.reason).not.toMatch(/NO complex agent/);
  });

  it('says it for the simple side too, not just complex', () => {
    const d = route(cfg({ simple_agents: [], default: 'agy' }), small());
    expect(d.reason).toMatch(/NO simple agent is configured/);
    expect(d.via).toBe('default');
  });
});

describe('per-repo agent pinning is gone', () => {
  /*
   * It briefly existed to keep Python away from agy, whose allow-list cannot run
   * a named test file. That tied a WORKER to a PROJECT, which is not the design:
   * a worker is chosen by how big the job is and takes over whatever project it
   * lands in. A stale block must be reported, not quietly obeyed.
   */
  it('rejects a leftover routing block instead of honouring it', () => {
    const c = cfg({}, [{ id: 'r1', routing: { complex_agent: 'copilot' } } as Partial<Repo>]);
    expect(() => repoRouting(c, 'r1')).toThrow(/assigned by task size/i);
  });

  it('is happy with a repo that has no routing block', () => {
    expect(repoRouting(cfg({}, [{ id: 'r1' } as Partial<Repo>]), 'r1')).toEqual({});
  });
});
