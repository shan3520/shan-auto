import { p, reportsDir, type AppConfig } from '../config.js';
import { join } from 'node:path';
import * as ledger from '../ledger.js';
import { log } from '../logger.js';
import { today, writeFileSafe, generateSparklineSvg } from '../util.js';
import { runwayDays } from './planner.js';
import { pickAgent } from './router.js';
import { dailyBudget } from './budget.js';
import { checkContributions, needsAttention, summariseContributions } from './github.js';
import { netFailed, type RunSummary } from './executor.js';
import type { TaskRow } from '../schemas.js';

/**
 * Push a phone notification via ntfy.sh, best-effort.
 *
 * §9.6: an unauthenticated topic on ntfy.sh is PUBLIC — anyone who guesses the
 * topic can read every message ever posted to it. The audit objected that
 * failure bodies (raw error text, up to 300 chars) were posted to exactly that.
 * The rule: the body ships only with an NTFY_TOKEN (an access token for the
 * topic, which makes it private); an unauthenticated notification carries the
 * title alone. The title already carries the useful count (`ShanAuto 3/30`),
 * which is enough to get a person to a screen.
 */
export async function notify(title: string, body: string): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const token = process.env.NTFY_TOKEN;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: token ? { Title: title, Authorization: `Bearer ${token}` } : { Title: title },
      body: token ? body : undefined,
    });
  } catch {
    /* notifications are best-effort */
  }
}

