import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import type { AgentDriver, DriverOpts, ExecResult, OriginatingIdea } from './contracts.js';
import type { Repo, TaskRow } from '../schemas.js';
import { taskPrompt } from '../core/taskprompt.js';
import { archiveSafe, log } from '../logger.js';
import { safeEnv } from '../util.js';
import { parseOcStream, isFatal } from './ocstream.js';

/**
 * Injected per run at the highest config precedence, so no per-repo opencode.json
 * is needed and the repo's own config cannot loosen these.
 *
 * Anything set to "ask" would block forever in a non-interactive run - there is
 * nobody to answer it - so every permission here is an explicit allow or deny.
 * `external_directory: deny` is a real guardrail: the agent cannot wander outside
 * the repo it was pointed at, whatever the task text says.
 */
const AGENT_CONFIG = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  permission: {
    read: 'allow',
    edit: 'allow',
    glob: 'allow',
    grep: 'allow',
    lsp: 'allow',
    doom_loop: 'allow',
    external_directory: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    question: 'deny',
    /**
     * The agent needs a shell to run builds and tests, but an unattended agent
     * with an unrestricted shell can do anything this Windows account can — and
     * nothing else in this system would stop it. The commit gate inspects the
     * git diff *after* the fact, so a deletion outside the repo is invisible to
     * it, and `git rollback` only restores tracked files inside the repo.
     *
     * Last matching rule wins, so the catch-all goes first.
     */
    bash: {
      '*': 'allow',
      // Destructive filesystem operations
      'rm *': 'deny',
      'rmdir *': 'deny',
      'del *': 'deny',
      'rd *': 'deny',
      'Remove-Item *': 'deny',
      'format *': 'deny',
      'takeown *': 'deny',
      'icacls *': 'deny',
      'attrib *': 'deny',
      // The orchestrator owns git. An agent must never touch history or remotes.
      'git push *': 'deny',
      'git remote *': 'deny',
      'git credential *': 'deny',
      'git reset *': 'deny',
      'git clean *': 'deny',
      'git checkout *': 'deny',
      'git rebase *': 'deny',
      'git commit *': 'deny',
      // Machine / account state
      'shutdown *': 'deny',
      'reg *': 'deny',
      'net user *': 'deny',
      'schtasks *': 'deny',
      'sc *': 'deny',
      // Pipe-to-shell, the classic remote-code path
      'curl *': 'deny',
      'curl.exe *': 'deny',
      'wget *': 'deny',
      'iwr *': 'deny',
      'irm *': 'deny',
      'Invoke-WebRequest *': 'deny',
      'Invoke-Expression *': 'deny',
      /*
       * Interpreter one-liners (SEC-2): a prompt string becomes arbitrary code
       * behind the matcher's back, so every deny above it — `rm *`, `curl *`,
       * `git push *` — is reachable through one.
       *
       * `python -c` was removed from this list on 2026-08-27, by the operator,
       * after run 34 recorded `BLOCKED — the agent was denied 1 tool
       * permission(s): bash: python -c` on a task it then failed.
       *
       * What that decision actually costs is less than it looks, and the
       * comment above already says why: "the agent can run scripts it wrote to
       * disk". An agent with `edit: allow` writes `probe.py` and runs
       * `python probe.py`, which this list permits and which does everything
       * `python -c` does. The one-liner denies were a speed bump over a wall
       * that is not there. Removing one makes explicit what was already
       * reachable rather than granting a new capability.
       *
       * The rest stay. Not because they are harder to route around — they are
       * not — but because nothing has asked for them, and a deny nobody is
       * fighting costs nothing to keep. `node -e` in particular is denied for a
       * python project that has no reason to run node at all.
       *
       * To put it back: restore `'python -c *': 'deny'` below. There is no
       * separate switch, deliberately — a permission that can be widened from
       * two places is one nobody can audit from either.
       */
      'node -e *': 'deny',
      'node -p *': 'deny',
      'node --eval *': 'deny',
      'node --input-type=*': 'deny',
      'bash -c *': 'deny',
      'sh -c *': 'deny',
      'cmd /c *': 'deny',
      'cmd /k *': 'deny',
      'powershell *': 'deny',
      'powershell.exe *': 'deny',
      'pwsh *': 'deny',
      // Publishing on your behalf
      'npm publish *': 'deny',
      'gh *': 'deny',
    },
  },
});

/**
 * The autonomous workhorse. `opencode run` is non-interactive, accepts a working
 * directory, and exits on its own - which is everything an unattended loop needs.
 */
