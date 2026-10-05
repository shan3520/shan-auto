import type { AppConfig } from '../config.js';
import type { RepoRouting, TaskRow } from '../schemas.js';

export interface RouteDecision {
  agent: string;
  reason: string;
  complex: boolean;
  /*
   * How the agent was arrived at, as a field rather than a phrase inside
   * `reason`. `reroute` has to tell "the pool happened to hash to copilot" from
   * "the operator pinned copilot by name", and those two produce the same agent
   * — the difference is only knowable here.
   */
  via: 'rule' | 'pool' | 'hint' | 'default';
}

/**
 * A task is "complex" if it is likely to need real reasoning across several
 * files, rather than a one-line edit. Any single signal is enough — the cost of
 * sending a small task to the heavier agent is a few wasted seconds, while the
 * cost of sending a big one to the lighter agent is a failed task and a retry.
 */
export function isComplex(cfg: AppConfig, task: TaskRow): { complex: boolean; why: string } {
  const c = cfg.drivers.routing.complexity;

  let files = 0;
  try {
    files = (JSON.parse(task.files_hint) as string[]).length;
  } catch {
    files = 0;
  }

  if (c.complex_kinds.includes(task.kind)) return { complex: true, why: `kind=${task.kind}` };
  if (task.est_lines >= c.min_est_lines) return { complex: true, why: `${task.est_lines} lines` };
  if (files >= c.min_files) return { complex: true, why: `${files} files` };

  return { complex: false, why: `${task.kind}, ~${task.est_lines} lines, ${files} file(s)` };
}

/**
 * Validate a repo's entry. Per-repo agent pinning was removed on 2026-08-08.
 *
 * It briefly existed to keep Python work away from agy, whose allow-list cannot
 * run a named test file. That solved the symptom by tying a WORKER to a
 * PROJECT, which is not the design: a worker is chosen by how big the job is,
 * and takes over whatever project that job belongs to. The capability problem
 * belongs in the pool for its size, not in a per-repo exception.
 *
 * Kept as a function so a stale `routing:` block in repos.yaml is reported
 * rather than silently obeyed.
 */
export function repoRouting(cfg: AppConfig, repoId: string): RepoRouting {
  const routing = cfg.repos.find((r) => r.id === repoId)?.routing;
  if (routing && (routing.complex_agent || routing.simple_agent)) {
    throw new Error(
      `Repo "${repoId}" still has a per-repo \`routing:\` block in config/repos.yaml. ` +
        `Agents are assigned by task size now, not by project — remove it.`,
    );
  }
  return {};
}

/**
 * Pick one of several agents for a task, stably.
 *
 * Stable rather than random or round-robin: the same task always draws the same
 * agent, so a retry after a transient failure goes back to the worker that has
 * already seen the repo, and `sa route` shows what a run will actually do rather
 * than a guess. Spread comes from the ids being spread across many tasks.
 */
export function pickFromPool(pool: string[], taskId: string): string {
  if (pool.length === 1) return pool[0]!;
  let h = 0;
  for (const ch of taskId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length]!;
}

/** The agents eligible for a task of this size, in registry order. */
export function poolFor(cfg: AppConfig, complex: boolean): string[] {
  const r = cfg.drivers.routing;
  const registry = cfg.drivers.agents.registry;
  const named = complex ? r.complex_agents : r.simple_agents;
  const usable = (named ?? []).filter((id) => registry[id]);
  return usable.length > 0 ? usable : [r.default];
}

/**
 * Decide which agent runs a task. Precedence:
 *   1. explicit kind rules in drivers.yaml
 *   2. the pool for the task's size, shared across its agents
 *   3. routing.default
 *
 * Size, never project. Complex work is shared between the capable agents so the
 * hard jobs draw on two independent quotas instead of one; simple work — the
 * kind needing no real judgement — goes to the cheap pool.
 *
 * A task's own `executor_hint` is only consulted when nothing else matched,
 * because the planner is guessing and the config is not.
 */