export async function writeReport(cfg: AppConfig, sum: RunSummary): Promise<string> {
  const commits = ledger.todaysCommits();
  const failures = ledger.recentFailures(15);
  const counts = ledger.countByStatus();
  // Against the ledger's whole-day total, not this run's — GitHub's number is
  // also a whole-day total, and comparing one run to a day invents a gap.
  const gh = await checkContributions(commits.length);
  const dailyCounts = ledger.getDailyCommitCounts();
  const budget = dailyBudget(cfg);

  const byRepo = new Map<string, number>();
  for (const c of commits) byRepo.set(c.repo, (byRepo.get(c.repo) ?? 0) + 1);

  const lines: string[] = [
    `# ShanAuto - ${today()}`,
    ``,
    `**Committed: ${sum.committed}** / target ${cfg.system.daily_target}` +
      (gh.snapshot.recorded !== null
        ? `  ·  GitHub recorded ${gh.snapshot.recorded} contribution(s) today`
        : ''),
    ``,
    `| metric | value |`,
    `|---|---|`,
    `| attempted | ${sum.attempted} |`,
    `| committed | ${sum.committed} |`,
    `| failed | ${netFailed(sum)} |`,
    // Beside `failed`, not inside it: these did not land on that attempt and did
    // land later, so counting them as failures makes a run that worked read as a
    // run that half worked. Kept in the table even at zero — a rework that the
    // retry fixed is the loop doing its job, and it should be visible doing it.
    `| ...sent back and retried | ${sum.sentBack} |`,
    // Inside `failed`, not beside it: these are failures with a known, cheap
    // cause. Kept in the table even at zero so its absence is informative.
    `| ...of those, blocked by a tool permission | ${sum.blocked} |`,
    `| dropped (already done) | ${sum.dropped} |`,
    `| superseded_parked | ${sum.parked} |`,
    // One avoided dispatch is one provider request not spent. This is the whole
    // return on the staleness check, so it belongs in the daily numbers.
    `| provider_requests_saved | ${sum.parked} |`,
    `| handed off | ${sum.handoff} |`,
    // Quota is the binding constraint on this whole system, so what the day
    // actually cost belongs in the day's numbers rather than in a log line.
    `| agent spend | ${budget.line} |`,
    `| stopped because | ${sum.stopped ?? 'batch exhausted'} |`,
    `| backlog ready | ${counts.ready ?? 0} |`,
    `| backlog pending | ${counts.pending ?? 0} |`,
    `| runway | ${runwayCell(cfg, sum)} |`,
    `| velocity | ${ledger.getRecentVelocity().toFixed(1)} commits/day over 7 days |`,
    ``,
  ];

  /*
   * The point of the whole system is contributions, and until now the report
   * could only ever show its own commit count back to itself. On 08-06/08-07
   * ~98 commits were pushed while GitHub recorded 52 then 46, and no report said
   * so. This section is the only place the two numbers meet.
   */
  lines.push(
    `## Contributions`,
    ``,
    `| source | ${today()} |`,
    `|---|---|`,
    `| ledger (commits it believes it made) | ${commits.length} |`,
    `| GitHub (contributions actually recorded) | ` +
      `${gh.snapshot.recorded ?? 'unverified'}` +
      `${gh.snapshot.login ? ` for ${gh.snapshot.login}` : ''} |`,
    ``,
  );

  if (gh.verdict === 'unverified') {
    lines.push(
      `> Could not check: ${gh.snapshot.skipped}`,
      `> This is reporting only — nothing about the run depends on it.`,
      ``,
    );
  } else if (gh.verdict === 'agree') {
    lines.push(`The ledger and GitHub agree.`, ``);
  } else if (needsAttention(gh)) {
    lines.push(`**The ledger and GitHub disagree — GitHub counted fewer.**`, ``);
  } else {
    /*
     * The same false alarm the one-line summary used to print, in this
     * document's own words. GitHub counting MORE is the ordinary state of any
     * day the owner also did their own work; it is not a discrepancy and must
     * not be bolded like one. Measured 2026-08-30: ledger 6, GitHub 8, every
     * commit verified present on origin/main with nothing unpushed.
     */
    lines.push(
      `Every commit arrived. GitHub counted more, which is work done outside ` +
        `ShanAuto — issues, reviews, or anything committed by hand.`,
      ``,
    );
  }

  for (const note of gh.notes) lines.push(`> ${note}`, `>`);
  if (gh.notes.length) lines.push(``);

  // Trend line, so a slow drift downwards is visible without reading the table.
  const trend = denseDaily(dailyCounts, 14);
  if (trend.length >= 2) {
    lines.push(`## Trend`, ``, sparklineSvg(trend.map((d) => d.count)), ``);
  }

  if (byRepo.size) {
    lines.push(`## Spread`, ``);
    for (const [repo, n] of [...byRepo].sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${repo}**: ${n}`);
    }
    lines.push(``);
  }

  if (commits.length) {
    lines.push(`## Landed`, ``);
    for (const c of commits) {
      lines.push(`- \`${(c.commit_sha ?? '').slice(0, 8)}\` **${c.kind}** ${c.title}  _(${c.repo})_`);
    }
    lines.push(``);
  }

  if (sum.handoff) {
    lines.push(
      `## Waiting on you`,
      ``,
      `These were routed to a supervised agent and need you to finish them:`,
      ``,
    );
    for (const t of ledger.handoffTasks()) {
      lines.push(`- \`${t.id}\` ${t.title} — ${t.last_error ?? ''}`);
    }
    lines.push(``);
  }

  /*
   * Before the task-level sections, because it answers a bigger question than
   * they do: those say which JOBS did not land, and this says whether the WORK
   * is still moving. A reader who stops after one section should have read this
   * one.
   */
  lines.push(...milestonesSection(ledger.stuckMilestones()));
  lines.push(...problemsSection(sum));
  lines.push(...staleFailuresSection(failures, sum));
  lines.push(...breakingNote(sum));
  lines.push(...testsOnlyNote(sum));
  lines.push(...blockedNote(sum));
  lines.push(...agentOutNote(sum));
  lines.push(...heldNote(sum));
  lines.push(...stashNote(sum));

  if (sum.parked > 0) {
    lines.push(
      `> **${sum.parked} task(s) parked before dispatch** — the work had already landed,`,
      `> so no provider request was spent finding out. Recover any of them with`,
      `> \`npm run sa -- retry --failed\`, or \`sa recall "<query>"\` to see why.`,
      ``,
    );
  }

  if (budget.over) {
    lines.push(
      `> **Agent spend is over the soft budget** — ${budget.line}. Nothing was`,
      `> stopped and no commit was blocked; this is a warning, not a ceiling.`,
      `> Adjust it in \`config/system.yaml\` under \`budget.daily_agent_units\`,`,
      `> where 0 means unlimited.`,
      ``,
    );
  }

  if (sum.dropped >= 3) {
    lines.push(
      `> **Planning signal:** ${sum.dropped} task(s) were already implemented. The`,
      `> decomposer is proposing work that exists. Check that the milestone detail`,
      `> is still accurate, or let the current milestone finish before planning more.`,
      ``,
    );
  }

  if (trend.length) {
    lines.push(`## Daily Commits`, ``);
    for (const d of trend) {
      lines.push(`- **${d.date}**: ${d.count}`);
    }
    lines.push(``);
  }

  const md = lines.join('\n');
  const file = join(reportsDir(), `${today()}.md`);
  writeFileSafe(file, md);
  log.info(`Report written: ${file}`);
  log.info(summariseContributions(gh));

  // Keep the spreadsheet-friendly dump alongside the markdown.
  ledger.exportLedgerToCsv();

  if (cfg.system.notify.on_run_complete) {
    await notify(
      `ShanAuto ${sum.committed}/${cfg.system.daily_target}`,
      `${sum.committed} committed, ${netFailed(sum)} failed, ${runwayDays(cfg)}d runway left.`,
    );
  }
  return file;
}

/**
 * Whether the day ENDED or STOPPED, which the numbers above cannot say.
 *
 * O29. Every figure in this report is task-level — committed, failed, dropped,
 * backlog, runway — and a run whose every milestone is blocked prints
 * `1 committed, backlog ready 0, runway ~0 day(s)`, which is character for
 * character what a run with nothing left to do prints. Run 25 printed exactly
 * that over three stalled milestones. `sa status` has said the difference since
 * the milestone stall was fixed; this document has not, and this document is
 * what gets read when nobody is watching — which is the case the whole system
 * exists for.
 *
 * Written to be read in that state: half asleep, one screen, wanting to know
 * whether anything is wrong before deciding whether to care. So it leads with
 * the answer, and only then lists what is behind it.
 */
export function milestonesSection(
  rows: ledger.StuckMilestone[],
  replanLimit = ledger.MILESTONE_AUTO_REPLANS,
): string[] {
  const { blocked, done, alreadyBuilt, unplanned } = ledger.partitionStuck(rows);
  // Split on the one question that decides whether this is the operator's
  // problem: is anything still going to try? Same rule as the status screen.
  const waiting = blocked.filter((m) => (m.replans ?? 0) < replanLimit);
  const exhausted = blocked.filter((m) => (m.replans ?? 0) >= replanLimit);

  const out: string[] = [`## Where the work stands`, ``];

  if (exhausted.length) {
    out.push(
      `**${exhausted.length} piece(s) of work have stopped and nothing will pick ` +
        `them up.** Every automatic re-plan is used up.`,
      ``,
    );
    /*
     * Said in the same breath, not left to be inferred from a list heading
     * further down. A day with one stranded milestone and nine recoverable ones
     * is a day that needs the operator for ONE thing, and a headline that
     * mentions only the bad news reads as though all ten are theirs.
     */
    if (waiting.length) {
      out.push(
        `The other ${waiting.length} stopped too, but the next run will plan ` +
          `them again by itself.`,
        ``,
      );
    }
  } else if (waiting.length) {
    out.push(
      `${waiting.length} piece(s) of work stopped, and the next run will plan ` +
        `them again by itself. Nothing to do.`,
      ``,
    );
  } else if (done.length || unplanned.length === 0) {
    out.push(`Nothing is stuck.`, ``);
  }

  const list = (title: string, ms: ledger.StuckMilestone[], why: boolean) => {
    if (!ms.length) return;
    out.push(`**${title}**`, ``);
    for (const m of ms.slice(0, 10)) {
      out.push(`- ${m.title}  _(${m.repo})_`);
      if (!why) continue;
      // The reason, not the id: the id is for a command the operator should
      // not have to run, and the reason is what tells them whether to care.
      const first = (m.last_error ?? '').split('\n').find((l) => l.trim());
      if (first) out.push(`  - ${first.trim().slice(0, 160)}`);
    }
    if (ms.length > 10) out.push(`- _(${ms.length - 10} more)_`);
    out.push(``);
  };

  list('Stopped, and out of automatic retries', exhausted, true);
  list('Stopped, being planned again on the next run', waiting, true);
  list('Reported already built — nothing was queued', alreadyBuilt, true);
  if (done.length) out.push(`**Finished:** ${done.length}`, ``);

  return out;
}

/**
 * Fill in the days nothing was committed.
 *
 * `getDailyCommitCounts` groups committed tasks by day, so a day with no
 * commits produces no row at all — it does not appear as a zero, it simply is
 * not there. The trend line is drawn from those rows and exists, by its own
 * comment, so that "a slow drift downwards is visible without reading the
 * table". It could not show one: on 2026-08-12 and 2026-08-13 it rendered a
 * byte-identical sparkline, because 08-13 committed nothing and so contributed
 * no point. The graph skipped the day it most needed to draw.
 *
 * A fixed calendar window also bounds the Daily Commits list, which printed
 * every day since the ledger began.
 */
export function denseDaily(
  rows: { date: string; count: number }[],
  days: number,
  endDate = today(),
): { date: string; count: number }[] {
  const have = new Map(rows.map((r) => [r.date, r.count]));
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return rows.slice(-days);

  const out: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: have.get(key) ?? 0 });
  }
  return out;
}

