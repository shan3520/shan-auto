import { execa } from 'execa';
import { existsSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { p, loadConfig, ROOT, stateRoot } from '../config.js';
import { ensureDir } from '../util.js';
import * as ledger from '../ledger.js';
import { journalDays, readDay } from '../core/journal.js';
import { c, clear, confirm, editor, hideCursor, input, menu, notice, pager, readKey, showCursor } from './ui.js';
import { settingsScreen } from './settings.js';
import { join } from 'node:path';
import { STACKS } from '../core/stacks.js';
import { scaffold, registerRepo, validateId, checkTarget, type NewProject } from '../core/scaffold.js';
import { hasRemote } from '../git.js';

/**
 * The control panel.
 *
 * Every action here shells out to the same `sa` commands documented in
 * docs/MANUAL.md rather than reimplementing them. That is the whole design: if
 * the TUI and the CLI could drift, one of them would eventually be wrong, and
 * it would be the one nobody tests.
 *
 * Written for someone who does not work in a terminal. No ids on screen unless
 * they are needed, no config vocabulary, and every destructive action asks
 * first and defaults to "no".
 */

const KILLSWITCH = () => process.env.SHANAUTO_KILLSWITCH ?? join(stateRoot(), 'KILLSWITCH');
const INBOX = () => p('ideas', 'inbox.md');

/** After this much silence the screen says something, and keeps saying it. */
const QUIET_MS = 60_000;

/** `2m05s`. Minutes are the unit the wait is actually felt in. */
export function hms(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * How long this screen waits for one `sa` command before it stops waiting.
 *
 * A run is meant to be long: the executor checks the killswitch and its
 * max_run_hours budget between jobs, and kills a single agent at
 * timeouts.task_s. So the cap is that whole budget plus one full job plus a
 * margin — it can only fire when the run has stopped bounding ITSELF, never on
 * a run that is merely slow. Everything else on this menu is a report or a
 * check that finishes in seconds, and half an hour for one of those is already
 * far past anything that could be called working.
 */
export function capMs(args: string[], sys?: { limits?: { max_run_hours?: number }; timeouts?: { task_s?: number } }): number {
  if (args[0] !== 'run' && args[0] !== 'resume') return 30 * 60_000;
  const hours = sys?.limits?.max_run_hours ?? 8;
  const task = sys?.timeouts?.task_s ?? 900;
  return (hours * 3600 + task + 600) * 1000;
}

/**
 * What a keypress means while a command is running.
 *
 * Ctrl-C is here because raw mode takes it away. Ordinarily the terminal turns
 * it into SIGINT; in raw mode it arrives as a byte like any other, so without
 * this the operator would lose the only way out they have today — and it would
 * be this change that took it from them.
 *
 * `escape` is a bare ESC only. Arrow keys are ESC-bracket-letter, and treating
 * a prefix as the whole key would make pressing Down mean stop.
 *
 * Ctrl-C is looked for ANYWHERE in the chunk while the others must be the whole
 * of it. Keys usually arrive one per chunk, but two pressed together arrive as
 * one, and the one key that must never be missed is the one that gets the
 * operator out. Nothing else here can afford to be that eager: an arrow key
 * contains a bare ESC, so `includes` on that would read Down as stop.
 */
export function keyAction(s: string, stoppable: boolean): 'kill' | 'stop' | 'hint' | 'none' {
  if (s.includes('\x03')) return 'kill';
  if (s === 's' || s === 'S' || s === '\x1b') return stoppable ? 'stop' : 'hint';
  return 'none';
}

/**
 * The line printed into a silence, or null while there is nothing to say.
 *
 * Pure so it can be tested: the thing being guarded against is a screen that
 * has not moved for nine minutes, and there is no way to observe that by
 * looking at a timer.
 */
export function quietNote(now: number, lastOut: number, lastNote: number, started: number, canStop: boolean): string | null {
  if (now - lastOut < QUIET_MS || now - lastNote < QUIET_MS) return null;
  const how = canStop ? '  Press S to stop after this job, or Ctrl-C to stop now.' : '  Ctrl-C stops it.';
  return `  ${c.dim(`still going — nothing printed for ${hms(now - lastOut)}, ${hms(now - started)} in total.${how}`)}\n`;
}

/**
 * Run an `sa` command, streaming its output onto a plain screen.
 *
 * The output is piped rather than inherited. Inherited output goes straight
 * from the child to the terminal and this process learns nothing from it — so a
 * command that had gone quiet and a command that had died looked exactly the
 * same, which for one agent job is up to fifteen minutes of a screen that does
 * not move. The recorded runs contain a 9m32s silence with nothing on screen to
 * say the machine was still alive.
 *
 * Piping also frees the keyboard. Inherited stdio handed stdin to the child,
 * and this screen could not be answered until the child chose to finish: a run
 * started here could not be stopped from here, and the Pause button that exists
 * for exactly that purpose was on a menu the operator could not get back to.
 */
async function runCommand(title: string, args: string[]): Promise<number> {
  clear();
  showCursor();
  process.stdout.write(`\n  ${c.bold(c.cyan('ShanAuto'))}  ${c.dim('·')}  ${c.bold(title)}\n\n`);

  /*
   * Only `run` asks the killswitch between jobs, so only `run` can be brought
   * to a clean stop. Offering that on a command that cannot honour it would be
   * a button that does nothing.
   */
  const stoppable = args[0] === 'run';
  let sys: Parameters<typeof capMs>[1];
  try {
    sys = loadConfig(true).system as unknown as Parameters<typeof capMs>[1];
  } catch {
    // Config too broken to read is the doctor's problem, not this screen's.
  }

  const child = execa('node', [p('node_modules', 'tsx', 'dist', 'cli.mjs'), p('src', 'index.ts'), ...args], {
    cwd: ROOT,
    reject: false,
    // Nothing under `sa` reads stdin — no prompt, no readline anywhere in the
    // command path — so handing it over bought nothing and cost the keyboard.
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: capMs(args, sys),
    /*
     * Windows turns this into TerminateProcess, so it is the SIGTERM handler
     * that never runs rather than the delay that matters — measured. Left in
     * because it is what makes the cap true on any platform, and costs nothing
     * on the one this runs on.
     */
    forceKillAfterDelay: 5_000,
    /*
     * `sa` needs the credentials this process was started with, so the
     * environment is extended rather than replaced, and c() writes escape codes
     * unconditionally, so there is nothing to force about colour.
     *
     * The one thing added is silence. tui() suppresses node's warnings, but
     * this is a fresh node and that never reached it — so node:sqlite's
     * ExperimentalWarning printed into the middle of every command screen,
     * followed by an instruction to re-run node with --trace-warnings. On the
     * one screen written for someone who does not use a terminal, a warning
     * about a database driver is indistinguishable from a real failure. That is
     * the reason tui() suppresses it for the menu; the child needs the same.
     *
     * It travels in the environment because it has to: tsx re-spawns node, so a
     * CLI flag here lands on the wrapper and not on the process that touches
     * node:sqlite — measured. Appended rather than replaced, so an operator who
     * set NODE_OPTIONS themselves keeps it. It reaches `sa` and stops there:
     * every agent, brain, verify and repair spawn uses safeEnv with
     * extendEnv:false, and NODE_OPTIONS is not on that allowlist.
     */
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning']
        .filter(Boolean)
        .join(' '),
    },
  });

  const started = Date.now();
  let lastOut = started;
  let lastNote = started;
  const forward = (chunk: Buffer) => {
    lastOut = Date.now();
    process.stdout.write(chunk);
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);

  let asked = false;
  const beat = setInterval(() => {
    const note = quietNote(Date.now(), lastOut, lastNote, started, stoppable && !asked);
    if (!note) return;
    lastNote = Date.now();
    process.stdout.write(note);
  }, 5_000);

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onKey = (buf: Buffer) => {
    switch (keyAction(buf.toString(), stoppable && !asked)) {
      case 'kill':
        process.stdout.write(`\n  ${c.yellow('Stopping now.')}\n`);
        child.kill('SIGTERM');
        break;
      case 'stop':
        asked = true;
        ensureDir(stateRoot());
        writeFileSync(KILLSWITCH(), new Date().toISOString());
        process.stdout.write(
          `\n  ${c.yellow('It will stop after the job it is on.')}\n` +
            `  ${c.dim('Nothing is lost, and no work is thrown away. Ctrl-C stops it immediately instead.')}\n\n`,
        );
        break;
      case 'hint':
        process.stdout.write(`  ${c.dim('Ctrl-C stops it.')}\n`);
        break;
    }
  };
  stdin.on('data', onKey);

  const res = await child;

  clearInterval(beat);
  stdin.off('data', onKey);
  if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);

  if (res.timedOut) {
    /*
     * Said plainly and without reassurance, because this one is not routine:
     * the command outlived a budget it sets for itself, so something is wrong
     * that this screen cannot see.
     *
     * "may still be running" stays a hedge on purpose. Measured on this
     * machine, killing the wrapper took the whole tree with it — the `sa`
     * process and the child it had spawned both stopped, and a control run
     * proved the check could see a survivor when there was one. But the
     * mechanism for that is the OS's, not ours, and it was measured against a
     * node child rather than agy.exe or copilot, which may well be entitled to
     * outlive their parent. Promising the operator a clean kill on that
     * evidence would be promising more than was measured.
     */
    process.stdout.write(
      `\n  ${c.yellow(`Stopped waiting after ${hms(capMs(args, sys))}.`)}\n` +
        `  ${c.dim('It should have stopped itself long before this, so something is stuck.')}\n` +
        `  ${c.dim('An agent it started may still be running. Run Checking, and pause it if you want it left alone.')}\n`,
    );
  } else if (asked) {
    process.stdout.write(`\n  ${c.dim('Stopped. It stays paused until you let it run again.')}\n`);
  }

  process.stdout.write(`\n  ${c.dim('Finished. Press any key to go back.')}\n`);
  hideCursor();
  await readKey();
  return res.exitCode ?? 1;
}

