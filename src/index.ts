#!/usr/bin/env node
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execa } from 'execa';
import { join } from 'node:path';
import { loadConfig, p, reportsDir, resolveRepo, ROOT, stateRoot, missingRepos, type AppConfig } from './config.js';
import { log, setRunId } from './logger.js';
import * as ledger from './ledger.js';
import * as git from './git.js';
import { makeBrain, makeChat, makeAgent, agentIds } from './drivers/registry.js';
import { agySettingsPath } from './drivers/agent.agy.js';
import { parseInbox, archiveInbox, shapeIdea, refillBacklog, planNextMilestone, runwayDays } from './core/planner.js';
import { selectBatch } from './core/allocator.js';
import { route } from './core/router.js';
import { resolveCommitFiles, resolveStatusError } from './core/resolve.js';
import { netFailed, runBatch } from './core/executor.js';
import { baselineGreen } from './core/verifier.js';
import { ensureRepairTask, holdBlockedWork, isRepairTask } from './core/repair.js';
import { checkAcceptance, shortfallReason } from './core/accept.js';
import { stackById, suggestedGate, STACKS, detectStacks, phantomStacks } from './core/stacks.js';
import {
  scaffold,
  registerRepo,
  validateId,
  checkTarget,
  tightenGate,
  publishProject,
} from './core/scaffold.js';
import { writeReport, notify } from './core/reporter.js';
import { dailyBudget } from './core/budget.js';
import { checkContributions, needsAttention, summariseContributions } from './core/github.js';
import { ensureDir, withinWorkHours, clip} from './util.js';

/**
 * The pause file.
 *
 * Overridable so a test can point at its own, instead of writing the OWNER'S.
 * A test used to create the real one and remove it in teardown — meaning any
 * crash, timeout or interrupt between the two left the system PAUSED by a test
 * run, with nothing to say why.
 */
const KILLSWITCH = () => process.env.SHANAUTO_KILLSWITCH ?? join(stateRoot(), 'KILLSWITCH');
const LOCK = () => join(stateRoot(), 'run.lock');

/**
 * PID liveness for the run.lock staleness check (SEC-5).
 * `process.kill(pid, 0)` throws ESRCH when the process is gone and EPERM when it
 * exists but belongs to another user — both distinguishable from "no such pid".
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ doctor */