/**
 * What THIS run did, from the run itself.
 *
 * A retryable failure sets the task back to `ready`, which no later query can
 * tell apart from a task that has never run — so the ledger cannot answer "what
 * went wrong today", and was never the right place to ask. On 2026-08-13 this
 * section was built from `recentFailures` alone: the table said `failed | 8`,
 * the list showed four, and all four had failed on earlier days. None of the six
 * copilot quota failures that had just happened appeared anywhere.
 */
export function problemsSection(sum: RunSummary): string[] {
  if (!sum.problems.length) return [];
  const lines = [`## What went wrong in this run`, ``];
  for (const pr of sum.problems) {
    // The distinction that matters: one of these needs you, the other does not.
    const tail = pr.retrying ? ' _(will retry)_' : ' _(no attempts left)_';
    lines.push(`- \`${pr.id}\` ${pr.title}${tail}`, `  - ${pr.why.split('\n')[0]?.slice(0, 200)}`);
  }
  lines.push(``);
  return lines;
}

/**
 * Failures still outstanding from previous days — kept separate, and dated.
 *
 * `recentFailures` has no date filter, so these used to be printed under a
 * heading that read as today's news. Trcg4dbivgj and Tgzn7fnkffd failed on
 * 08-09 and were reported as fresh on 08-12 and again on 08-13. Anything this
 * run already spoke about is dropped, so a task cannot appear twice in one
 * report saying two different things.
 */