function isOn(): boolean {
  return !existsSync(KILLSWITCH());
}

/*
 * The overview is recomputed only when the underlying state could have changed.
 * The main menu calls it on every open, and re-reading the three config files
 * and re-aggregating the ledger each time is pure overhead when nothing moved
 * between two opens. Mutating actions invalidate it; read-only ones (status,
 * memory, report, doctor) leave it alone.
 */
let overviewCache: string[] | null = null;
function invalidateOverview(): void {
  overviewCache = null;
}

/** The one-line summary at the top of the main menu. */
function overview(): string[] {
  if (overviewCache) return overviewCache;
  overviewCache = computeOverview();
  return overviewCache;
}

/**
 * Which single sentence the front page owes the operator.
 *
 * Pure, and separated from the screen, because the bug here was never the
 * wording - it was the PRECEDENCE. `waiting` counts ready + pending, stopped
 * work is neither, so four stopped jobs and a stopped milestone read as
 * `jobs waiting 0` and the screen said "Nothing to build. Choose the first
 * option and tell it what you want." An operator following that types a second
 * idea into a system that has given up on the first, and never opens the one
 * screen that could tell them.
 *
 * That is the third time this screen has counted two different things as one -
 * the comment below records the other two, ideas-versus-jobs and
 * ready-versus-pending - so this time the decision is a function with a name
 * and a test rather than a chain of conditions nobody can see the order of.
 *
 * `stopped` outranks everything except work that is actually queued: a run
 * cannot fix it, waiting will not fix it, and it is the only state on this
 * screen that needs a person.
 */