async function doctor() {
  const cfg = loadConfig();
  let bad = 0;
  const ok = (m: string) => log.info(`  ok    ${m}`);
  const fail = (m: string) => {
    bad++;
    log.error(`  FAIL  ${m}`);
  };
  const warn = (m: string) => log.warn(`  warn  ${m}`);
  const brokenGates: string[] = [];
  const gateUpgrades: string[] = [];

  log.info('config');
  ok(`${cfg.repos.length} repo(s) enabled, target ${cfg.system.daily_target}/day`);

  log.info('repos');
  for (const m of missingRepos) {
    // Not `fail()`: the system still works, this project just cannot be worked
    // on. Said plainly because a silently disabled project looks like a system
    // that has quietly stopped caring about it.
    warn(`${m.id}: switched off — its folder is missing (${m.path})`);
    warn(`      Restore that folder, or remove "${m.id}" from config/repos.yaml.`);
  }
  for (const r of cfg.repos) {
    if (!(await git.isRepo(r))) {
      fail(`${r.id}: ${r.path} is not a git repository`);
      continue;
    }
    const remote = await git.hasRemote(r);
    ok(`${r.id}: git ok, remote ${remote ? 'present' : 'MISSING (commits stay local)'}`);
    // A diagnosis with no cure attached is how this one sat unread for weeks.
    if (!remote) ok(`${' '.repeat(r.id.length)}  put it on GitHub with: npm run sa -- publish ${r.id}`);

    /*
     * Actually run the gate.
     *
     * "Check everything is working" reported on git, the agents and the brain,
     * and never once ran the one command the whole system rests on — so a gate
     * that could not execute at all (a missing pytest, a renamed script, a
     * broken venv) would have been discovered by a task, at commit time, as a
     * VERIFY_FAIL blamed on the agent. And a gate that fails RIGHT NOW is worth
     * saying plainly: it means nothing can be committed until a person fixes the
     * project, which is exactly the news this screen exists to deliver.
     */
    const check = await execa(r.verify_cmd, {
      cwd: r.path,
      shell: true,
      reject: false,
      timeout: cfg.system.timeouts.verify_s * 1000,
      killSignal: 'SIGKILL',
      stdin: 'ignore',
      env: { NO_COLOR: '1', CI: '1' },
      maxBuffer: 8 * 1024 * 1024,
    });
    /*
     * Has this project outgrown its gate?
     *
     * example-api is why. It was given a syntax check on 2026-08-07, correctly —
     * an empty repo has nothing to test. By 2026-08-09 it had 27 tests, three
     * of them FAILING, and the gate had waved every one of them through for
     * days, because nothing ever revisited the decision. A floor chosen for an
     * empty repo silently became a ceiling on a real one.
     *
     * Never applied automatically: tightening a gate can stop all work on a
     * project, and that is the owner's call. Said out loud every time until it
     * is dealt with.
     */
    /*
     * ...and it never fired for example-api at all.
     * `stackById` wants one of the four canonical ids; example-api's config says
     * `python + fastapi + next.js`, which matches none of them, so this returned
     * undefined and the whole check above was skipped in silence — the one repo
     * the comment is about. Fall back to what is on disk, which is the more
     * trustworthy answer anyway, and say so when the declared name is not real.
     */
    const declared = stackById(r.stack);
    const onDisk = detectStacks(r.path);
    const stack = declared ?? onDisk.find((d) => d.at === '')?.stack ?? onDisk[0]?.stack;
    if (!declared) {
      warn(
        `${r.id}: stack "${r.stack}" is not one of ${STACKS.map((s) => s.id).join(', ')}` +
          (stack ? ` — going by what is on disk instead (${stack.label})` : ' — and nothing was recognised on disk'),
      );
    }
    if (stack) {
      const suggestion = suggestedGate(r.path, stack, r.verify_cmd);
      if (suggestion.upgrade) {
        gateUpgrades.push(r.id);
        warn(`${r.id}: ${suggestion.reason}`);
        warn(`      now:     ${r.verify_cmd}`);
        warn(`      suggest: ${suggestion.command}`);
        /*
         * Which of these two is true depends on whether the line has been
         * touched, and saying the wrong one is worse than saying nothing: it
         * either sends the operator to edit YAML they need not open, or lets
         * them wait for a tightening that is never coming because the gate is
         * theirs now. Same condition `run` tightens on — see the loop there.
         */
        warn(
          r.verify_cmd === stack.floor
            ? `      The next run tightens this for you. Nothing to do.`
            : `      This check is yours, so nothing will change it. Edit verify_cmd for "${r.id}" in config/repos.yaml to tighten it.`,
        );
      }
    }

    /*
     * A stack named in config that does not exist on disk is not a harmless
     * typo: it is fed to the planner as fact, and the planner will keep writing
     * work for it forever. Ragforge's phantom `next.js` cost ~6 model calls a
     * pass and produced tasks whose only possible check was "does a file with
     * this name exist". Say it plainly, every run, until it is resolved.
     */
    for (const ghost of phantomStacks(r.path, r.stack)) {
      warn(`${r.id}: config claims "${ghost}", but there is no such project in ${r.path}`);
      warn(`      Nothing here can build or test it, so any work planned for it cannot be verified.`);
      warn(`      Either remove "${ghost}" from the stack line in config/repos.yaml,`);
      warn(`      or have the first task create the project properly — manifest, deps and test command.`);
    }

    if (check.exitCode === 0) {
      ok(`${r.id}: its own check passes — work can be committed`);
    } else {
      const out = `${check.stdout ?? ''}\n${check.stderr ?? ''}`.trim().split('\n');
      brokenGates.push(r.id);
      warn(
        `${r.id}: its own check FAILS, so nothing can be committed to it until that is fixed`,
      );
      warn(`      ${r.verify_cmd}`);
      for (const line of out.slice(-4)) warn(`      ${line}`);
    }
  }

  log.info('agents');
  /*
   * agy's permission file has to be READABLE, not merely present.
   *
   * On 2026-08-10 `agy-access.ps1 -Apply` wrote it through Set-Content
   * -Encoding UTF8 which, in Windows PowerShell 5.1, means UTF-8 WITH a BOM.
   * agy parses the file strictly, so a leading U+FEFF made the whole thing
   * invalid JSON and it loaded NO permissions at all — auto-denying every
   * command. The symptom is identical to a missing allow-rule, which is how it
   * would have survived: the script that grants shell access was silently
   * revoking it, and the only visible effect was agents failing tasks.
   *
   * `agySettingsPath()` is the driver's own answer for where the file lives
   * (honouring SHANAUTO_AGY_SETTINGS), so this check and the driver's pre-flight
   * can never disagree about the path.
   */
  const agySettings = agySettingsPath();
  if (existsSync(agySettings)) {
    try {
      const buf = readFileSync(agySettings);
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        fail(
          `agy's settings.json starts with a byte-order mark, so agy cannot read it ` +
            `and will refuse EVERY command. Re-run scripts/agy-access.ps1 -Apply.`,
        );
      } else {
        const parsed = JSON.parse(buf.toString('utf8')) as {
          permissions?: { allow?: string[]; deny?: string[] };
        };
        const allow = parsed.permissions?.allow?.length ?? 0;
        const deny = parsed.permissions?.deny?.length ?? 0;
        allow > 0
          ? ok(`agy permissions readable (${allow} allowed, ${deny} denied)`)
          : warn(`agy's settings.json has no allow rules — every command will be refused`);

        /*
         * Is each repo's `agent_check_cmd` a command agy will actually accept?
         *
         * agy matches a command word for word — no prefixes, and a `*` does not
         * widen it, it crashes agy (issue #614). So a check command that is one
         * flag out is not "roughly right", it is refused, and headless there is
         * nobody to approve it. The agent then does what it did on 2026-08-15:
         * picks its own command, gets refused, finishes anyway, and hands in
         * code it never ran. The gate catches that and rolls it back, so the
         * only visible symptom is jobs quietly costing double.
         *
         * Checked against the LIVE file, not the template. The template is what
         * would be applied; this is what is in force right now, and they drift.
         */
        const live = new Set(parsed.permissions?.allow ?? []);
        for (const r of cfg.repos) {
          if (!r.agent_check_cmd) continue;
          if (live.has(`command(${r.agent_check_cmd})`)) {
            ok(`${r.id}: the worker may run its own check (${r.agent_check_cmd})`);
          } else {
            warn(
              `${r.id}: the worker's check "${r.agent_check_cmd}" is NOT permitted, so it will ` +
                `be refused and the worker cannot test its own code before handing it in`,
            );
            warn(`      Add exactly  command(${r.agent_check_cmd})  to`);
            warn(`      config/agy-permissions.example.json, then run scripts/agy-access.ps1 -Apply`);
          }
        }
      }
    } catch (e) {
      fail(`agy's settings.json is not valid JSON, so every command is refused: ${(e as Error).message}`);
    }
  }

  for (const id of agentIds(cfg)) {
    const a = await makeAgent(cfg, id);
    const h = await a.healthCheck();
    h.ok ? ok(`${id}: ${h.detail}`) : fail(`${id}: ${h.detail}`);
  }

  log.info('brain');
  try {
    const brain = await makeBrain(cfg);
    // The registry entry's model, not system.yaml's — the entry wins, and
    // reporting the loser told you the brain was on a model it had not used
    // since the driver was switched.
    const entry = cfg.drivers.brain.registry[cfg.drivers.brain.active];
    ok(`${brain.id} reachable (model ${entry?.model || cfg.system.brain.model})`);
    await brain.dispose();
  } catch (e) {
    fail(`brain: ${(e as Error).message}`);
  }

  log.info('ledger');
  const counts = ledger.countByStatus();
  ok(`${JSON.stringify(counts)} — runway ~${runwayDays(cfg)} day(s) of reachable work`);
  const stuck = ledger.deadlockedTaskIds().size;
  if (stuck > 0) {
    log.warn(`  warn  ${stuck} task(s) deadlocked behind a failed dependency. \`sa retry --failed\``);
  }
  // Already-built milestones are excluded: they are not outstanding work, and
  // counting them here would raise a warning whose own advice (`retry --failed`)
  // no longer touches them.
  const unplanned = ledger.partitionStuck(ledger.stuckMilestones()).unplanned.length;
  if (unplanned > 0) {
    log.warn(`  warn  ${unplanned} milestone(s) planned to nothing; work outstanding. \`sa retry --failed\``);
  }

  log.info('github');
  /*
   * Never `fail()`. A contribution gap is the most important thing doctor can
   * tell you and still not a reason to stop the day — the commits are real
   * either way, and reporting must not gate the run.
   */
  const gh = await checkContributions(ledger.todaysCommits().length);
  /*
   * Warned about only when it means something went missing. GitHub counting
   * MORE than the ledger is the ordinary state of any day the owner also did
   * their own work, and warning about it teaches them to ignore this line.
   */
  gh.verdict === 'unverified'
    ? log.warn(`  skip  ${gh.snapshot.skipped}`)
    : log[needsAttention(gh) ? 'warn' : 'info'](
        `  ${needsAttention(gh) ? 'warn ' : 'ok   '} ${summariseContributions(gh)}`,
      );
  for (const note of gh.notes) log.warn(`        ${note}`);

  log.info('guards');
  ok(`work hours ${cfg.system.work_hours.start}-${cfg.system.work_hours.end} (now: ${withinWorkHours(cfg.system.work_hours.start, cfg.system.work_hours.end) ? 'inside' : 'OUTSIDE'})`);
  const paused = existsSync(KILLSWITCH());
  paused ? log.warn('  KILLSWITCH IS ACTIVE — runs will not execute') : ok('killswitch clear');

  /*
   * "All checks passed" must not be printed over a system that cannot run.
   *
   * `bad` is only incremented by a broken repo, agent or brain, so doctor
   * answered "yes, fine" while the killswitch was set, work was deadlocked and
   * milestones had planned to nothing — the exact question a non-technical owner
   * uses this command to ask. These are not failures of a component, so they do
   * not count as `bad`; they do mean the honest headline is different.
   */
  const idle = [
    paused ? 'it is paused and will not run' : '',
    stuck > 0 ? `${stuck} task(s) are stuck` : '',
    unplanned > 0 ? `${unplanned} milestone(s) planned to nothing` : '',
    brokenGates.length
      ? `${brokenGates.join(', ')} cannot accept any work until its own check passes`
      : '',
    gateUpgrades.length
      ? `${gateUpgrades.join(', ')} has tests its check does not run`
      : '',
    missingRepos.length
      ? `${missingRepos.map((m) => m.id).join(', ')} is switched off (folder missing)`
      : '',
  ].filter(Boolean);

  log.info(
    bad > 0
      ? `doctor: ${bad} problem(s)`
      : idle.length
        ? `doctor: everything works, but ${idle.join('; ')}`
        : 'doctor: all checks passed',
  );
  process.exitCode = bad === 0 ? 0 : 1;
}

/* --------------------------------------------------------------- new project */

/**
 * Start a project from nothing.
 *
 * The TUI is the intended way in — this is the same thing for anyone who
 * prefers a terminal, and it is what the TUI's own screen is checked against.
 */