export function staleFailuresSection(failures: TaskRow[], sum: RunSummary): string[] {
  const stale = failures.filter(
    (f) => f.status === 'failed' && !sum.problems.some((p) => p.id === f.id),
  );
  if (!stale.length) return [];
  const lines = [`## Still failed from earlier runs`, ``];
  for (const f of stale) {
    const when = (f.updated_at ?? '').slice(0, 10);
    lines.push(
      `- \`${f.id}\` ${f.title}${when ? ` _(last tried ${when})_` : ''}`,
      `  - ${(f.last_error ?? '').split('\n')[0]?.slice(0, 200)}`,
    );
  }
  lines.push(``);
  return lines;
}

/**
 * Runway, with the part of the backlog no live agent can reach called out.
 *
 * `runwayDays` divides reachable backlog by the daily target. It never asks
 * whether the provider that would run that backlog is alive, and the ledger has
 * no column that would let it: routing is computed, not stored. So on a day when
 * copilot is out until the monthly reset, the tasks routed to copilot count
 * towards runway exactly as if they were about to be worked on — on 2026-08-13
 * that was five of the seven next up.
 *
 * That makes the number worse than no number. `runway ~0.2 day(s)` reads as
 * "nearly out of work, go write more tasks" when the truth is "there is plenty
 * of work and most of it is behind a dead provider" — the opposite instruction.
 * Rather than change what runway means, name the stranded share beside it.
 */
export function runwayCell(cfg: AppConfig, sum: RunSummary): string {
  const base = `~${runwayDays(cfg)} day(s)`;
  if (!sum.agentsOut.length) return base;
  const out = new Set(sum.agentsOut.map((a) => a.agent));
  const ready = ledger.readyTasks();
  const stranded = ready.filter((t) => out.has(pickAgent(cfg, t))).length;
  const who = [...out].join(', ');
  if (!stranded) return `${base} · none of it needs ${who}`;
  return `${base} · but ${stranded} of ${ready.length} ready task(s) route to ${who}, which is out`;
}