export type OverviewState =
  | 'stopped'
  | 'idea-waiting'
  | 'nothing'
  | 'all-pending'
  | 'ready'
  | 'ready-paused';

export function overviewState(o: {
  ready: number;
  pending: number;
  stopped: number;
  ideasWaiting: boolean;
  running: boolean;
}): OverviewState {
  const waiting = o.ready + o.pending;
  // Queued work first: the operator can start it, and the run itself is what
  // clears the queue. Stopped work is still shown in the header count.
  if (waiting === 0 && o.stopped > 0) return 'stopped';
  if (waiting === 0 && o.ideasWaiting) return 'idea-waiting';
  if (waiting === 0) return 'nothing';
  if (o.ready === 0) return 'all-pending';
  return o.running ? 'ready' : 'ready-paused';
}

function computeOverview(): string[] {
  const lines: string[] = [];
  try {
    const cfg = loadConfig(true);
    const counts = ledger.countByStatus() as Record<string, number>;
    const today = ledger.committedToday();
    const waiting = (counts.ready ?? 0) + (counts.pending ?? 0);

    /*
     * Jobs that have given up. `failed` has no attempts left and `blocked` is
     * parked behind one that failed; neither is in `waiting`, and until this
     * line existed neither appeared anywhere on this screen.
     */
    const stoppedJobs = (counts.failed ?? 0) + (counts.blocked ?? 0);
    let stoppedMilestones = 0;
    try {
      stoppedMilestones = ledger.partitionStuck(ledger.stuckMilestones()).blocked.length;
    } catch {
      // An unreadable ledger is the doctor's problem. Report what is known.
    }

    lines.push(
      `  ${isOn() ? c.green('● Running') : c.yellow('● Paused')}   ` +
        `${c.dim('today')} ${c.bold(String(today))}${c.dim(`/${cfg.system.daily_target}`)}   ` +
        `${c.dim('jobs waiting')} ${c.bold(String(waiting))}   ` +
        // Only when there are any: a permanent "stopped 0" is a number the eye
        // learns to skip, on the one line where it must not.
        (stoppedJobs ? `${c.yellow('stopped')} ${c.bold(String(stoppedJobs))}   ` : '') +
        `${c.dim('projects')} ${c.bold(String(cfg.repos.length))}`,
    );
    /*
     * There are two separate things this can be waiting on, and the screen has
     * to distinguish them or it contradicts itself.
     *
     *   - Ideas in the inbox, not yet broken into jobs.
     *   - Jobs in the queue, planned and ready to run.
     *
     * Reading only the file said "nothing to do" while four jobs sat waiting,
     * directly under a line reading "jobs waiting 4". Reading only the queue
     * then said "Nothing to build" seconds after someone had told it exactly
     * what to build — which is the surest way to get the same idea typed twice,
     * planned twice and built twice.
     */
    const ideasWaiting = existsSync(INBOX());
    const state = overviewState({
      ready: counts.ready ?? 0,
      pending: counts.pending ?? 0,
      stopped: stoppedJobs + stoppedMilestones,
      ideasWaiting,
      running: isOn(),
    });

    if (state === 'stopped') {
      /*
       * Names the screen that can fix it, not the command. "What is it doing?"
       * now ends in the retry menu, so this is a route an operator can follow
       * without leaving the program.
       */
      const what =
        stoppedJobs && stoppedMilestones
          ? `${stoppedJobs} job(s) and ${stoppedMilestones} piece(s) of work have stopped`
          : stoppedJobs
            ? `${stoppedJobs} job(s) have stopped`
            : `${stoppedMilestones} piece(s) of work have stopped`;
      lines.push(`  ${c.yellow(`${what}. Nothing else is queued, so a run would find nothing to do.`)}`);
      lines.push(`  ${c.yellow('Choose "What is it doing?" to see why, and to put them back.')}`);
      if (ideasWaiting) {
        lines.push(`  ${c.dim('An idea of yours is also saved and not yet broken into jobs.')}`);
      }
    } else if (state === 'idea-waiting') {
      lines.push(
        `  ${c.dim('Your idea is saved and waiting to be broken into jobs. Choose "Start working now".')}`,
      );
    } else if (state === 'nothing') {
      lines.push(
        `  ${c.yellow('Nothing to build. Choose the first option and tell it what you want.')}`,
      );
    } else if (!ideasWaiting) {
      /*
       * Do not promise a start time the system cannot keep. Paused, it will not
       * begin at 07:00 or at any other time, and saying otherwise sends someone
       * away to wait for something that is never going to happen.
       */
      const start = cfg.system.work_hours?.start ?? '07:00';
      /*
       * "Ready" has to mean what the run means by it. `waiting` is ready +
       * pending, and a pending job is one whose dependency has not finished —
       * `selectBatch` cannot pick it. The screen read "7 job(s) ready" with 4
       * ready and 3 pending, and then the run it invited attempted 4. Same
       * mistake as the ideas/jobs one above, one line further down: two
       * different things counted as one, and the number contradicted by the
       * next screen.
       *
       * The pending ones are still worth saying — they are queued work, not
       * nothing — but they are said as what they are.
       */
      const ready = counts.ready ?? 0;
      const later = waiting - ready;
      const alsoLater = later ? ` ${later} more waiting on those to finish.` : '';
      if (ready === 0) {
        lines.push(
          `  ${c.dim(`${later} job(s) queued, but each is waiting on another to finish first.`)}`,
        );
      } else {
        lines.push(
          isOn()
            ? `  ${c.dim(`${ready} job(s) ready. Choose "Start working now", or it begins on its own at ${start}.${alsoLater}`)}`
            : `  ${c.yellow(`${ready} job(s) ready, but it is paused — it will not start on its own.${alsoLater}`)}`,
        );
      }
    }
  } catch (e) {
    lines.push(`  ${c.red('Something is wrong with the setup.')}`);
    lines.push(`  ${c.dim(String((e as Error).message).split('\n')[0] ?? '')}`);
    lines.push(`  ${c.dim(`Choose "Check everything is working" for the full picture.`)}`);
  }
  lines.push('');
  return lines;
}