export class OpenCodeAgent implements AgentDriver {
  readonly id = 'opencode';
  readonly kind = 'cli' as const;
  private model: string;
  private bin: string;

  constructor(opts: DriverOpts) {
    this.model = (opts.model as string) ?? 'google/gemini-3.6-flash';
    this.bin = (opts.bin as string) ?? 'opencode';
  }

  async healthCheck() {
    const r = await execa(this.bin, ['--version'], { reject: false });
    return {
      ok: r.exitCode === 0,
      detail: r.exitCode === 0 ? `opencode ${r.stdout.trim()}` : `not runnable: ${r.stderr}`,
    };
  }

  private buildPrompt(
    task: TaskRow,
    repo: Repo,
    context?: string,
    rework?: string,
    idea?: OriginatingIdea | null,
  ): string {
    return taskPrompt(task, {
      opening: 'Implement exactly this one change in the current repository.',
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
      // AGENT_CONFIG above allows bash '*' and denies a named list, so an
      // improvised test command runs. It is pointed at the configured one to
      // save it guessing, not because a guess would be refused.
      shellIsAllowlisted: false,
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
    const started = Date.now();
    /*
     * O28: what it was asked, kept beside what it said, and written BEFORE the
     * call so a prompt that ends in a hang or a crash is still on disk. See
     * askloop.ts for the finding.
     */
    const promptText = this.buildPrompt(task, repo, context, rework, idea);
    archiveSafe(`agent-opencode-${task.id}-prompt`, promptText);
    const res = await execa(
      this.bin,
      ['run', '--format', 'json', '-m', this.model, promptText],
      {
        cwd: repo.path,
        reject: false,
        timeout: timeoutS * 1000,
        killSignal: 'SIGKILL',
        // See brain.opencode.ts: piped stdin makes opencode hang before the LLM call.
        stdin: 'ignore',
        // Strip the environment down to a safe allowlist (SEC-1/SEC-3): the
        // agent's shell runs arbitrary code, so the owner's credentials must not
        // be in it. OPENCODE_CONFIG_CONTENT is deliberately preserved — it is
        // the guardrail config injected above, not a secret.
        extendEnv: false,
        env: safeEnv({ NO_COLOR: '1', OPENCODE_CONFIG_CONTENT: AGENT_CONFIG }),
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    const durationMs = Date.now() - started;
    const parsed = parseOcStream(res.stdout ?? '');

    // The raw stream, not the parsed text: if parseOcStream ever misreads a
    // response, the only way to find out is to still have the original.
    const rawPath = archiveSafe(
      `agent-opencode-${task.id}`,
      `${res.stdout ?? ''}
---stderr---
${res.stderr ?? ''}`,
    );

    if (parsed.failure) {
      log.warn(`opencode ${parsed.failure} on ${task.id}: ${parsed.errorMessage.slice(0, 200)}`);
      return {
        ok: false,
        fatal: isFatal(parsed.failure),
        /*
         * A cut-off session still said something before it stopped, and that
         * partial narration is the only account of what it was doing. The
         * provider failures above have no useful text — the message IS the
         * whole story — so only this one keeps both.
         */
        stdout: parsed.text ? `${parsed.text}\n\n(${parsed.errorMessage})` : parsed.errorMessage,
        // The one boundary where stdout may be entirely ShanAuto's own words.
        spoke: Boolean(parsed.text.trim()),
        durationMs,
        reason: parsed.failure,
        deniedTools: parsed.deniedTools,
        stalled: parsed.stalled,
        rawPath,
      };
    }
    if (res.timedOut) {
      log.warn(`opencode timed out on ${task.id} after ${timeoutS}s`);
      return {
        ok: false,
        stdout: parsed.text,
        durationMs,
        reason: 'TIMEOUT',
        deniedTools: parsed.deniedTools,
        rawPath,
      };
    }
    if (res.exitCode !== 0) {
      return {
        ok: false,
        stdout: stripAnsi(parsed.text || res.stderr || ''),
        durationMs,
        reason: `EXIT_${res.exitCode}`,
        deniedTools: parsed.deniedTools,
        rawPath,
      };
    }
    /*
     * A refusal on a session that still finished is not a failure — the agent
     * worked around it — but it is the difference between "the model did
     * nothing" and "the model was not allowed to". `detectBlocked` has consumed
     * this field since it was written; until now only copilot filled it, and
     * the driver that does the work reported every refusal as silence.
     */
    return { ok: true, stdout: parsed.text, durationMs, deniedTools: parsed.deniedTools, rawPath };
  }
}

export default OpenCodeAgent;