/**
 * The exhausted-provider callout.
 *
 * On 2026-08-12 copilot's monthly allowance ran out and six tasks were
 * dispatched into it anyway, each recorded as `agent failed: EXIT_1` — a
 * sentence that describes a broken agent rather than an empty quota, and sent
 * the search in the wrong direction entirely. What the operator needs is which
 * provider is out and when it comes back, and neither fact appears anywhere in
 * a failure count.
 *
 * There is deliberately no action to take: these tasks were left `ready` with
 * their attempts intact, so the next run after the reset picks them up by
 * itself. Saying so is the point — otherwise the queue looks stuck.
 */
export function agentOutNote(sum: RunSummary): string[] {
  if (!sum.agentsOut.length) return [];
  const lines: string[] = [];
  for (const a of sum.agentsOut) {
    const held = a.skipped
      ? `${a.skipped} further task(s) were left untouched rather than spent against it.`
      : `No further work was routed to it.`;
    lines.push(
      `> **${a.agent} went out mid-run.** ${a.why.slice(0, 200)}`,
      `> ${held} They are still \`ready\` with their attempts intact, so the next`,
      `> run picks them up with nothing to do by hand.`,
      ``,
    );
  }
  return lines;
}

/**
 * The withheld-work callout.
 *
 * A project whose own check is failing gets one job — repair it — and the rest
 * of its queue waits, because nothing else could pass the gate. That is correct,
 * and it used to happen in total silence: the 2026-08-12 report said `attempted
 * 1 · committed 1 · stopped because: batch exhausted` two lines above `backlog
 * ready: 8`. Read plainly, that says the system ran out of work while eight jobs
 * sat waiting. The eight were being withheld and nothing said so.
 *
 * Like the agent-out note, there is nothing to do by hand: the repair job is
 * already queued, and the run releases the rest the moment it lands.
 */
export function heldNote(sum: RunSummary): string[] {
  if (!sum.held.length) return [];
  const total = sum.held.reduce((n, h) => n + h.count, 0);
  const where = sum.held.map((h) => `${h.repo} (${h.count})`).join(', ');
  return [
    `> **${total} job(s) were held back, not skipped.** Their project's own check`,
    `> is failing, so the gate would reject every one of them. Waiting on: ${where}.`,
    `> A repair job for each is already queued and runs first; the rest are`,
    `> released as soon as it passes. Nothing to do by hand.`,
    ``,
  ];
}

/**
 * The set-aside-work callout.
 *
 * Unlike every other note here, this one has something for the owner to DO, and
 * that is why it exists. `ensureClean` sweeps a dirty tree before a task starts
 * and `rollback` copies an agent's work aside before reverting it; both preserve
 * rather than delete, and both then say so exactly once, in a log line, in a run
 * the owner was not watching. Nothing afterwards ever mentions it again.
 *
 * On 2026-08-15 example-api held eleven such stashes going back a week. One of them
 * had two of the owner's own untracked scripts in it, swept on 08-12. Preserved
 * perfectly, and effectively lost — nobody knew where they went.
 *
 * The exact recovery command is printed because the owner does not use git by
 * hand, and "recoverable in principle" is not recovery.
 */
export function stashNote(sum: RunSummary): string[] {
  if (!sum.stashes.length) return [];
  const lines: string[] = [];
  for (const s of sum.stashes) {
    const what = s.files.length ? `Includes: ${s.files.map((f) => `\`${f}\``).join(', ')}.` : '';
    lines.push(
      `> **${s.count} set-aside change(s) are waiting in ${s.repo}**, the oldest from ${s.oldest}.`,
      `> ShanAuto moves anything it finds in the way into a git stash instead of`,
      `> deleting it — an unfinished edit of yours, or an agent's work it rolled`,
      `> back. Nothing is lost, but nothing gives it back either. ${what}`.trimEnd(),
      `> See them: \`git -C ${s.path} stash list\``,
      `> Restore the newest: \`git -C ${s.path} stash pop\``,
    );
    /*
     * O24. The count and the file list said a pile existed; nothing said what
     * was in it. Every entry in example-api's 38 was `shanauto-rollback
     * <timestamp>` and nothing else, so "restore the newest" was a coin toss
     * over which rejected task you got back — and one of them was run 21's real
     * fix for the global-slice bug, found only by reading diffs.
     *
     * Labels carry the task and the verdict now, so the newest few are worth
     * printing: the point of the list is choosing WHICH to restore.
     */
    if (s.recent?.length) {
      lines.push(`>`, `> The most recent:`);
      for (const e of s.recent) {
        lines.push(`> - \`${e.ref}\` ${e.when} — ${e.label}`);
      }
      lines.push(`> Restore one by name: \`git -C ${s.path} stash pop <ref>\``);
    }
    lines.push(``);
  }
  return lines;
}

