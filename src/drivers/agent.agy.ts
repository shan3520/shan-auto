import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDriver, DriverOpts, ExecResult, OriginatingIdea } from './contracts.js';
import type { Repo, TaskRow } from '../schemas.js';
import { taskPrompt } from '../core/taskprompt.js';
import { archiveSafe, log } from '../logger.js';
import { deniedCommand } from './agy-denied.js';
import { safeEnv } from '../util.js';

/**
 * Antigravity's actual CLI (`agy`), not the IDE launcher.
 *
 * The IDE binary (`antigravity.cmd`) is just the VS Code command line and cannot
 * drive the agent. `agy` is a separate program, installed alongside it at
 * %LOCALAPPDATA%\agy\bin\agy.exe, and it is fully scriptable:
 *
 *   -p / --print        run one prompt non-interactively and print the response
 *   --add-dir           the directory the agent may work in
 *   --print-timeout     hard limit on a single run
 *   --model             model override
 *
 * Verified working 2026-08-06 on agy 1.0.7: writes files, exits 0, prints plain
 * text on stdout. It auto-approves ordinary edits inside an added directory, so
 * `--dangerously-skip-permissions` is NOT needed and is off by default.
 *
 * IMPORTANT: agy ignores the process working directory. Without `--add-dir` it
 * writes into its own scratch workspace (~/.gemini/antigravity-cli/scratch) and
 * cheerfully reports success, having touched nothing in your repo.
 */

/** agy has no structured output, so failures are matched on message text. */
const QUOTA_PATTERNS = [
  /quota/i,
  /rate.?limit/i,
  /resource.?exhausted/i,
  /too many requests/i,
  /ineligible/i,
  /no longer supported/i,
];
const AUTH_PATTERNS = [/unauthor/i, /not logged in/i, /authenticat/i, /credential/i, /sign in/i];

/**
 * agy's own words, with the agent's text taken out.
 *
 * The harness error and the agent's narrative share one stream, so a pattern
 * written for a harness message can match code the agent happened to write.
 * Measured 2026-08-20: a denial quoted the agent's own Python back at us, that
 * line contained `_get_authenticated_client(...)`, /authenticat/i matched, and
 * the run ended with `agy is out for this run — AUTH` while the credentials were
 * fine and seven tasks were still queued.
 *
 * Everything agy quotes is the agent's, not agy's: the command inside
 * `permission check failed for command "..."`, and any fenced code block. Blank
 * those out and the patterns below only ever see text agy itself produced.
 *
 * This is the general form of the bug the QUOTA comment in `execute` already
 * describes — a task about retry logic writing "rate limit" and aborting a run
 * that had succeeded. `looksFailed` narrowed that to failed runs; it cannot help
 * when the run really did fail, just not for the reason the pattern claims.
 */
export function harnessText(out: string): string {
  return out
    .replace(/(permission check failed for command\s+)"(?:[^"\\]|\\.)*"/gi, '$1"<command>"')
    .replace(/```[\s\S]*?```/g, '<code>');
}

/**
 * agy auto-approves file edits in headless mode but auto-DENIES the `command`
 * permission, because there is nobody to prompt. Any task needing to run a shell
 * command (install a dep, run a test) then half-completes and reports success.
 *
 * That presents as random NO_CHANGES / VERIFY_FAIL on tasks that look fine, so
 * it gets its own reason code rather than being mistaken for a lazy agent.
 * Fix by allow-listing commands in agy's settings.json - see README.
 */
const PERMISSION_PATTERNS = [
  /permission that headless mode cannot prompt for/i,
  /auto-denied/i,
  /permissions\.allow/i,
  // agy 1.1.14's wording, seen 2026-08-20. None of the three above matched it,
  // so a denial did not even reach the handler below — it fell through to the
  // fatal AUTH guess instead. Kept alongside the older strings rather than
  // replacing them: agy's message text has changed once and will again.
  /permission check failed/i,
];

/**
 * Non-negotiable denies, mirroring the opencode/copilot lists.
 *
 * agy has no `--deny-tool` flag (copilot) and no injected config (opencode); its
 * permissions live in `settings.json`, a file the agent could in principle be
 * talked into editing. These entries must nevertheless be present there. They
 * are the backstop that survives a later `command(*)`, and `execute` refuses to
 * run an UNSANDBOXED agy without them — which is what makes this list as
 * un-skippable as copilot's flags.
 *
 * The set matches what `scripts/agy-access.ps1 -Apply` currently writes; a
 * stronger set is a contract change, applied when the script is next run.
 */