export function route(cfg: AppConfig, task: TaskRow): RouteDecision {
  const r = cfg.drivers.routing;
  const registry = cfg.drivers.agents.registry;
  const { complex, why } = isComplex(cfg, task);

  for (const rule of r.rules) {
    if (rule.kinds.includes(task.kind) && registry[rule.agent]) {
      return { agent: rule.agent, reason: `rule kind=${task.kind}`, complex, via: 'rule' };
    }
  }

  const pool = poolFor(cfg, complex);
  const picked = pickFromPool(pool, task.id);
  if (registry[picked]) {
    const size = complex ? 'complex' : 'simple';
    /*
     * poolFor falls back to routing.default when the named list is empty or
     * names nothing registered. That fallback is right — running nothing is
     * worse — but it was indistinguishable from a real pick, and it is a
     * CAPABILITY downgrade when it happens on the complex side: every heavy
     * multi-file job silently goes to the simple-work agent.
     *
     * It became reachable on 2026-08-15. `scripts/agy-access.ps1 -Revoke` — the
     * one-click button for taking agy's shell access away in a hurry — drops
     * agy from complex_agents, and copilot's removal that day left agy as the
     * only member. So the emergency button now empties the array. Measured with
     * this function: a 400-line, 3-file feature routed to opencode, reason
     * "complex: kind=feature", with nothing anywhere saying the complex pool
     * was empty.
     *
     * Still routed, not refused. It is said instead, and `via` becomes
     * 'default' — which is what it now is, and which stops reroute pretending
     * there are pool-mates to fall back on.
     */
    const borrowed = !((complex ? r.complex_agents : r.simple_agents) ?? []).some((id) => registry[id]);
    if (borrowed) {
      return {
        agent: picked,
        reason: `${size}: ${why} — NO ${size} agent is configured, so routing.default (${r.default}) is taking it`,
        complex,
        via: 'default',
      };
    }
    const shared = pool.length > 1 ? ` (shared with ${pool.filter((a) => a !== picked).join(', ')})` : '';
    return {
      agent: picked,
      reason: `${size}: ${why}${shared}`,
      complex,
      via: 'pool',
    };
  }

  if (task.executor_hint === 'ide') {
    const ide = Object.entries(registry).find(([, v]) => v.kind === 'ide');
    if (ide) return { agent: ide[0], reason: 'planner hint', complex, via: 'hint' };
  }
  return { agent: r.default, reason: 'default', complex, via: 'default' };
}

/**
 * Who runs this task when some agents are out of action for the rest of the run.
 *
 * `route` picks stably, which is right until the agent it picks is exhausted.
 * The pick is stable, not exclusive — the routing screen prints "(shared with
 * agy)" precisely because the whole pool is eligible — but nothing ever
 * consulted the rest of the pool, so one agent's quota took the run down with
 * it.
 *
 * Measured on 2026-08-15, through the real screen: 4 ready jobs, all four
 * hashed to copilot, copilot returned QUOTA on the first one, and the run ended
 * 38 seconds in with `0 committed` while agy, opencode and antigravity sat
 * healthy and idle. copilot's quota resets on 2026-09-01 — so every scheduled
 * run for the following 16 days would have done exactly the same thing.
 *
 * The fallback stays INSIDE the pool for the task's size. An agent that is not
 * trusted with work of this size does not become trusted because a different
 * one ran out — and a task pinned by an explicit `rules:` entry is pinned by
 * the operator, so it waits rather than going somewhere they did not choose.
 *
 * Returns null when nothing eligible is left, which is the run's signal to stop.
 */
export function reroute(cfg: AppConfig, task: TaskRow, out: ReadonlySet<string>): string | null {
  const first = route(cfg, task);
  if (!out.has(first.agent)) return first.agent;

  if (first.via !== 'pool') return null; // pinned by a rule, a hint or the default

  const alive = poolFor(cfg, first.complex)
    .filter((a) => !out.has(a) && cfg.drivers.agents.registry[a]);
  return alive.length > 0 ? pickFromPool(alive, task.id) : null;
}

/** Back-compat helper for callers that only need the agent id. */
export function pickAgent(cfg: AppConfig, task: TaskRow): string {
  return route(cfg, task).agent;
}