/**
 * The blocked-agent callout.
 *
 * On 2026-08-08 this report showed 17 failures whose stated cause was
 * `NO_CHANGES: agent produced no file changes`, and two debugging rounds went
 * into the agent before anyone looked at the permission list. The report is
 * where that search starts, so it is where the real cause has to be printed —
 * with the refused command named, because that is the whole fix.
 */
/**
 * Contract changes that shipped, as a plain statement of fact.
 *
 * Not a warning and not framed as one. Every one of these was declared in the
 * plan before the work started and passed the repo's own check afterwards; the
 * report's job is to make sure the operator sees, in one place, that something
 * which used to work differently now works this way. A run's other output does
 * not do that - the plan scrolls past, and a commit subject is 72 characters.
 */
export function breakingNote(sum: RunSummary): string[] {
  if (!sum.breakingShipped.length) return [];
  return [
    `> **${sum.breakingShipped.length} change(s) to existing behaviour shipped.** Each was declared`,
    `> in the plan and passed the repo's own check, so nothing here went wrong -`,
    `> but anything already calling these will need to change too.`,
    ``,
    ...sum.breakingShipped.map((b) => `> - **${b.id}** ${b.title} — ${b.what}`),
    ``,
  ];
}

/**
 * Work that shipped without changing anything that runs.
 *
 * The counterpart to breakingNote, and it exists for the same reason: the
 * operator's report is where a run's claims are read, so it is where a claim
 * that did not come true has to be withdrawn out loud. Run 22 committed one
 * test file under a title promising a behaviour change, closed the milestone it
 * belonged to, and reported an empty backlog — three separate ways of saying
 * "your idea is done" over a bug that was still there.
 *
 * Not framed as a failure, because it usually is not one. A junior that finds
 * the work already done and leaves a test behind has done the best thing
 * available to it. What the operator needs is the chance to notice that the
 * task and the diff do not match.
 */
export function testsOnlyNote(sum: RunSummary): string[] {
  if (!sum.testsOnlyShipped.length) return [];
  const lines = [
    `> **${sum.testsOnlyShipped.length} task(s) shipped tests and nothing else.** The commit`,
    `> added or changed test files only, so nothing this project does at runtime`,
    `> is different. Usually that means the work was already done and the task`,
    `> proved it - but it also happens when a task was aimed at the wrong file,`,
    `> and the milestone closes either way. Worth one look each.`,
    ``,
    ...sum.testsOnlyShipped.map((t) => `> - **${t.id}** ${t.title}`),
    ``,
  ];
  const predicted = sum.testsOnlyShipped.filter((t) => t.predicted);
  if (predicted.length)
    lines.push(
      `> ${predicted.length} of those were planned as a change to existing behaviour.`,
      `> That did not happen, so no BREAKING CHANGE was recorded against them.`,
      ``,
    );
  return lines;
}