export const MINIMUM_DENY: readonly string[] = [
  // Destructive filesystem operations
  'command(rm)', 'command(rmdir)', 'command(del)', 'command(erase)', 'command(rd)',
  'command(Remove-Item)', 'command(format)', 'command(diskpart)', 'command(takeown)',
  'command(icacls)', 'command(Set-Acl)', 'command(New-LocalUser)',
  // Interpreter one-liners (SEC-2): arbitrary code behind a matcher's back
  'command(node -e)', 'command(node --eval)', 'command(python -c)', 'command(powershell -c)',
  'command(powershell -Command)', 'command(pwsh -c)', 'command(cmd /c)', 'command(sh -c)',
  'command(bash -c)', 'command(Invoke-Expression)', 'command(iex)',
  // Git history / remotes / credentials: the orchestrator owns git
  'command(git push)', 'command(git reset)', 'command(git clean)', 'command(git checkout)',
  'command(git commit)', 'command(git rebase)', 'command(gh)',
  // Machine and account state
  'command(shutdown)', 'command(reg)', 'command(sc)', 'command(net)', 'command(schtasks)',
  // Network egress and publish-to-account
  'command(curl)', 'command(wget)', 'command(iwr)', 'command(Invoke-WebRequest)',
  'command(npm publish)', 'command(npm login)',
];

/** Where agy's allow-list lives. Overridable so tests point at a throwaway file. */
export function agySettingsPath(): string {
  return (
    process.env.SHANAUTO_AGY_SETTINGS ??
    join(process.env.USERPROFILE ?? '', '.gemini', 'antigravity-cli', 'settings.json')
  );
}

/** The agent must never be allowed to edit the file this check reads. */
export function selfProtectionDeny(): string {
  return `write_file(${agySettingsPath()})`;
}

/**
 * Read the `permissions.deny` array from agy's settings.json.
 *
 * `null` means "cannot verify" (file missing, unreadable, or corrupt) — for the
 * unsandboxed pre-flight that is the same as "no denies", so it fails closed.
 */
export function readAgyDenies(): string[] | null {
  const file = agySettingsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      permissions?: { deny?: unknown };
    };
    return Array.isArray(parsed?.permissions?.deny) ? (parsed.permissions.deny as string[]) : [];
  } catch {
    return null;
  }
}

/** Which mandatory denies are absent, given the file's deny array (or null). */
export function missingAgyDenies(deny: string[] | null): string[] {
  const required = [...MINIMUM_DENY, selfProtectionDeny()];
  if (!deny) return required;
  const have = new Set(deny);
  return required.filter((d) => !have.has(d));
}

/**
 * Whether agy's output should be scanned for error signatures at all.
 *
 * A zero exit with a substantive narrative means the agent did its job, and its
 * prose must not be mined for words like "rate limit" — a task about retry logic
 * tripped exactly that and aborted a whole run after the work had succeeded.
 */
export function looksFailed(exitCode: number | undefined, out: string): boolean {
  return exitCode !== 0 || out.trim().length < 40;
}

/** What a run's text says went wrong, or null when it names nothing. */
export type AgyVerdict = 'PERMISSION_DENIED' | 'QUOTA' | 'AUTH' | null;

/**
 * Read a finished run's output and say what happened.
 *
 * Pulled out of `execute` so the ORDER of these three can be tested, because
 * the order is the whole bug. On 2026-08-20 a denied command was tested against
 * AUTH first, matched `_get_authenticated_client` in the agent's own quoted
 * Python, and came back `AUTH` — fatal. The executor marked agy out for the
 * run; copilot had been removed in 1c3db1c, so no complex agent was left and
 * the run stopped with seven tasks still queued and working credentials.
 *
 * The rule that prevents it: a denial is something agy STATES, while quota and
 * auth are INFERRED from loose wording that the agent can write by accident. A
 * stated fact outranks a guess, so the denial is tested first — and it is not
 * fatal, because agy edits files perfectly well while refusing to run commands.
 *
 * `looksFailed` still guards the two inferred verdicts, and still is not enough
 * on its own: here the run really had failed, just not for the reason the
 * pattern claimed. `harnessText` is the other half — it takes the agent's text
 * out before any of these patterns see it.
 */
export function classifyAgyOutput(out: string, exitCode: number | undefined): AgyVerdict {
  const harness = harnessText(out);
  if (PERMISSION_PATTERNS.some((re) => re.test(harness))) return 'PERMISSION_DENIED';
  /*
   * Only classify failures when the run actually failed.
   *
   * agy has no structured output — the agent's narrative and any error share one
   * text stream. Scanning that narrative for error signatures produces false
   * positives: a task about retry logic made the agent write the words "rate
   * limit", which was read as provider throttling and aborted the entire run
   * after the task had in fact succeeded.
   *
   * A zero exit with substantive output is a success. Do not second-guess it.
   */
  if (looksFailed(exitCode, out)) {
    if (QUOTA_PATTERNS.some((re) => re.test(harness))) return 'QUOTA';
    if (AUTH_PATTERNS.some((re) => re.test(harness))) return 'AUTH';
  }
  return null;
}