/* ------------------------------------------------------------------ ideas */

async function tellItWhatToBuild(): Promise<void> {
  /*
   * The projects are read BEFORE anything is asked.
   *
   * loadConfig throws when repos.yaml is empty or malformed, and it used to be
   * called after the title had been typed — so the friendly "No projects yet"
   * screen below was unreachable dead code, and the first thing a new user saw
   * after typing their idea was a Node stack trace with the TUI gone and their
   * text lost. An empty list and an unreadable file look identical from here, so
   * both get the same plain answer.
   */
  let names: string[];
  try {
    names = loadConfig(true).repos.map((r) => r.id);
  } catch (e) {
    await notice('Cannot read your projects', [
      'ShanAuto keeps the list of folders it may work in at:',
      `  ${p('config', 'repos.yaml')}`,
      '',
      'That file could not be read, so there is nowhere to put your idea yet.',
      '',
      c.dim(`Details: ${(e as Error).message}`),
    ]);
    return;
  }
  if (names.length === 0) {
    // Offer the way out rather than describing it. This used to name a YAML file
    // to the one person who should never have to open one.
    const make = await confirm('There are no projects yet. Start one now?', [
      'ShanAuto needs somewhere to work before it can build anything.',
      'It will create the folder and set everything up for you.',
    ]);
    if (make) await newProjectScreen();
    return;
  }

  const title = await input('What should it build?', {
    subtitle: 'A short name for the job. You describe it properly on the next screen.',
    placeholder: 'e.g. Add a login page to my website',
  });
  if (!title) return;

  /*
   * "Example:" is how the sample ideas in the inbox are marked, and the planner
   * skips anything starting with it. Silently. Someone naming a real job
   * "Example: dark mode" would have watched it vanish with no message anywhere.
   */
  if (title.toLowerCase().startsWith('example:')) {
    await notice('Pick a different name', [
      'Names beginning with "Example:" are ignored — that is how the sample',
      'ideas in the file are marked, so a real job named that way is skipped.',
      '',
      `Try "${title.slice(8).trim() || 'Dark mode'}" instead.`,
    ]);
    return;
  }

  let repo = names[0]!;
  if (names.length > 1) {
    const pick = await menu(
      'Which project?',
      names.map((n) => ({ label: n, help: 'The work will be added to this project.' })),
      { subtitle: title },
    );
    if (pick < 0) return;
    repo = names[pick]!;
  }

  const body = await editor('Describe it', {
    subtitle: title,
    hint:
      'Write it as if explaining to a person. Say what should EXIST when it is done, ' +
      'not how to build it. Mention anything it must not do.',
  });
  if (!body) return;

  /*
   * A description is too short to plan from below 20 characters — the planner
   * drops it, silently, and nothing anywhere says so. Better to say it here,
   * while the person still has what they wrote.
   */
  if (body.length < 20) {
    await notice('That is a little too short', [
      'The planner needs enough to work from — a sentence or two about what',
      'should EXIST when the job is done.',
      '',
      'Nothing was saved. Choose the first option again and add some detail.',
    ]);
    return;
  }

  ensureDir(p('ideas'));
  /*
   * Ideas are separated by lines beginning "## ", so a description containing
   * one splits into two — the second half becoming a job of its own with a
   * heading for a title. Markdown headings are an entirely reasonable thing to
   * type. Indenting by two spaces reads the same and cannot start a new idea.
   */
  const safeBody = body.replace(/^(#{1,6}\s)/gm, '  $1');
  const entry = `\n## ${title}\n\nrepo: ${repo}\n\n${safeBody}\n`;
  if (existsSync(INBOX())) appendFileSync(INBOX(), entry, 'utf8');
  else writeFileSync(INBOX(), `# Idea inbox\n${entry}`, 'utf8');

  /*
   * Say it landed. Without this the screen returned straight to a main menu
   * still reading "Nothing to build" — because an idea is not a job until the
   * planner has run — and the obvious response is to type it again. Two
   * duplicate ideas, both planned, both built.
   */
  await notice('Saved', [
    c.green(`"${title}" has been added to ${repo}.`),
    '',
    'It is not a job yet. The planner turns your idea into small jobs, either',
    'now or at the next scheduled time — until then the main menu still shows',
    'nothing waiting. That is expected; you do not need to add it again.',
  ]);

  const now = await confirm('Work out the steps now?', [
    'This asks the planner to break your idea into small jobs.',
    'It takes a couple of minutes and uses a little of your daily allowance.',
    '',
    'If you say no, it will do it automatically at the next scheduled time.',
  ]);
  if (now) await runCommand('Working out the steps', ['plan']);
}

/* --------------------------------------------------------- new project */

/**
 * Start a project from nothing.
 *
 * Until this screen existed, every project ShanAuto worked on had to be created
 * by hand first — the folder, `git init`, the remote, and the entry in
 * repos.yaml — by someone comfortable doing all four. That is the one job this
 * interface exists to remove, and it was the one job it could not do.
 */
async function newProjectScreen(): Promise<void> {
  const name = await input('What should the project be called?', {
    subtitle: 'This becomes the folder name and the name on GitHub.',
    placeholder: 'e.g. abc',
  });
  if (!name) return;

  const bad = validateId(name);
  if (bad) {
    await notice('That name will not work', [bad, '', 'Nothing was created.']);
    return;
  }

  const parent = await input('Where should it go?', {
    subtitle: `A folder will be created inside this one, called "${name}".`,
    initial: defaultWorkspace(),
  });
  if (!parent) return;

  const target = join(parent, name);
  const blocked = checkTarget(target);
  if (blocked) {
    await notice('Cannot create it there', [blocked, '', 'Nothing was created.']);
    return;
  }

  const pick = await menu(
    'What is it built with?',
    STACKS.map((s) => ({
      label: s.label,
      help: `Its check starts as: ${s.floor}`,
    })),
    { subtitle: name, hint: '↑↓ move · Enter choose · Esc cancel' },
  );
  if (pick < 0) return;
  const stack = STACKS[pick]!;

  const purpose = await editor('What is it for?', {
    subtitle: name,
    hint:
      'A sentence or two. This is saved into the project and read every time it ' +
      'plans work, so it is worth being specific about what should EXIST.',
  });
  if (purpose === null) return;

  /*
   * Creating a GitHub repository publishes something under the owner's name, so
   * it is asked for explicitly and never assumed. Private is the only offer: a
   * public repo puts unreviewed, automated work on the open internet.
   */
  const wantRemote = await confirm(
    remoteQuestion.question,
    [...remoteQuestion.detail],
    remoteQuestion.opts,
  );

  const go = await confirm(`Create "${name}"?`, [
    `Folder:   ${target}`,
    `Built with: ${stack.label}`,
    `On GitHub: ${wantRemote ? 'yes, private' : 'no'}`,
    '',
    'ShanAuto will be allowed to work in this folder from then on.',
  ]);
  if (!go) return;

  const proj: NewProject = { id: name, path: target, stack, branch: 'main', purpose };

  let result;
  try {
    result = await scaffold(proj, { remote: wantRemote, visibility: 'private' });
    registerRepo(proj, result.verify_cmd);
  } catch (e) {
    await notice('It could not be created', [
      c.red((e as Error).message),
      '',
      // The folder may exist by now, so never claim nothing happened.
      `Check ${target} before trying again.`,
    ]);
    return;
  }

  await notice('Created', [
    c.green(`"${name}" is ready.`),
    '',
    `Folder:  ${result.path}`,
    `GitHub:  ${result.remote ?? 'not on GitHub'}`,
    `Check:   ${result.verify_cmd}`,
    '',
    ...result.notes.map((n) => c.dim(n)),
    result.notes.length ? '' : '',
    'Its check only looks for broken syntax for now — there is nothing to test',
    'yet. Once it has real tests, "Check everything is working" will offer to',
    'tighten it.',
    '',
    'Next: choose "Tell it what to build".',
  ]);
}

/** Where a new project goes unless the owner says otherwise. */
function defaultWorkspace(): string {
  try {
    // Alongside the projects already in use, which is where the owner is
    // already looking — rather than inside ShanAuto's own folder.
    const cfg = loadConfig(true);
    const first = cfg.repos[0]?.path;
    if (first) return join(first, '..').replace(/\\/g, '/');
  } catch {
    /* no projects yet, or the file is unreadable */
  }
  return join(ROOT, '..').replace(/\\/g, '/');
}

/* --------------------------------------------------------------- projects */

async function projectsScreen(): Promise<void> {
  for (;;) {
    let cfg;
    try {
      cfg = loadConfig(true);
    } catch (e) {
      await notice('Projects', [c.red((e as Error).message)]);
      return;
    }

    const items = cfg.repos.map((r) => ({
      label: r.id,
      help: `${r.path}  ·  checked with: ${r.verify_cmd}`,
      value: r.enabled ? 'on' : 'off',
    }));
    items.push({ label: 'Start a new project', help: 'Create a new folder, set it up, and let ShanAuto work in it.', value: '' });
    items.push({ label: c.dim('Back'), help: 'Return to the main menu.', value: '' });

    const pick = await menu('Your projects', items, {
      subtitle: 'The only folders ShanAuto is allowed to touch.',
      hint: '↑↓ move · Esc back',
    });
    if (pick < 0 || pick === cfg.repos.length + 1) return;
    if (pick === cfg.repos.length) {
      await newProjectScreen();
      continue;
    }

    const chosen = cfg.repos[pick]!;
    /*
     * Whether this project has anywhere to send its work.
     *
     * `doctor` has reported `remote MISSING (commits stay local)` since it was
     * written and no screen in this program could act on it. On 2026-08-27
     * example-ledger held 8 commits of ShanAuto's own work and example-receipts 7, all of
     * it on one machine, because the only route to a GitHub repository was a
     * flag at the moment a project was created.
     */
    let published = true;
    try {
      published = await hasRemote(chosen);
    } catch {
      // Unreadable git is the doctor's news to break, not this screen's.
    }

    if (published) {
      await notice(chosen.id, [
        `Folder:  ${chosen.path}`,
        `Branch:  ${chosen.branch}`,
        `Checked with:  ${chosen.verify_cmd}`,
        '',
        c.dim('Nothing is ever saved to this project unless that check passes.'),
        '',
        c.dim('To remove a project, edit config/repos.yaml. To add one, choose'),
        c.dim('"Start a new project" — it makes the folder and sets everything up.'),
      ]);
      continue;
    }

    const put = await confirm(`Put ${chosen.id} on GitHub?`, [
      `Folder:  ${chosen.path}`,
      '',
      'Its work is only on this computer at the moment, so none of it shows up',
      'on your GitHub. This creates a PRIVATE repository under your account,',
      'sends everything it has done so far, and from then on each new piece of',
      'work goes up on its own.',
      '',
      c.dim('Private means only you can see it. You can change that on GitHub later.'),
    ]);
    if (!put) continue;

    await runCommand(`Putting ${chosen.id} on GitHub`, ['publish', chosen.id]);
  }
}

/* ----------------------------------------------------------------- memory */

async function memoryScreen(): Promise<void> {
  for (;;) {
    const pick = await menu('What it remembers', [
      { label: 'Ask a question', help: 'Ask about anything it has done, in your own words. Uses a little of your allowance.' },
      { label: 'Search for a word', help: 'Find past work mentioning a word. Free, and instant.' },
      { label: "Read today's diary", help: 'Exactly what it tried today, and how each attempt went.' },
      { label: c.dim('Back'), help: 'Return to the main menu.' },
    ]);
    if (pick < 0 || pick === 3) return;

    if (pick === 0) {
      const q = await input('Ask about past work', {
        subtitle: 'For example: why did it stop working on the login page?',
        placeholder: 'Type your question',
      });
      if (q) await runCommand('Thinking', ['ask', q]);
    } else if (pick === 1) {
      const q = await input('Search', { placeholder: 'e.g. login' });
      if (q) await runCommand('Searching', ['recall', q]);
    } else {
      const days = journalDays();
      if (days.length === 0) {
        await notice("Today's diary", ['Nothing yet — it writes this as it works.']);
        continue;
      }
      /*
       * Paged, not truncated. It was cut to the first 200 lines with nothing
       * saying more existed — and a day that went well runs to several hundred.
       * The end of the day is the part anyone is actually looking for.
       */
      const day = days[days.length - 1]!;
      await pager(`Diary — ${day}`, readDay(day).split('\n'));
    }
  }
}

/**
 * What is it doing — and, if the answer is "nothing", how to change that.
 *
 * The status screen has always been able to say that work has stopped. Every
 * way out of it was a terminal command printed at the bottom: `npm run sa --
 * retry --failed`, `npm run sa -- retry <milestoneId>`. This screen exists so
 * that an operator who does not work in a terminal never has to type one, and
 * for the four stopped jobs sitting in example-ledger on 2026-08-27 there was no
 * button anywhere in this program that could move them.
 *
 * The actions are offered only when there is something to act on. A menu that
 * always shows "put the stopped jobs back" teaches the reader to ignore it on
 * the days it matters.
 *
 * Both shell out to the same `sa retry` the status screen names, per the rule
 * at the top of this file: the TUI must never reimplement a command, or the
 * two will drift and it will be the TUI that is wrong.
 */
export interface StoppedAction {
  label: string;
  help: string;
  /** Right-aligned count, where there is one worth showing. */
  value?: string;
  /** The `sa` command this runs. */
  args: string[];
  /** Heading for the command screen while it runs. */
  title: string;
}

/**
 * What can be restarted, and the exact command that restarts it.
 *
 * A pure function of the ledger's answer, separated from the screen for one
 * reason: the labels and the commands have to come from the same place. A menu
 * that builds its rows in one list and dispatches from a switch on the index is
 * a menu where a button can quietly start doing something else - and this
 * program has already been bitten four times by a rule that was proven while
 * nothing proved anyone called it.
 *
 * Returns an empty list when there is nothing stopped, which is what keeps the
 * screen from offering an action on the days there is nothing to act on.
 */
/**
 * The one question in this program whose safe-looking answer is the broken one.
 *
 * Exported as DATA rather than asked inline, for the same reason
 * `stoppedActions` is: a `confirm(...)` written out at its call site can lose
 * its options in an edit and every test still passes, because the tests are
 * all on `confirm`. That is not hypothetical — deleting `{ defaultYes: true }`
 * from this file left the whole suite green, which is the fifth time in this
 * project a rule was proven correct while nothing proved anyone called it.
 *
 * So the wording, the explanation and the default live in one object that the
 * screen spreads into `confirm`, and the test asserts on the object.
 */
export const remoteQuestion = {
  question: 'Also create it on GitHub?',
  detail: [
    'A PRIVATE repository, so nobody else can see it.',
    'Without this, everything still works — the changes just stay on this computer',
    'and will not appear on your GitHub profile.',
  ],
  /*
   * Opens on Yes. This system exists to push what survives the gate, and
   * a project that never leaves this computer is not a safer version of that —
   * it is a failure of it, and it fails silently: every run succeeds, every
   * commit lands, and none of the work appears on the profile it was for.
   *
   * Safe to pre-select because it is not the last word. The screen asks
   * `Create "name"?` immediately afterwards, which lists whether it is going on
   * GitHub and still opens on No, so nothing is created by a stray Enter.
   */
  opts: { defaultYes: true },
} as const;

export function stoppedActions(
  jobs: number,
  milestones: { id: string; title: string }[],
): StoppedAction[] {
  const out: StoppedAction[] = [];

  if (jobs > 0) {
    out.push({
      label: 'Put the stopped jobs back',
      help: 'Queues every stopped job again, and frees anything waiting behind them.',
      value: String(jobs),
      args: ['retry', '--failed'],
      title: 'Putting the stopped jobs back',
    });
  }

  for (const m of milestones) {
    out.push({
      label: `Plan again: ${m.title}`,
      help: 'Every job for this was tried and none worked. This asks for a fresh plan.',
      args: ['retry', m.id],
      title: `Planning again: ${m.title}`,
    });
  }

  return out;
}

async function whatIsItDoing(): Promise<void> {
  await runCommand('What is it doing', ['status']);

  for (;;) {
    /*
     * Re-read inside the loop. After a retry the previous answer is stale, and
     * offering to requeue jobs that are already queued is how an operator
     * spends a second run learning nothing happened.
     */
    let stoppedJobs = 0;
    let stoppedMilestones: { id: string; title: string }[] = [];
    try {
      stoppedJobs = ledger.recentFailures(50).length + ledger.deadlockedTaskIds().size;
      stoppedMilestones = ledger
        .partitionStuck(ledger.stuckMilestones())
        .blocked.slice(0, 5)
        .map((m) => ({ id: m.id, title: m.title }));
    } catch {
      // No ledger yet, or it cannot be read. The status screen above has
      // already said so far better than a menu could.
      return;
    }

    const actions = stoppedActions(stoppedJobs, stoppedMilestones);
    if (!actions.length) return;

    const pick = await menu(
      'Some work has stopped',
      [
        ...actions.map((a) => ({ label: a.label, help: a.help, value: a.value })),
        { label: c.dim('Back'), help: 'Leave things as they are.' },
      ],
      {
        subtitle: 'Nothing here spends anything until you choose "Start working now".',
        hint: '↑↓ move · Enter choose · q back',
      },
    );

    // Anything past the last action is Back, and so is a dismissed menu.
    const chosen = actions[pick];
    if (!chosen) return;
    await runCommand(chosen.title, chosen.args);
  }
}

/* ------------------------------------------------------------------- main */

export async function tui(): Promise<void> {
  /*
   * node:sqlite prints an ExperimentalWarning on first use. Harmless, and it
   * lands in the middle of the menu looking like something has gone wrong — to
   * the one person using this screen, who cannot tell a warning about a database
   * driver from a real failure.
   */
  process.removeAllListeners('warning');
  process.on('warning', () => undefined);

  hideCursor();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    showCursor();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    /*
     * Let the process end.
     *
     * readKey resumes stdin on every keypress, which keeps a handle open on the
     * event loop. Choosing Quit cleared the screen and then sat there with a
     * dead terminal — no menu, no prompt, no response to typing — until Ctrl-C.
     * The one screen written for someone who does not use a terminal ended by
     * requiring a terminal shortcut to escape.
     */
    process.stdin.pause();
    process.stdin.unref();
  };
  process.on('exit', restore);

  try {
    for (;;) {
      const on = isOn();
      const pick = await menu(
        'Main menu',
        [
          { label: 'Tell it what to build', help: 'Describe something you want made. This is the main thing you do here.' },
          { label: 'Start working now', help: 'Begin working through the jobs it has planned. You can stop at any time.' },
          { label: on ? 'Pause it' : 'Let it run again', help: on ? 'Stops after the job it is on. Nothing is lost.' : 'Allows it to work again, including at its scheduled times.' },
          { label: 'What is it doing?', help: 'Jobs waiting, work done today, and anything that needs you.' },
          { label: 'What it remembers', help: 'Ask about past work, or read what it did today.' },
          { label: "Today's summary", help: 'A written report of the day so far.' },
          { label: 'Your projects', help: 'The folders it is allowed to work in.' },
          { label: 'Settings', help: 'How hard it works, when, and what it keeps. Changed with arrow keys.' },
          { label: 'Check everything is working', help: 'Tests each helper, your projects and the connection to GitHub.' },
          { label: c.dim('Quit'), help: 'Close this screen. Anything running carries on.' },
        ],
        {
          subtitle: 'Use ↑ ↓ to move, Enter to choose.',
          body: overview(),
          hint: '↑↓ move · Enter choose · q quit',
        },
      );

      switch (pick) {
        case 0:
          await tellItWhatToBuild();
          invalidateOverview(); // may have added an idea
          break;
        case 1: {
          if (!isOn()) {
            const go = await confirm('It is paused. Let it run?', [
              'Nothing will happen while it is paused.',
            ]);
            if (!go) break;
            /*
             * Cleared inline, not by spawning `sa resume` — which is this exact
             * line plus a log call (index.ts), wrapped in a command screen. And
             * every command screen ends on "Finished. Press any key to go
             * back.".
             *
             * That is what an operator saw on 2026-08-15 after answering "yes,
             * let it run": the system's own end-of-operation screen, offering
             * to take them back to the menu, before a single job had started.
             * The keypress they then made to dismiss it was the one that set
             * agents writing to their repo. Same sentence as the end of a real
             * run, opposite meaning, and it is the start of unattended work
             * that it hides.
             *
             * The Pause row's un-pause branch below already did it this way, so
             * the two ways to un-pause now also agree.
             */
            if (existsSync(KILLSWITCH())) unlinkSync(KILLSWITCH());
          }
          await runCommand('Working', ['run']);
          invalidateOverview(); // commits happened, jobs were consumed
          break;
        }
        case 2: {
          if (on) {
            const yes = await confirm('Pause ShanAuto?', [
              'It finishes the job it is on, then stops.',
              'Nothing is lost, and no work is thrown away.',
            ]);
            if (yes) {
              ensureDir(stateRoot());
              writeFileSync(KILLSWITCH(), new Date().toISOString());
              await notice('Paused', ['It will not start any new work until you let it run again.']);
            }
          } else {
            /*
             * Un-pausing asks too. Pausing did and this did not, so the two
             * halves of one toggle behaved differently — and this is the half
             * that starts agents writing to your projects unattended. Someone
             * who paused it for a reason can arrive back on this row by pressing
             * Enter one time too many.
             */
            const yes = await confirm('Let ShanAuto run again?', [
              'It will start working on its own at its scheduled times, and',
              'may change files in your projects while you are not watching.',
              '',
              'Every change still has to pass your project\'s own check first.',
            ]);
            if (!yes) break;
            if (existsSync(KILLSWITCH())) unlinkSync(KILLSWITCH());
            await notice('Running again', ['It will pick up work at its next scheduled time, or when you start it.']);
          }
          invalidateOverview(); // the Running/Paused line changed either way
          break;
        }
        case 3:
          await whatIsItDoing();
          invalidateOverview(); // a retry moves jobs back into the queue
          break;
        case 4: await memoryScreen(); break;
        case 5: await runCommand("Today's summary", ['report']); break;
        case 6:
          await projectsScreen();
          invalidateOverview(); // may have created a project
          break;
        case 7:
          await settingsScreen(() => loadConfig(true).system as unknown as Record<string, unknown>);
          invalidateOverview(); // daily_target / work_hours may have changed
          break;
        case 8: await runCommand('Checking', ['doctor']); break;
        default: {
          clear();
          restore();
          return;
        }
      }
    }
  } finally {
    restore();
  }
}