export function blockedNote(sum: RunSummary): string[] {
  /*
   * Shipped-despite-a-denial comes first and stands on its own. It is not an
   * explanation of a failure - there is no failure - so folding it into the
   * paragraph below would put a committed task under a heading that says the
   * agent wrote nothing.
   */
  const shipped = sum.blockedShipped.flatMap((b) => [
    /*
     * Every name, not the first. Run 17 denied one task two things and the
     * report named one of them, directly above a sentence telling the operator
     * to allow "that exact command form" - so allowing what it named would have
     * left the other refusal in place and unmentioned.
     */
    b.permissions.length
      ? `> **${b.id} was denied ${b.permissions.map((p) => `\`${p}\``).join(' and ')} and shipped anyway.** ${b.title}.`
      : `> **${b.id} was denied a tool permission and shipped anyway.** ${b.title}.`,
    `> The repo's own check passed and the change is pushed, so this is not a`,
    `> failure - but the agent worked around a refusal to get there. Allow`,
    // Agrees in number with the list above it. One denial is the ordinary
    // case and read "those exact command forms" until run 18. An empty
    // list reads singular too: the line above it says "a tool permission".
    b.permissions.length > 1
      ? `> those exact command forms if it should have had them, or read the archived`
      : `> that exact command form if it should have had it, or read the archived`,
    `> output to see what it did instead.`,
    ``,
  ]);
  if (!sum.blocked) return shipped;
  const lines = [
    ...shipped,
    `> **${sum.blocked} task(s) were BLOCKED, not lazy.** The agent asked for a tool`,
    `> permission and was denied, so it wrote nothing and the gate saw no changes.`,
  ];
  /*
   * The advice used to be "Allow-list it" in both cases, printed verbatim on
   * 2026-08-13 directly after the sentence saying the driver could not name what
   * was refused. There is nothing to allow-list when nothing was named, and
   * telling the operator to go and do it anyway sent two debugging rounds into
   * a permission file that was not the problem — the agent had been sent to a
   * path that did not exist and was improvising commands to find it.
   *
   * agy also matches permissions token-for-token with no prefix matching, so
   * even a named refusal only ever buys the exact command form it names.
   */
  if (sum.blockedBy.length) {
    lines.push(
      `> Refused: ${sum.blockedBy.map((b) => `\`${b}\``).join(', ')}. Add that exact`,
      `> command form to the agent's allow-list — matching is exact, so a close`,
      `> variant will be refused too — then \`npm run sa -- retry --failed\`.`,
    );
  } else {
    lines.push(
      `> **The driver could not name what was refused**, so there is nothing to`,
      `> allow-list yet. Read the archived agent output for the task above to see`,
      `> what it actually tried; a refusal to enumerate a directory usually means`,
      `> the task was planned against a path the repo does not have.`,
    );
  }
  lines.push(``);
  return lines;
}

/**
 * Seven-day rollup, computed from the ledger.
 *
 * Was previously a `JSON.stringify` wrapper taking `{ [key: string]: any }` and
 * writing it to a `.json` file while calling the variable `md` — nothing built the
 * object, so nothing ever called it. Rewritten to earn its name: it reads the
 * ledger itself and emits markdown.
 */
export function writeWeeklyReport(): string {
  const daily = ledger.getDailyCommitCounts().slice(-7);
  const velocity = ledger.getRecentVelocity();
  const counts = ledger.countByStatus();
  const total = daily.reduce((n, d) => n + d.count, 0);
  const best = daily.reduce<{ date: string; count: number } | null>(
    (b, d) => (b === null || d.count > b.count ? d : b),
    null,
  );

  const lines = [
    `# ShanAuto — week to ${today()}`,
    ``,
    `**${total} commit(s) over the last ${daily.length} active day(s)**`,
    // getRecentVelocity always divides by 7, so say so — "4.6/day average" next to
    // "over 1 active day" reads as a contradiction otherwise.
    `· ${velocity.toFixed(1)}/day averaged across the full 7 days` +
      ` · best day ${best ? `${best.count} on ${best.date}` : 'n/a'}`,
    ``,
    sparklineSvg(daily.map((d) => d.count)),
    ``,
    `| day | commits |`,
    `|---|---|`,
    ...daily.map((d) => `| ${d.date} | ${d.count} |`),
    ``,
    `| backlog | count |`,
    `|---|---|`,
    ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`),
    ``,
  ];

  const file = join(reportsDir(), `weekly-${today()}.md`);
  writeFileSafe(file, lines.join('\n'));
  log.info(`Weekly report written: ${file}`);
  return file;
}

/**
 * Wraps the bare SVG path from `generateSparklineSvg` into an element markdown
 * will actually render. The helper returns only `M … L …` path commands, which
 * on its own displays as nothing.
 */
function sparklineSvg(counts: number[], width = 320, height = 40): string {
  if (counts.length < 2) return '_(not enough history for a trend yet)_';
  const path = generateSparklineSvg(counts, width, height);
  if (!path) return '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="commits per day" overflow="visible">` +
    `<defs><linearGradient id="spark" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0%" stop-color="#10b981" />` +
    `<stop offset="100%" stop-color="#3b82f6" />` +
    `</linearGradient></defs>` +
    `<path d="${path}" fill="none" stroke="url(#spark)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />` +
    `</svg>`
  );
}