export class AgyAgent implements AgentDriver {
  readonly id = 'agy';
  readonly kind = 'cli' as const;
  private bin: string;
  private model: string | undefined;
  private skipPermissions: boolean;
  private sandbox: boolean;

  constructor(opts: DriverOpts) {
    this.bin =
      (opts.bin as string) ??
      `${process.env.LOCALAPPDATA ?? ''}\\agy\\bin\\agy.exe`;
    this.model = opts.model as string | undefined;
    // Off by default. Ordinary edits inside --add-dir are approved without it;
    // turning it on removes the last prompt-based brake on what the agent may do.
    this.skipPermissions = opts.skip_permissions as boolean;
    // ON by default, and deliberately so: agy's terminal restrictions are the
    // only thing standing between an unattended shell command and the rest of
    // the machine. Nothing else in this system contains it — the commit gate
    // inspects the git diff after the fact, so a deletion outside the repo is
    // invisible to it and unrecoverable by rollback.
    //
    // The value always arrives from the config schema (schemas.ts), which
    // defaults an omitted `sandbox` to true and lets production drivers.yaml
    // write false explicitly. The driver no longer guesses a default.
    this.sandbox = opts.sandbox as boolean;
  }

  async healthCheck() {
    if (!existsSync(this.bin)) return { ok: false, detail: `agy not found at ${this.bin}` };
    const r = await execa(this.bin, ['--version'], { reject: false, stdin: 'ignore', timeout: 30_000 });
    const base = r.exitCode === 0 ? `agy ${r.stdout.trim()}` : `not runnable: ${r.stderr}`;
    /*
     * Doctor must not report "all checks passed" over an unsandboxed agy whose
     * settings.json has lost its mandatory denies — that is the one state where
     * the allow-list is the only control and it has been degraded. Sandboxed,
     * the sandbox itself denies commands, so a missing deny is noted in `detail`
     * rather than treated as fatal.
     */
    const missing = missingAgyDenies(readAgyDenies());
    if (missing.length) {
      const note =
        `; permissions file is missing ${missing.length} mandatory deny rule(s)` +
        (this.sandbox ? '' : ' — run scripts/agy-access.ps1 -Apply');
      return { ok: !this.sandbox ? false : r.exitCode === 0, detail: `${base}${note}` };
    }
    return { ok: r.exitCode === 0, detail: base };
  }

  private buildPrompt(
    task: TaskRow,
    repo: Repo,
    context?: string,
    rework?: string,
    idea?: OriginatingIdea | null,
  ): string {
    return taskPrompt(task, {
      opening: 'Implement exactly this one change in the workspace directory.',
      extraConstraints: [
        '- Work ONLY inside the workspace directory that was added. Never write to a scratch folder.',
      ],
      context,
      // Empty on a first attempt. See taskprompt's `rework`.
      rework,
      checkCmd: repo.agent_check_cmd,
      // null unless routing.brief_for lists this agent. Passing it
      // unconditionally keeps the two drivers identical here: which agents
      // are briefed is a routing decision, not a property of the driver.
      brief: task.brief ?? undefined,
      // Passed down from the executor, not read here: a driver that opens the
      // ledger to build a prompt has taken on the ledger's lifetime, and two
      // suites proved it - one deadlocked on the db file it could no longer
      // unlink, the other lost its brief to the throw.
      idea,
      // agy's allow-list is exact-match and default-deny (issue #614: no globs,
      // no prefixes), and headless it cannot prompt. A near-miss is a refusal.
      shellIsAllowlisted: true,
    });
  }

