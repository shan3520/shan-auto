import type { AppConfig } from '../config.js';
import type { Repo, TaskRow } from '../schemas.js';
import * as ledger from '../ledger.js';
import { log } from '../logger.js';

/**
 * How many of the day's commits one repo may claim before the rest of the budget
 * is shared out.
 *
 * Derived from `weight` so a repo still needs only one number: its slice of the
 * ceiling is its slice of the total weight. `max_daily_commits` on the repo
 * overrides that when a project's share genuinely differs from its scheduling
 * priority, and is itself clamped to the global ceiling — no per-repo setting
 * may raise the outer bound.
 *
 * Rounded UP, so the shares deliberately sum to a little more than the ceiling.
 * Rounding down leaves a remainder no repo is allowed to spend, which would make
 * the day end below target for no reason; the global ceiling, checked here and
 * again in runBatch, is what actually bounds the day.
 *
 * With one repo the share is the whole ceiling, so single-repo behaviour is
 * exactly what it was before shares existed.
 */
function dailyShare(cfg: AppConfig, repo: Repo): number {
  const ceiling = cfg.system.max_daily_commits;
  if (repo.max_daily_commits !== undefined) return Math.min(repo.max_daily_commits, ceiling);

  const total = cfg.repos.reduce((n, r) => n + r.weight, 0);
  if (total <= 0) return ceiling; // no weights to divide by; the ceiling is the only limit
  return Math.min(ceiling, Math.max(1, Math.ceil((ceiling * repo.weight) / total)));
}

/**
 * Pick today's batch. Weighted round-robin across repos so a single noisy project
 * cannot eat the whole day, and so the contribution spread looks like what it is:
 * someone moving several projects forward a little.
 *
 * The draw order alone was not enough. Weight decided who got asked first, not
 * how much anyone was entitled to, and `runBatch` re-selects each time its queue
 * drains — so a repo with a deep backlog was simply asked again, and again. On
 * 2026-08-08 example-api (weight 3) took all 16 commits and shanauto (weight 1) took
 * none. Each repo now also carries a share of the ceiling, counted against what
 * it has ALREADY committed today so it survives those refills.
 */
export function selectBatch(cfg: AppConfig): TaskRow[] {
  const already = ledger.committedToday();
  const ceiling = cfg.system.max_daily_commits;
  const target = Math.min(cfg.system.daily_target + cfg.system.overselect, ceiling - already);

  if (target <= 0) {
    log.warn(`Daily ceiling reached (${already}/${ceiling}). Nothing more will be committed today.`);
    return [];
  }

  const byRepo = new Map<string, TaskRow[]>();
  for (const repo of cfg.repos) {
    const ready = ledger.readyTasks(repo.id);
    if (ready.length) byRepo.set(repo.id, ready);
  }
  if (byRepo.size === 0) return [];

  // Build a weighted draw order: a repo with weight 3 appears 3x per round.
  const order: string[] = [];
  for (const repo of cfg.repos) {
    if (!byRepo.has(repo.id)) continue;
    for (let i = 0; i < repo.weight; i++) order.push(repo.id);
  }

  // What is left of each repo's share after today's commits so far.
  const spent = ledger.committedTodayByRepo();
  const room = new Map<string, number>();
  for (const repo of cfg.repos) {
    if (!byRepo.has(repo.id)) continue;
    room.set(repo.id, Math.max(0, dailyShare(cfg, repo) - (spent[repo.id] ?? 0)));
  }

  const batch: TaskRow[] = [];

  /** One weighted sweep, stopping at `target`. `capped` also honours the shares. */
  const draw = (capped: boolean): void => {
    let guard = 0;
    while (batch.length < target && guard++ < target * 10) {
      let progressed = false;
      for (const repoId of order) {
        if (batch.length >= target) break;
        const queue = byRepo.get(repoId);
        if (!queue?.length) continue;
        if (capped) {
          const left = room.get(repoId) ?? 0;
          if (left <= 0) continue;
          room.set(repoId, left - 1);
        }
        batch.push(queue.shift()!);
        progressed = true;
      }
      if (!progressed) break;
    }
  };

  draw(true);

  /*
   * Second sweep, ignoring the shares but still inside the global ceiling.
   *
   * A share is a floor to protect, not a quota to burn: if the repos with room
   * left have nothing ready, the day should carry on with whoever does rather
   * than going quiet with hours of window left. Without this, a capped repo and
   * an empty sibling would starve `runBatch`'s refill of anything to queue and
   * end the run early — the same shape as the 2026-08-06 freeze, arrived at from
   * the other direction.
   */
  if (batch.length < target) draw(false);

  log.info(
    `Selected ${batch.length} task(s) for today (target ${cfg.system.daily_target}, already committed ${already})`,
  );
  return batch;
}