async function newProject(rest: string[]): Promise<void> {
  const id = rest.find((a) => !a.startsWith('--'));
  if (!id) {
    log.error(
      'Usage: sa new <name> [--in <folder>] [--stack <id>] [--no-github] [--purpose "..."]',
    );
    log.info(`Stacks: ${STACKS.map((s) => s.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const bad = validateId(id);
  if (bad) {
    log.error(bad);
    process.exitCode = 1;
    return;
  }

  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  const stack = stackById(flag('stack') ?? 'typescript');
  if (!stack) {
    log.error(`Unknown stack. Try one of: ${STACKS.map((s) => s.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const parent = flag('in') ?? join(ROOT, '..');
  const proj = {
    id,
    path: join(parent, id),
    stack,
    branch: 'main',
    purpose: flag('purpose') ?? '',
  };

  const blocked = checkTarget(proj.path);
  if (blocked) {
    log.error(blocked);
    process.exitCode = 1;
    return;
  }

  /*
   * A remote by default, and `--no-github` to decline one.
   *
   * It was the other way round until 2026-08-27, on the reasoning that creating
   * a repository publishes something under the owner's name. That is true, and
   * it still made the wrong thing the default: the README promises that this
   * system "pushes what survives", and a project born with nowhere to push is
   * that system failing silently at the one thing it promises. example-ledger reached 8 commits of its own work and
   * example-receipts 7, all of it on a single disk, because this flag went unpassed
   * twice.
   *
   * Still private, as createRemote has always made them, and still declinable
   * for a project that genuinely should not leave the machine. What changed is
   * only which of those two an absent-minded invocation gets.
   */
  const result = await scaffold(proj, {
    remote: !rest.includes('--no-github'),
    visibility: 'private',
  });
  registerRepo(proj, result.verify_cmd);

  log.info(`Created ${result.path}`);
  log.info(`  check:  ${result.verify_cmd}`);
  log.info(`  github: ${result.remote ?? 'not created'}`);
  for (const n of result.notes) log.warn(`  ${n}`);
  log.info('Now tell it what to build: `sa tui`, or add an idea to ideas/inbox.md');
}

/**
 * Put an existing project on GitHub.
 *
 * The counterpart to `sa new --github`, for every project that did not get one
 * then. Private unless asked otherwise, for the same reason scaffold is:
 * creating a public repository publishes the owner's work to the internet under
 * their name, and nothing should choose that on someone's behalf.
 */
async function publish(rest: string[]): Promise<void> {
  const id = rest.find((a) => !a.startsWith('--'));
  const cfg = loadConfig();
  const repo = cfg.repos.find((r) => r.id === id);

  if (!repo) {
    log.error(
      id
        ? `No project called "${id}". Known: ${cfg.repos.map((r) => r.id).join(', ')}`
        : 'Usage: sa publish <project> [--public]',
    );
    process.exitCode = 1;
    return;
  }

  if (await git.hasRemote(repo)) {
    /*
     * Not an error worth a non-zero exit - the desired state is the state - but
     * said plainly, because "already published" and "just published" are
     * different things and the operator asked for one of them.
     */
    log.info(`${repo.id} already has a remote; nothing to do.`);
    return;
  }

  const { remote, notes } = await publishProject(repo, {
    visibility: rest.includes('--public') ? 'public' : 'private',
  });

  for (const n of notes) log.warn(`  ${n}`);
  if (!remote) {
    process.exitCode = 1;
    return;
  }
  log.info(`${repo.id} is now at ${remote}`);
  log.info(`  Everything it had is pushed. From here it pushes each commit as it makes it.`);
}

/* -------------------------------------------------------------------- plan */

/**
 * Close out milestones whose work has finished, and give the blocked ones one
 * chance to be planned again.
 *
 * Runs before planning rather than only after the batch, and that ordering is
 * the point: a milestone blocked by YESTERDAY's run is re-decomposed and worked
 * TODAY, in one unattended pass. Settling only at the end would leave it
 * waiting for a person to notice, which is the failure this closes.
 *
 * Deliberately not called from `status`. Every other caller here already holds
 * the run lock; `status` does not, and a second process writing to the ledger
 * while a run is dispatching buys a chance of SQLITE_BUSY in exchange for a
 * screen that is at most one run out of date.
 */
async function settleAndRequeue(cfg: AppConfig): Promise<void> {
  const settled = ledger.settleMilestones();
  /*
   * The same read as at the end of a run, because this is the OTHER place a
   * milestone can close. A run that aborted, or one whose last task landed in a
   * previous process, settles here instead — and a milestone that slipped
   * through this door would close over the request just as silently. One check
   * with two call sites, rather than one call site and a gap.
   */
  /*
   * `hollow` milestones go through the check as well, and finding that out
   * cost a run. `settleMilestones` returns a milestone in neither bucket when
   * every task under it was DROPPED — the "hollow" case — so one whose work was
   * all declared unnecessary was never acceptance-checked at all.
   *
   * That is the failure O25 is about, arriving by the other door: "we decided
   * none of this was needed" is a claim about the request, and if it is wrong
   * the request is unmet and nothing notices. Judged on the code like any
   * other, which is what makes it safe to ask.
   */
  const hollow = ledger.hollowMilestones().map((m) => m.id);
  // Advisory: the count is what it QUESTIONED, not what it changed.
  const doubted = await verifyAcceptance(cfg, [...settled.done, ...hollow]);
  if (settled.done.length) log.info(`${settled.done.length} milestone(s) finished.`);
  if (doubted) log.warn(`  ${doubted} of them the acceptance check is unsure about, above.`);
  if (settled.blocked.length) {
    log.warn(
      `${settled.blocked.length} milestone(s) stopped — every task under them was tried and none is left.`,
    );
  }

  const requeued = ledger.autoReplanBlocked();
  if (requeued.length) {
    log.info(`Planning ${requeued.length} of them again — their failed tasks are superseded.`);
    /*
     * The count, read from the constant, for the same reason the status screen
     * now reads it off each milestone: this line said "once" for as long as
     * MILESTONE_AUTO_REPLANS was 1 and kept saying it afterwards. A number
     * written out in prose beside the constant it describes is a second copy
     * of that constant, and the two had already disagreed.
     */
    log.info(
      `  Up to ${ledger.MILESTONE_AUTO_REPLANS} times per milestone. ` +
        `After that: npm run sa -- retry <milestoneId>`,
    );
  }
}

/**
 * Re-read the request against what shipped, for each milestone that just closed.
 *
 * Returns how many were reopened. Wrapped so that a brain which cannot answer
 * leaves everything `done`: this is a second opinion on a decision already made
 * correctly by its own lights, and a checker that is down must not start
 * failing finished work.
 */
async function verifyAcceptance(cfg: AppConfig, done: string[]): Promise<number> {
  if (!done.length) return 0;

  let brain;
  try {
    brain = await makeBrain(cfg);
  } catch (e) {
    log.warn(`Could not check what shipped against what was asked: ${(e as Error).message}`);
    return 0;
  }

  let advised = 0;
  try {
    for (const id of done) {
      const verdict = await checkAcceptance(brain, id, (r) => resolveRepo(cfg, r));
      if (verdict.satisfied || !verdict.missing.length) continue;

      /*
       * ADVISORY. It says what it thinks and does not act on it, and that is a
       * demotion this check earned.
       *
       * Its record across the three runs it has been live for: four milestones
       * reopened, every one of them wrong, and not one real shortfall found.
       * The cause differed each time — shown titles instead of code, then the
       * first 2,500 characters of a 7,393-character file — and each time the
       * cause got fixed rather than the score counted. On the third run it
       * would have sent a finished, working budget feature back to be rebuilt.
       *
       * The concept is right: nothing else re-reads the request against what
       * shipped, and that gap is real (O25). What has not been earned is the
       * AUTHORITY. A check with no true positives must not overrule a milestone
       * that already passed the gate, the reviewer, and the operator's own
       * acceptance criteria. Being wrong costs finished work; being merely
       * ignored costs a warning nobody acts on.
       *
       * To promote it: give it a run where it says something true. The evidence
       * it needs in order to say true things is the part that keeps being
       * wrong, so that is what to fix before this changes back.
       */
      const m = ledger.getMilestone(id);
      log.warn(`"${m?.title ?? id}" may not be finished — the acceptance check says:`);
      for (const miss of verdict.missing) log.warn(`  - ${miss}`);
      log.warn(`  Advisory only; the work is left finished. Worth a look if it matters to you.`);
      advised++;
    }
  } finally {
    await brain.dispose();
  }
  return advised;
}

async function plan() {
  const cfg = loadConfig();
  const brain = await makeBrain(cfg);
  try {
    // Before the inbox, so a milestone the last run left blocked is back in the
    // queue by the time refillBacklog looks for something to decompose.
    await settleAndRequeue(cfg);

    const ideas = parseInbox(cfg);
    if (ideas.length) {
      log.info(`Found ${ideas.length} idea(s) in ideas/inbox.md`);
      for (const idea of ideas) await shapeIdea(cfg, brain, idea);
      archiveInbox();
    } else {
      log.info('No new ideas in inbox.');
    }

    // Also pull anything you typed into the chat channel, if enabled.
    const chat = await makeChat(cfg);
    if (chat) {
      try {
        const msgs = await chat.harvest('');
        log.info(`Harvested ${msgs.length} message(s) from chat (treated as ideas, not commands)`);
      } finally {
        await chat.dispose();
      }
    }

    const added = await refillBacklog(cfg, brain);
    log.info(`Backlog: +${added} task(s), runway ~${runwayDays(cfg)} day(s)`);
  } finally {
    await brain.dispose();
  }
}

/* --------------------------------------------------------------------- run */

async function run(opts: { dry: boolean }) {
  const cfg = loadConfig();

  if (existsSync(KILLSWITCH())) {
    log.error('Killswitch is active. Remove state/KILLSWITCH to resume.');
    process.exitCode = 1;
    return;
  }
  ensureDir(stateRoot());
  // Atomic acquire (SEC-5): 'wx' fails if the lock exists, closing the
  // exists-then-write race where two runs could both pass the check.
  try {
    writeFileSync(LOCK(), String(process.pid), { flag: 'wx' });
  } catch {
    // A lock exists. Stale or live is decided by the PID inside it, not by
    // guessing: a killed run leaves the file behind and the next run must be
    // able to take over without the owner running `sa unlock`.
    let holderPid = -1;
    try {
      holderPid = Number(readFileSync(LOCK(), 'utf8').trim());
    } catch {
      holderPid = -1; // unreadable/unparseable -> treat as stale
    }
    if (Number.isInteger(holderPid) && holderPid > 0 && isProcessAlive(holderPid)) {
      log.error(`Another run holds state/run.lock (pid ${holderPid}). Use \`sa unlock\` if that is stale.`);
      process.exitCode = 1;
      return;
    }
    log.warn(`state/run.lock is stale (pid ${holderPid}) — taking over.`);
    writeFileSync(LOCK(), String(process.pid));
  }
  const runId = ledger.startRun();
  setRunId(runId);

  // F3: a run must end in the ledger on EVERY exit path, or its row stays
  // `end_run` NULL forever — indistinguishable from a run still in flight, and
  // the daily report silently stops counting it. Each normal exit closes it
  // with real numbers; the catch below closes a run that never got that far.
  let runClosed = false;

  try {
    ledger.unblockDependents();
    /*
     * Same reason as parking deadlocks below, one level up: a milestone whose
     * tasks all failed still reads as live, so the backlog looks healthier than
     * it is and nothing ever asks about the milestone again. Settling first is
     * what lets `needsPlanning` see the requeued milestone in this run.
     */
    await settleAndRequeue(cfg);
    // Park unreachable chains before measuring runway, or the backlog looks
    // healthier than it is and the planner declines to top it up.
    const stuck = ledger.markDeadlocked();
    if (stuck > 0) {
      log.warn(`${stuck} task(s) are deadlocked behind a failed dependency; parked as blocked.`);
      log.warn(`Recover them with: npm run sa -- retry --failed`);
    }

    /*
     * Read the inbox before deciding there is nothing to do.
     *
     * `run` only ever topped the backlog up from milestones that were ALREADY
     * shaped, so an idea sitting in ideas/inbox.md was invisible to it. The TUI
     * says "Your idea is saved and waiting to be broken into jobs. Choose Start
     * working now" — and choosing it answered:
     *
     *   No unplanned milestones left. Add ideas to ideas/inbox.md and run `sa plan`.
     *   Nothing ready to run. Add ideas to ideas/inbox.md, then `npm run plan`.
     *
     * An instruction to edit a markdown file and run an npm command, given to
     * the one person this interface exists to keep away from both, about a file
     * they had just written THROUGH that interface. It also spent a brain call
     * on refillBacklog first, to conclude there was nothing to refill.
     *
     * "Start working now" has to mean it. Shaping an idea is part of starting.
     */
    const newIdeas = parseInbox(cfg);
    const needsPlanning = newIdeas.length > 0 || runwayDays(cfg) < 3;

    if (needsPlanning && opts.dry) {
      /*
       * `--dry` is documented as "show what would run, change nothing", and
       * planning is the largest change a run makes: it shapes ideas into
       * milestones, MOVES ideas/inbox.md into the archive, writes new tasks, and
       * spends provider calls doing all three. Every bit of that used to happen
       * above the dry check below — so the one command offered as safe to try
       * was the one that emptied the inbox and spent the quota.
       *
       * What it would do is worth saying; doing it is not this command's job.
       */
      log.info(
        newIdeas.length
          ? `DRY RUN — would work out ${newIdeas.length} new idea(s) from the inbox first, then top the backlog up.`
          : `DRY RUN — runway is ${runwayDays(cfg)} day(s), so it would plan more work first.`,
      );
      log.info('  Nothing planned, nothing archived, no provider call made.');
      log.info('  The list below is what is ready NOW, before any of that.');
    } else if (needsPlanning) {
      if (newIdeas.length) {
        log.info(`${newIdeas.length} new idea(s) to work out first.`);
      } else {
        log.warn(`Runway is only ${runwayDays(cfg)} day(s); planning more work first.`);
      }
      const brain = await makeBrain(cfg);
      try {
        for (const idea of newIdeas) await shapeIdea(cfg, brain, idea);
        // Only once every idea is safely in the ledger. Archiving first would
        // lose the file if shaping threw halfway through.
        if (newIdeas.length) archiveInbox();
        await refillBacklog(cfg, brain);
      } finally {
        await brain.dispose();
      }
    }

    /*
     * A project that is already broken gets one job — repair it — and nothing
     * else, because nothing else can pass the gate until it is healthy.
     *
     * Traced on 2026-08-09: three tasks, one per failing test, each of which
     * genuinely reduced the failure count and every one of which was correctly
     * rejected and reverted, because the gate wants the WHOLE check green. They
     * blocked each other, permanently, and would have spent the same quota every
     * day forever.
     */
    /*
     * Tighten a gate that has been outgrown, before anything is measured
     * against it.
     *
     * Only when the command is still EXACTLY the stack floor - the untouched
     * value `sa new` wrote. suggestedGate is documented as never loosening a
     * gate because "a gate someone chose by hand is theirs", and applying its
     * suggestion automatically would break that promise for anyone who has
     * edited this line. The floor is the one value nobody chose.
     *
     * Said out loud every time. A gate getting stricter changes which work is
     * allowed to land, and that is not something to do quietly.
     */
    for (const r of cfg.repos) {
      const stack = stackById(r.stack);
      if (!stack || r.verify_cmd !== stack.floor) continue;
      const s = suggestedGate(r.path, stack, r.verify_cmd);
      if (!s.upgrade) continue;

      if (opts.dry) {
        log.info(`DRY RUN — ${r.id} has tests now; would tighten its check to: ${s.command}`);
        continue;
      }
      if (tightenGate(r.id, s.command)) {
        r.verify_cmd = s.command;
        log.info(`${r.id} has tests now, so its check is stronger from here on.`);
        log.info(`  was:  ${stack.floor}`);
        log.info(`  now:  ${s.command}`);
      } else {
        log.warn(`${r.id} has tests but its check could not be tightened automatically.`);
        log.warn(`  Set verify_cmd for "${r.id}" in config/repos.yaml to: ${s.command}`);
      }
    }

    const redRepos = new Set<string>();
    for (const r of cfg.repos) {
      if (!(await baselineGreen(cfg, r))) {
        redRepos.add(r.id);
        // Same reason as planning above: a dry run says what it would add and
        // does not add it. Checking the baseline is fine — that only reads.
        if (opts.dry) log.info(`DRY RUN — ${r.id} is failing its own check; would add a repair job.`);
        else await ensureRepairTask(cfg, r);
      }
    }

    let batch = selectBatch(cfg);
    if (redRepos.size) {
      const { runnable, held } = holdBlockedWork(batch, redRepos);
      if (held.length) {
        log.warn(
          `Holding ${held.length} job(s) until ${[...redRepos].join(', ')} ` +
            `passes its own check again — none of them could be saved until then.`,
        );
      }
      batch = runnable;
    }

    if (batch.length === 0) {
      /*
       * Said in the words of whoever is reading it. This is the end of the road
       * for a run, and "add ideas to ideas/inbox.md, then npm run plan" is a
       * developer's sentence — it names a file path and a package script to
       * someone who chose a menu item.
       */
      log.warn('Nothing to work on.');
      log.warn('Choose "Tell it what to build" and describe something you want made.');
      // F3: a run that starts and does nothing must still be closed in the
      // ledger, or runs table rows accumulate `end_run` NULL forever.
      ledger.endRun(runId, 0, 0, 'nothing_ready');
      runClosed = true;
      return;
    }

    if (opts.dry) {
      log.info(`DRY RUN — would attempt ${batch.length} task(s):`);
      for (const t of batch) log.info(`  [${t.repo}] ${t.kind}: ${t.title}`);
      ledger.endRun(runId, 0, 0, 'dry_run');
      runClosed = true;
      return;
    }

    const sum = await runBatch(cfg, batch, undefined, redRepos);
    /*
     * And again on the way out, so the report and the status screen describe
     * the batch that just ran rather than the one before it. No requeue here -
     * that is next run's decision, and re-planning inside the run that just
     * failed the tasks would dispatch against a repo it has not re-read.
     */
    const settled = ledger.settleMilestones();
    /*
     * O25. `done` means every job under it committed. It does not mean the
     * person got what they asked for, and run 22 is where those came apart:
     * 3 committed, 0 failed, the idea reported finished, and the thing the
     * operator had complained about still broken. One of the three commits was
     * a test file proving a function already behaved correctly — true,
     * committed, and beside the point.
     *
     * This is the last moment the two can be compared. After it the milestone
     * is closed, the backlog is empty, and the request is off every screen.
     *
     * A milestone that falls short goes to `blocked` with what is missing,
     * which is a state the rest of the system already handles: autoReplanBlocked
     * decomposes it again on the next run, the status screen says so, and the
     * report says so. No new state and no new loop — the same
     * MILESTONE_AUTO_REPLANS bound applies, so a checker that keeps saying no
     * cannot spend the week arguing.
     */
    const doubted = await verifyAcceptance(cfg, settled.done);
    if (settled.done.length || settled.blocked.length) {
      log.info(
        `Milestones: ${settled.done.length} finished, ${settled.blocked.length} stopped with no attempts left` +
          (doubted ? `, ${doubted} the acceptance check queried (advisory)` : '') +
          `.`,
      );
    }
    ledger.endRun(runId, sum.attempted, sum.committed, sum.stopped ?? '');
    runClosed = true;
    await writeReport(cfg, sum);
    /*
     * The one line a non-technical operator actually reads. It reports what the
     * run ended up with, not every intermediate verdict along the way, and it
     * mentions a rework only when there was one.
     */
    const sentBack = sum.sentBack ? `, ${sum.sentBack} sent back and retried` : '';
    log.info(
      `Run complete: ${sum.committed} committed, ${netFailed(sum)} failed, ` +
        `${sum.handoff} handed off${sentBack}.`,
    );
  } catch (e) {
    log.error(`Run aborted: ${(e as Error).message}`);
    // F3 residual (fixed): runBatch rolls back and rethrows (F2), so the counts
    // are unknown and the row records an abort instead. Guarded by runClosed so
    // a late failure AFTER a successful endRun (e.g. writeReport throwing) does
    // not overwrite the real numbers with 'aborted'.
    if (!runClosed) {
      ledger.endRun(runId, 0, 0, `aborted: ${(e as Error).message.slice(0, 200)}`);
    }
    if (loadConfig().system.notify.on_failure) {
      await notify('ShanAuto FAILED', (e as Error).message.slice(0, 300));
    }
    process.exitCode = 1;
  } finally {
    if (existsSync(LOCK())) unlinkSync(LOCK());
  }
}

/* ------------------------------------------------------------------ status */

function status() {
  const cfg = loadConfig();
  const counts = ledger.countByStatus();
  const commits = ledger.todaysCommits();
  const budget = dailyBudget(cfg);

  console.log(`\n  ShanAuto status\n`);
  console.log(`  today        ${commits.length} committed / target ${cfg.system.daily_target}`);
  console.log(`  agent spend  ${budget.line}`);
  console.log(`  runway       ~${runwayDays(cfg)} day(s)`);
  console.log(`  repos        ${cfg.repos.map((r) => r.id).join(', ')}`);
  console.log(`  killswitch   ${existsSync(KILLSWITCH()) ? 'ACTIVE' : 'clear'}`);
  console.log(`\n  backlog`);
  for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(12)} ${v}`);

  /*
   * Name the work that is waiting, not just count it.
   *
   * "jobs waiting: 1" answers how many and not which, and the obvious next
   * question — what is it about to do to my project? — had no answer anywhere
   * short of the route command, which nobody operating this would think to run.
   */
  const waiting = ledger.waitingTasks(12);
  if (waiting.length) {
    console.log(`\n  next up`);
    for (const t of waiting) {
      const who = route(cfg, t);
      console.log(`    ${t.repo.padEnd(10)} ${t.title.slice(0, 52).padEnd(54)} ${who.agent}`);
    }
    const more = (counts.ready ?? 0) + (counts.pending ?? 0) - waiting.length;
    if (more > 0) console.log(`    ${String(more)} more waiting`);
  }

  /*
   * Say when the queue has stopped moving, and why.
   *
   * A failed job is never picked up again on its own, and anything depending on
   * it stays parked behind it forever. With nothing left ready that is the end
   * of the road: every later run plans nothing, finds nothing, and reports
   * "Nothing to work on" — while this screen, whose own menu entry promises
   * "anything that needs you", showed `failed 6` and `blocked 3` as two calm
   * numbers among five others and gave no hint that the machine had stopped.
   *
   * Observed 2026-08-15: 9 parked jobs, 0 ready, and a main menu reading
   * "Nothing to build. Choose the first option and tell it what you want." The
   * honest answer was that three of those jobs were waiting on one failure.
   */
  /*
   * Only the failures nothing else will pick up.
   *
   * This used to be every failed and blocked task, and the screen said so:
   * "1 job(s) are stopped ... They are not picked up again on their own",
   * printed four lines above "1 of them will be planned again automatically on
   * the next run. Nothing to do." Two answers to one question, both from this
   * ledger, on one screen. The operator was sent to a terminal command for work
   * the next run was going to redo by itself.
   *
   * Repair jobs are dropped from the list here rather than in the query: they
   * have no milestone, so nothing in the ledger says whether they are going to
   * be picked up, but `ensureRepairTask` revives one on every run for as long
   * as its project is still red - which is the only state it matters in.
   */
  const stranded = ledger.strandedFailures(8).filter((t) => !isRepairTask(t));
  const movable = (counts.ready ?? 0) + (counts.pending ?? 0);
  if (stranded.length > 0 && movable === 0) {
    console.log(`\n  NEEDS YOU`);
    console.log(
      `    ${stranded.length} job(s) are stopped and nothing is queued behind them, so the\n` +
        `    next run will find nothing to do. Every automatic retry for them is used up.`,
    );
    /*
     * Two lines per job, not one.
     *
     * Squeezing a repo, a title and a reason onto one 122-column line meant
     * every field was truncated and the reason worst of all. The milestone
     * lists below have printed a heading line and an indented detail line
     * since they were written; this now matches them, and the reason gets the
     * width it needs to be read.
     */
    for (const t of stranded) {
      console.log(`    ${t.repo.padEnd(10)} ${clip(t.title, 66)}`);
      const why = clip(t.last_error ?? '', 84);
      if (why) console.log(`               ${why}`);
    }
    // The cure exists but has no screen of its own; naming it is better than
    // leaving the operator to guess. See docs/MANUAL.md.
    console.log(`\n    To put them all back in the queue:  npm run sa -- retry --failed`);
  }

  if (budget.over) {
    console.log(
      `\n  OVER the soft agent budget — ${budget.line}.` +
        `\n  Nothing is stopped by this. Adjust budget.daily_agent_units in config/system.yaml.`,
    );
  }

  const stuck = ledger.deadlockedTaskIds().size;
  if (stuck > 0) {
    console.log(
      `\n  ${stuck} task(s) DEADLOCKED behind a failed dependency — they will never run.` +
        `\n  Recover with: npm run sa -- retry --failed`,
    );
  }

  // A milestone that queued no tasks shows up nowhere in the counts above. It is
  // outstanding work, and saying so here is the difference between noticing it
  // and re-entering it by hand later.
  //
  // No longer says "every proposal was rejected": that is one of the ways a
  // milestone gets here, not the only one, and stating it as the reason is what
  // kept the others out of this list for so long.
  const { unplanned, alreadyBuilt, dropped, blocked, done } = ledger.partitionStuck(
    ledger.stuckMilestones(),
  );

  /*
   * The list that did not exist. Printed first and printed loudest, because it
   * is the only one on this screen that means "the thing you asked for was
   * attempted and is not built" - and for as long as it had no status of its
   * own it appeared nowhere at all, while the run reported an empty backlog.
   */
  if (blocked.length) {
    console.log(`\n  ${blocked.length} milestone(s) stopped — every task under them failed:`);
    for (const m of blocked.slice(0, 10)) {
      console.log(`    ${m.id}  ${m.title}`);
      for (const line of (m.last_error ?? '').split('\n').slice(0, 3)) {
        if (line.trim()) console.log(`             ${clip(line, 88)}`);
      }
    }
    /*
     * What is true of THESE milestones, read from them, not the rule recited
     * from memory. The line here used to read "Each is planned again
     * automatically once. These have used that up." — wrong twice over: the
     * limit is ledger.MILESTONE_AUTO_REPLANS, and every milestone under this
     * heading on the day it was found had used NONE of it. It sent the operator
     * to a terminal command to do by hand what the next run was going to do on
     * its own, which is the exact failure this whole screen exists to prevent.
     */
    const left = blocked.map((m) => ledger.MILESTONE_AUTO_REPLANS - (m.replans ?? 0));
    const waiting = left.filter((n) => n > 0).length;
    if (waiting) {
      console.log(
        `  ${waiting} of them will be planned again automatically on the next run. ` +
          `Nothing to do.`,
      );
    }
    if (waiting < blocked.length) {
      console.log(
        `  ${blocked.length - waiting} have been planned again ${ledger.MILESTONE_AUTO_REPLANS} ` +
          `times and stopped there.`,
      );
      console.log(`  Try one again yourself: npm run sa -- retry <milestoneId>`);
    }
  }

  // Stated, not celebrated, and with no question attached. A finished milestone
  // is the one outcome on this screen that asks nothing of the operator.
  if (done.length) console.log(`\n  ${done.length} milestone(s) finished.`);
  if (unplanned.length) {
    console.log(`\n  ${unplanned.length} milestone(s) planned to nothing — no task was ever queued for them:`);
    for (const m of unplanned.slice(0, 10)) {
      console.log(`    ${m.id}  ${m.title}`);
      for (const line of (m.last_error ?? '').split('\n').slice(0, 3)) {
        if (line.trim()) console.log(`             ${line.slice(0, 88)}`);
      }
    }
    console.log(`  Requeue them with: npm run sa -- retry --failed`);
  }

  /*
   * The brain's answer that a milestone is already built. Kept out of the list
   * above because "planned to nothing" reads as a failure and this is not one:
   * nothing failed, and there is nothing to requeue. Filed under that heading it
   * told the operator to spend quota re-asking a settled question.
   *
   * The reasoning is printed because the answer is a claim, not a verdict — the
   * operator is the one who confirms it, and cannot do that from a status name.
   * There is no "confirm" command on purpose: leaving it alone IS the
   * confirmation, and `retry --failed` skips these, so "leave them" is a true
   * instruction rather than one the next requeue quietly overrides.
   */
  if (alreadyBuilt.length) {
    console.log(
      `\n  ${alreadyBuilt.length} milestone(s) the brain says are already built —` +
        ` nothing was queued because it found nothing missing:`,
    );
    for (const m of alreadyBuilt.slice(0, 10)) {
      console.log(`    ${m.id}  ${m.title}`);
      for (const line of (m.last_error ?? '').split('\n').slice(0, 3)) {
        if (line.trim()) console.log(`             ${line.slice(0, 88)}`);
      }
    }
    console.log(`  If that is right, nothing to do — they are out of the queue and stay out.`);
    console.log(`  If the work is actually missing: npm run sa -- retry <milestoneId>`);
  }

  /*
   * Milestones the operator retired. Listed, not hidden - a decision that
   * leaves no trace is how "why was this never built" becomes unanswerable a
   * month later - but stated as settled, with no question attached and no
   * count anywhere warning about them.
   */
  if (dropped.length) {
    console.log(`\n  ${dropped.length} milestone(s) you dropped — not queued, and no requeue will pick them up:`);
    for (const m of dropped.slice(0, 10)) {
      console.log(`    ${m.id}  ${m.title}`);
      if ((m.last_error ?? '').trim()) console.log(`             ${(m.last_error ?? '').slice(0, 88)}`);
    }
    console.log(`  Changed your mind about one: npm run sa -- retry <milestoneId>`);
  }

  /*
   * Milestones that read as done but have nothing under them. Unlike the list
   * above these are `planned`, so no count on this screen moves when one
   * appears and nothing else mentions them at all.
   *
   * No blanket requeue offered on purpose: some are hollow because the work
   * already existed, and re-planning those spends quota re-proposing finished
   * work. The reasons are printed so the operator can tell which is which, and
   * the requeue is per id.
   */
  const hollow = ledger.hollowMilestones();
  if (hollow.length) {
    console.log(
      `\n  ${hollow.length} milestone(s) marked planned with no work left under them —` +
        ` every task was dropped:`,
    );
    for (const m of hollow.slice(0, 10)) {
      console.log(`    ${m.id}  ${m.title}`);
      for (const line of (m.reasons ?? '').split(' | ').slice(0, 3)) {
        if (line.trim()) console.log(`             dropped: ${line.split('\n')[0]!.slice(0, 80)}`);
      }
    }
    console.log(`  If the work is still outstanding: npm run sa -- retry <milestoneId>`);
    console.log(`  If it is already done, leave it — dropped means the task is gone, not failed.`);
  }

  const needsYou = ledger.handoffTasks();
  if (needsYou.length) {
    console.log(`\n  waiting on you (${needsYou.length})`);
    for (const t of needsYou.slice(0, 10)) console.log(`    ${t.id}  ${t.title}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------- route */

/** Show how the ready backlog would be split between agents, running nothing. */
async function routePreview() {
  const cfg = loadConfig();
  const { route } = await import('./core/router.js');
  const ready = ledger.readyTasks();

  if (ready.length === 0) {
    log.warn('Nothing ready. Run `npm run plan` first.');
    return;
  }

  const tally = new Map<string, number>();
  console.log('');
  for (const t of ready) {
    const d = route(cfg, t);
    tally.set(d.agent, (tally.get(d.agent) ?? 0) + 1);
    const tag = d.complex ? 'COMPLEX' : 'simple ';
    console.log(`  ${tag}  ${d.agent.padEnd(11)} ${t.title.slice(0, 46).padEnd(48)} ${d.reason}`);
  }
  console.log('\n  split');
  for (const [agent, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${agent.padEnd(12)} ${n} of ${ready.length}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ misc */

async function resolve(taskId: string, force = false) {
  const cfg = loadConfig();
  const task = ledger.getTask(taskId);
  if (!task) {
    log.error(`No such task: ${taskId}`);
    process.exitCode = 1;
    return;
  }
  // F9 decision, in src/core/resolve.ts so it is unit-testable.
  const statusErr = resolveStatusError(task, force);
  if (statusErr) {
    log.error(statusErr);
    process.exitCode = 1;
    return;
  }
  const repo = resolveRepo(cfg, task.repo);
  const { gate } = await import('./core/verifier.js');
  const g = await gate(cfg, task, repo);
  if (!g.ok) {
    log.error(`Gate still failing: ${g.failure} — ${g.detail.slice(0, 400)}`);
    process.exitCode = 1;
    return;
  }

  // F9 decision: commit exactly the files this task was about, not whatever
  // else happens to be in the tree (see src/core/resolve.ts).
  const { files: commitFiles, refused } = resolveCommitFiles(g.diff.files, task.files_hint, force);
  if (refused) {
    log.error(`${task.id}: ${refused}`);
    process.exitCode = 1;
    return;
  }

  const { sha, pushed } = await git.commitAndPush(
    repo,
    git.commitMessage(task.kind, task.title, task.acceptance),
    commitFiles,
  );
  ledger.markCommitted(task.id, sha);
  if (!pushed) log.warn(`Resolved ${task.id} -> ${sha.slice(0, 8)} is LOCAL ONLY (push failed)`);
  log.info(
    `Resolved ${task.id} -> ${sha.slice(0, 8)}` +
      (commitFiles.length !== g.diff.files.length
        ? ` (${commitFiles.length} of ${g.diff.files.length} changed file(s) belong to this task)`
        : ''),
  );
}

async function chatLogin() {
  const cfg = loadConfig();
  const entry = cfg.drivers.chat.registry[cfg.drivers.chat.active];
  if (!entry) throw new Error('No chat driver configured.');
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(
    (entry.profile_dir as string) ?? p('data', 'browser-profile'),
    { headless: false, viewport: { width: 1400, height: 900 } },
  );
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto((entry.url as string) ?? 'https://chatgpt.com');
  log.info('Sign in in the opened window, then close it. The session is saved to the profile dir.');
  await new Promise<void>((r) => ctx.on('close', () => r()));
}

/* -------------------------------------------------------------------- main */

const HELP = `
  shanauto — ideas in, verified commits out

  npm run doctor                 preflight: repos, agents, brain, github, guards
  npm run plan                   inbox -> epics -> milestones -> micro-tasks
  npm run run                    execute today's batch (this is what the scheduler calls)
  npm run sa -- run --dry        show what would run, change nothing
  npm run status                 backlog, runway, today's agent spend, what is waiting on you
  npm run sa -- route            preview which agent gets each ready task
  npm run sa -- recall "<query>" search memory by keyword (free, no provider call)
  npm run sa -- ask "<question>"  ask about the project's history (one provider call)
  npm run sa -- remember "<text>" record something the system could not observe
  npm run tui                    the control panel — everything below, with arrow keys
  npm run sa -- journal [--days=2] read the working journal: what was tried, and how it went
  npm run sa -- memory:ingest    pull commits, decisions, run outcomes and journal days into memory
  npm run sa -- memory:export    write memory to data/memory/*.jsonl, one file per year
  npm run sa -- memory:import    restore memory from those files
  npm run sa -- rollup [--period=week] [--narrate]
                                 compress closed periods; --narrate adds a
                                 sentence each, one provider call per period
  npm run sa -- report           re-emit today's report
  npm run sa -- report:weekly    7-day rollup with a commit trend
  npm run sa -- export-csv       dump the task ledger to data/reports/ledger.csv
  npm run sa -- plan:one         decompose exactly one more milestone
  npm run sa -- retry <taskId>   requeue one failed/blocked task
  npm run sa -- retry --failed   revive every failed task + unblock the chains behind them,
                                 and requeue milestones whose proposals were all rejected
  npm run sa -- drop <taskId>    retire a task whose work already exists
  npm run sa -- resolve <taskId> [--force]
                                 verify + commit a task the agent handed off.
                                 Only files in the task's files_hint are committed;
                                 --force commits the whole verified diff for a
                                 non-handoff task
  npm run sa -- prune [--dry-run]
                                 delete journal/artifact/run entries past the
                                 retention window in config/system.yaml
                                 (0 = keep everything, which is the default)
  npm run sa -- chat:login       open a browser to sign in to the chat channel
  npm run sa -- stop | resume    set / clear the killswitch
  npm run sa -- unlock           clear a stale run.lock
`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'doctor':
      return doctor();
    case 'plan':
      return plan();
    case 'plan:one': {
      const cfg = loadConfig();
      const brain = await makeBrain(cfg);
      try {
        await planNextMilestone(cfg, brain);
      } finally {
        await brain.dispose();
      }
      return;
    }
    case 'run':
      return run({ dry: rest.includes('--dry') });
    case 'new':
      return newProject(rest);
    case 'publish':
      return publish(rest);
    case 'status':
      return status();
    case 'route':
      return routePreview();
    case 'rollup': {
      const cfg = loadConfig();
      const { buildRollups, renderStats } = await import('./core/rollup.js');
      const period = (rest.find((a) => a.startsWith('--period='))?.split('=')[1] ?? 'week') as
        | 'day'
        | 'week'
        | 'month';
      const narrate = rest.includes('--narrate');
      for (const repo of cfg.repos) {
        const n = buildRollups(repo.id, period);
        log.info(`${repo.id}: built ${n} ${period} rollup(s)`);

        if (narrate) {
          // The only part of memory that costs a provider request, so it is
          // opt-in rather than automatic.
          const { narrateRollups } = await import('./core/rollup.js');
          const brain = await makeBrain(cfg);
          try {
            const r = await narrateRollups(repo.id, brain);
            log.info(`${repo.id}: narrated ${r.narrated}, failed ${r.failed}`);
          } finally {
            await brain.dispose();
          }
        }
        for (const r of ledger.getRollups(repo.id, period, 5)) {
          const stats = JSON.parse(r.stats) as Parameters<typeof renderStats>[0];
          console.log(`  ${r.starts_at.slice(0, 10)}  ${renderStats(stats)}`);
          if (r.narrative) console.log(`              ${r.narrative.slice(0, 96)}`);
        }
      }
      return;
    }
    case 'memory:export': {
      const cfg = loadConfig();
      const { exportMemory } = await import('./core/memory-export.js');
      for (const repo of cfg.repos) {
        const r = exportMemory(repo.id);
        log.info(`${repo.id}: exported ${r.records} record(s) to ${r.files.length} file(s)`);
        for (const f of r.files) console.log(`  ${f}`);
      }
      return;
    }
    case 'memory:import': {
      const cfg = loadConfig();
      const { importMemory } = await import('./core/memory-export.js');
      for (const repo of cfg.repos) {
        const r = importMemory(repo.id);
        log.info(
          `${repo.id}: imported ${r.imported}, already present ${r.skipped}, unreadable ${r.malformed}`,
        );
      }
      return;
    }
    case 'tui':
    case 'ui':
    case 'menu': {
      const { tui } = await import('./tui/app.js');
      await tui();
      return;
    }
    case 'journal': {
      /*
       * Reads a file, nothing more — so it works while the killswitch is on,
       * which is exactly when you want to know what the system was doing.
       */
      const { journalDays, readDay } = await import('./core/journal.js');
      const days = journalDays();
      if (days.length === 0) {
        log.info('No journal yet. It is written as tasks run.');
        return;
      }
      const n = Number(rest.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 2);
      for (const day of days.slice(-Math.max(1, n))) {
        process.stdout.write(`${readDay(day).trim()}\n\n`);
      }
      return;
    }
    case 'memory:ingest': {
      const cfg = loadConfig();
      const { ingestDecisions, ingestRunLogs, ingestJournal } = await import('./core/ingest-docs.js');
      const { ingestCommits } = await import('./core/ingest.js');
      /*
       * DECISIONS.md, the run logs and the journal describe the SYSTEM, not any
       * one project — but they were ingested inside the per-repo loop, so every
       * one was stored once per configured repo. Measured: 11 decisions and 30
       * incidents held twice, so `recall` showed the same decision twice as if
       * two had been made, and `ask` spent half its context budget on copies.
       *
       * Filed under the first repo, which is arbitrary but consistent; retrieval
       * passes no repo filter for these kinds.
       */
      const home = cfg.repos[0]!.id;
      const d = ingestDecisions(home);
      const r = ingestRunLogs(home);
      const j = ingestJournal(home);
      log.info(
        `system: +${d.ingested} decision(s), +${r.ingested} run outcome(s), ` +
          `+${j.ingested} journal day(s)`,
      );

      for (const repo of cfg.repos) {
        const c = await ingestCommits(repo);
        log.info(`${repo.id}: +${c.ingested} commit(s)`);
      }
      return;
    }
    case 'remember': {
      /*
       * Some context only ever exists in your head. Without a way to write it
       * down, the memory is limited to what the machine happened to observe.
       */
      const text = rest.join(' ').trim();
      if (!text) {
        log.error('Usage: sa remember "<what happened, and why it mattered>"');
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      ledger.remember({ repo: cfg.repos[0]!.id, kind: 'incident', reason: text });
      log.info('Remembered.');
      return;
    }
    case 'ask': {
      /*
       * Like recall, this only reads — so it works with the killswitch set.
       * Unlike recall it costs one provider request, which is why the free
       * keyword path still exists alongside it.
       */
      const question = rest.join(' ').trim();
      if (!question) {
        log.error('Usage: sa ask "<question about the project\'s history>"');
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      const { askMemory } = await import('./core/ask.js');
      const brain = await makeBrain(cfg);
      try {
        const r = await askMemory(cfg.repos[0]!.id, question, brain);
        console.log(`\n  ${r.answer.split('\n').join('\n  ')}\n`);
        if (r.candidates > 0) {
          console.log(`  — from ${r.candidates} matching memories (${r.contextChars} chars of context)\n`);
        }
      } finally {
        await brain.dispose();
      }
      return;
    }
    case 'recall': {
      /*
       * A read command, so it works with the killswitch set — same as status,
       * route and report. The killswitch stops execution, not inspection, and
       * looking up why something was parked is exactly what you want to do while
       * the system is stopped.
       */
      const query = rest.join(' ').trim();
      if (!query) {
        log.error('Usage: sa recall "<query>"   — search what has been resolved and why');
        process.exitCode = 1;
        return;
      }
      const hits = ledger.searchResolutions(null, query);
      if (hits.length === 0) {
        console.log(`\n  nothing recorded matching "${query}"\n`);
        return;
      }
      /*
       * Say how many were FOUND, not how many fit on the page.
       *
       * searchResolutions defaults to a limit of 25 and this printed
       * `hits.length`, so a query matching 107 memories reported "25 result(s)".
       * The owner reads that as the complete record and stops looking, while 82
       * memories — possibly including the one that mattered — are withheld
       * without a word.
       */
      const total = ledger.countResolutions(null, query);
      console.log(
        total > hits.length
          ? `\n  showing ${hits.length} of ${total} for "${query}"\n`
          : `\n  ${total} result(s) for "${query}"\n`,
      );
      for (const h of hits) {
        const sha = h.commit_sha ? h.commit_sha.slice(0, 8) : '        ';
        const lines = (h.reason ?? '').split('\n').filter((l) => l.trim());
        // A commit is best identified by what it touched; a decision or an
        // incident has no paths at all — its text is the whole content.
        const headline = [...h.symbols, ...h.paths].slice(0, 4).join(', ') || lines[0] || '(no detail)';

        // When it HAPPENED. resolved_at is the ingestion minute, so every
        // backfilled memory carried the day the ingester ran — collapsing the
        // history onto one date and contradicting the memory's own first line.
        const when = (h.occurred_at ?? h.resolved_at).slice(0, 10);
        console.log(`  ${when}  ${sha}  ${h.kind.padEnd(16)} ${headline.slice(0, 76)}`);
        for (const l of lines.slice(0, headline === lines[0] ? 3 : 1)) {
          if (l !== headline) console.log(`              ${l.slice(0, 88)}`);
        }
      }
      console.log('');
      return;
    }
    case 'report': {
      const cfg = loadConfig();
      // Rebuilt from the ledger rather than hardcoded. This block used to report
      // attempted 0 / failed 0 beside a real commit count — impossible on its
      // face, and "failed: 0" printed directly above the day's failures.
      const outcomes = ledger.todaysOutcomes();
      await writeReport(cfg, {
        attempted: outcomes.attempted,
        committed: ledger.todaysCommits().length,
        failed: outcomes.failed,
        // Rebuilt from final ledger state, where a task that was sent back and
        // then shipped is simply committed. Nothing here is mid-retry.
        sentBack: 0,
        handoff: outcomes.handoff,
        dropped: outcomes.dropped,
        // Parked tasks leave no lasting status, so a reconstruction cannot see them.
        parked: 0,
        // A standalone `report` reconstructs the day from the ledger and never
        // saw a run, so it cannot know what was blocked in one.
        blocked: 0,
        blockedBy: [],
        blockedShipped: [],
        breakingShipped: [],
        testsOnlyShipped: [],
        // Same reason: an agent going out, and what went wrong task by task,
        // are facts about a run — not statuses left behind in the ledger for a
        // reconstruction to find. A standalone report still shows what is
        // currently failed, from the ledger, under "Still failed from earlier
        // runs" — which is exactly what that section is for.
        agentsOut: [],
        problems: [],
        held: [],
        /*
         * Set-aside work is the one thing here a reconstruction CAN see for
         * itself: it is sitting in git, not in the ledger. Reading it means
         * `sa report` on a quiet day still tells the owner their swept-up files
         * are waiting — which is precisely the day they would want to know.
         */
        stashes: await git.stashSummary(cfg.repos),
      });
      return;
    }
    case 'report:weekly': {
      const { writeWeeklyReport } = await import('./core/reporter.js');
      log.info(`Weekly rollup: ${writeWeeklyReport()}`);
      return;
    }
    case 'export-csv': {
      ledger.exportLedgerToCsv();
      log.info(`Ledger exported to ${join(reportsDir(), 'ledger.csv')}`);
      return;
    }
    case 'retry': {
      if (rest.includes('--failed')) {
        const n = ledger.retryAllFailed();
        log.info(`Revived ${n} failed task(s) and unblocked anything behind them.`);
        const m = ledger.replanStuckMilestones();
        if (m > 0) {
          log.info(`Requeued ${m} milestone(s) that planned to nothing. Run \`npm run plan\` to decompose them.`);
        }
      } else if (rest[0]) {
        const id = rest[0];
        /*
         * Tasks and milestones share this verb because the operator is holding
         * an id off `sa status`, not a taxonomy. Reporting "not failed or
         * blocked" for a milestone id was true and useless: it named the task
         * rule for something that is not a task.
         */
        if (ledger.retryTask(id)) {
          log.info(`Requeued ${id}.`);
        } else if (ledger.replanMilestone(id)) {
          log.info(`Requeued milestone ${id}. Run \`npm run plan\` to decompose it.`);
        } else {
          log.info(`${id} is not a failed or blocked task, nor a milestone to replan — nothing to do.`);
        }
      } else {
        log.error('Usage: sa retry <taskId|milestoneId>  |  sa retry --failed');
        process.exitCode = 1;
      }
      return;
    }
    case 'drop': {
      const id = rest[0];
      if (!id) {
        log.error('Usage: sa drop <taskId|milestoneId> [reason]   — retire work that should not be built');
        process.exitCode = 1;
        return;
      }
      const reason = rest.slice(1).join(' ') || 'already satisfied';
      /*
       * Same reasoning as `retry`: the operator is holding an id off
       * `sa status`, not a taxonomy. Tasks first, because that is what the
       * verb meant before milestones could be dropped at all.
       */
      if (ledger.dropTask(id, reason)) {
        log.info(`Dropped ${id}: ${reason}`);
        return;
      }
      const m = ledger.dropMilestone(id, reason);
      if (m === 'dropped') {
        log.info(`Dropped milestone ${id}: ${reason}`);
        log.info(`  It stays on \`sa status\` as dropped, and no requeue will pick it up.`);
        log.info(`  Changed your mind: npm run sa -- retry ${id}`);
      } else if (m === 'not-found') {
        log.info(`${id} is not a task or a milestone — nothing to drop.`);
      } else {
        // Dropping the milestone would not stop these being built.
        log.error(`${id} still has ${m.live.length} live task(s): ${m.live.join(', ')}`);
        log.error(`  Drop or finish those first, then drop the milestone.`);
        process.exitCode = 1;
      }
      return;
    }
    case 'prune': {
      /*
       * The only command here that deletes anything, so it is the only one that
       * tells you what it did in full. Retention defaults to 0 everywhere, so
       * this reports "keeping everything" until someone edits system.yaml —
       * see the note there.
       */
      const cfg = loadConfig();
      const { prune, formatBytes } = await import('./core/prune.js');
      const r = cfg.system.retention;
      const dryRun = rest.includes('--dry-run');

      console.log(
        `\n  retention: journal ${r.journal_days}d · artifacts ${r.artifact_days}d · runs ${r.run_log_days}d`,
      );

      const out = prune(r, { dryRun });
      if (!out.enabled) {
        console.log('  every window is 0 — keeping everything. Set one in config/system.yaml.\n');
        return;
      }

      for (const e of out.removed) {
        console.log(`  ${dryRun ? 'would remove' : 'removed'}  ${e.day}  ${e.area.padEnd(9)} ${formatBytes(e.bytes).padStart(9)}  ${e.path}`);
      }
      console.log(
        `\n  ${out.removed.length} entr(ies) ${dryRun ? 'would be removed' : 'removed'}, ` +
          `${formatBytes(out.bytes)} ${dryRun ? 'would be reclaimed' : 'reclaimed'}; ${out.kept} kept.`,
      );
      if (dryRun) console.log('  --dry-run: nothing was deleted.');
      for (const err of out.errors) log.warn(`  prune: ${err}`);
      console.log('');
      return;
    }
    case 'resolve':
      // F9: --force bypasses the handoff status guard and the files_hint
      // intersection (commit the whole verified diff).
      return resolve(rest[0] ?? '', rest.includes('--force'));
    case 'chat:login':
      return chatLogin();
    case 'stop':
      ensureDir(stateRoot());
      writeFileSync(KILLSWITCH(), new Date().toISOString());
      log.warn('Killswitch set. Runs will refuse to start.');
      return;
    case 'resume':
      if (existsSync(KILLSWITCH())) unlinkSync(KILLSWITCH());
      log.info('Killswitch cleared.');
      return;
    case 'unlock':
      if (existsSync(LOCK())) unlinkSync(LOCK());
      log.info('Lock cleared.');
      return;
    case '--report': {
      const { today, writeFileSafe } = await import('./util.js');
      const { writeReport } = await import('./core/reporter.js');
      const cfg = loadConfig();
      // Write markdown report first if they want, but here we just need to trigger HTML
      const html = `<!DOCTYPE html><html><head><title>Report</title></head><body><h1>ShanAuto Report</h1><p>HTML report generation triggered.</p></body></html>`;
      const outPath = join(reportsDir(), `${today()}.html`);
      ensureDir(reportsDir());
      writeFileSync(outPath, html);
      log.info(`HTML Report written to ${outPath}`);
      return;
    }
    case '--export-csv':
      ledger.exportLedgerToCsv();
      log.info('Ledger exported to CSV.');
      return;
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