  async execute(
    task: TaskRow,
    repo: Repo,
    timeoutS: number,
    context?: string,
    rework?: string,
    idea?: OriginatingIdea | null,
  ): Promise<ExecResult> {
    /*
     * Pre-flight (SEC-1's deny-list pattern, enforced here rather than left to a
     * manual script). With sandbox OFF, the allow-list in settings.json is the
     * only thing between the agent and the machine, so a run is refused when the
     * non-negotiable deny set is missing from it. With sandbox ON the sandbox
     * itself denies every terminal command, so a degraded deny list rates a
     * warning, not a refusal.
     */
    const missing = missingAgyDenies(readAgyDenies());
    if (!this.sandbox && missing.length) {
      const detail =
        `agy permissions file (${agySettingsPath()}) is missing ${missing.length} mandatory deny ` +
        `rule(s): ${missing.join(', ')}. Run scripts/agy-access.ps1 -Apply (or set sandbox: true).`;
      log.error(`[${task.id}] ${detail}`);
      return { ok: false, stdout: detail, durationMs: 0, reason: 'AGY_PERMISSIONS' };
    }
    if (missing.length) {
      log.warn(
        `[${task.id}] agy permissions file is missing ${missing.length} deny rule(s); ` +
          `running sandboxed, so commands stay denied.`,
      );
    }

    const started = Date.now();
    /*
     * O28: what it was asked, kept beside what it said, and written BEFORE the
     * call so a prompt that ends in a hang or a crash is still on disk. See
     * askloop.ts for the finding.
     */
    const promptText = this.buildPrompt(task, repo, context, rework, idea);
    archiveSafe(`agent-agy-${task.id}-prompt`, promptText);
    const args = [
      '-p',
      promptText,
      // Without this, agy silently works in its own scratch dir instead of the repo.
      '--add-dir',
      repo.path,
      '--print-timeout',
      `${Math.max(1, Math.floor(timeoutS / 60))}m`,
    ];
    if (this.model) args.push('--model', this.model);
    if (this.sandbox) args.push('--sandbox');
    if (this.skipPermissions) {
      args.push('--dangerously-skip-permissions');
      if (!this.sandbox) {
        log.warn(
          `agy running with skip_permissions AND no sandbox on ${task.id} — ` +
            `every tool call is auto-approved with an unrestricted shell.`,
        );
      }
    }

    const res = await execa(this.bin, args, {
      cwd: repo.path,
      reject: false,
      // Belt and braces: agy has its own --print-timeout, this is the outer bound.
      timeout: (timeoutS + 60) * 1000,
      killSignal: 'SIGKILL',
      stdin: 'ignore',
      // Strip the environment (SEC-1/SEC-3). agy's sandbox confines the agent to
      // the workspace, but the fallback shell is unrestricted — and without
      // `--sandbox` it is deliberately wide open, so credentials must not be in
      // the child env. agy authenticates from its stored Antigravity session.
      extendEnv: false,
      env: safeEnv({ NO_COLOR: '1' }),
      maxBuffer: 64 * 1024 * 1024,
    });

    const durationMs = Date.now() - started;
    const out = stripAnsi(`${res.stdout ?? ''}\n${res.stderr ?? ''}`).trim();

    // Archived before parsing. Nothing downstream trims any more, but a parse
    // failure would still leave the original unreachable without this.
    const rawPath = archiveSafe(`agent-agy-${task.id}`, out);

    if (res.timedOut) {
      log.warn(`agy timed out on ${task.id} after ${timeoutS}s`);
      return { ok: false, stdout: out, durationMs, reason: 'TIMEOUT', rawPath };
    }

    const verdict = classifyAgyOutput(out, res.exitCode);

    if (verdict === 'QUOTA') {
      log.warn(`agy quota/eligibility problem on ${task.id}`);
      return { ok: false, fatal: true, stdout: out, durationMs, reason: 'QUOTA', rawPath };
    }
    if (verdict === 'AUTH') {
      return { ok: false, fatal: true, stdout: out, durationMs, reason: 'AUTH', rawPath };
    }
    if (verdict === 'PERMISSION_DENIED') {
      // A denied command does NOT mean nothing useful happened — agy edits files
      // fine and only loses the ability to run things. Verified: it still wrote a
      // correct file while reporting this. So hand it to the gate rather than
      // discarding the work here; if the change is incomplete, `verify_cmd` will
      // fail it, and if it is complete it deserves to land.
      const denied = deniedCommand(started);
      log.warn(
        `agy was denied a tool permission on ${task.id} — letting the gate judge the result.`,
      );
      if (denied) {
        log.warn(`      it wanted to run:  ${denied}`);
        log.warn(`      to allow that, add exactly this line to config/agy-permissions.example.json`);
        log.warn(`      then run scripts/agy-access.ps1 -Apply:`);
        log.warn(`          command(${denied})`);
      } else {
        // agy's own message names no command, so there is nothing honest to
        // print here. Say so rather than inventing advice the operator cannot use.
        log.warn(`      agy did not say which command, and its transcript no longer shows one.`);
      }
      return { ok: true, stdout: out, durationMs, reason: 'PERMISSION_DENIED', rawPath };
    }

    if (res.exitCode !== 0) {
      return { ok: false, stdout: out, durationMs, reason: `EXIT_${res.exitCode}`, rawPath };
    }
    return { ok: true, stdout: out, durationMs, rawPath };
  }
}

export default AgyAgent;
