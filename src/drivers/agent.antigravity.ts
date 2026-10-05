import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDriver, DriverOpts, ExecResult } from './contracts.js';
import type { Repo, TaskRow } from '../schemas.js';
import { writeFileSafe, nowIso, safeEnv } from '../util.js';
import { log } from '../logger.js';

/**
 * Antigravity is a VS Code fork. Its CLI (`--goto`, `--add-mcp`, `--install-extension`,
 * `serve-web`, `tunnel`) can open files and manage extensions, but it exposes NO way
 * to drive the Agent Manager from outside the GUI. Verified against Antigravity IDE
 * 1.107.0 via `antigravity --help`.
 *
 * So this driver is deliberately SUPERVISED, not autonomous:
 *   mode: 'handoff' - write a task brief into the repo and open it in Antigravity.
 *                     The task parks in the review queue until you finish it.
 *
 * Anything routed here does not count toward autonomous throughput. Keep
 * `routing.rules[].kinds` empty in drivers.yaml if you want a fully hands-off day.
 */
export class AntigravityAgent implements AgentDriver {
  readonly id = 'antigravity';
  readonly kind = 'ide' as const;
  private bin: string;
  private mode: string;

  constructor(opts: DriverOpts) {
    this.bin = (opts.bin as string) ?? 'antigravity';
    this.mode = (opts.mode as string) ?? 'handoff';
  }

  async healthCheck() {
    if (!existsSync(this.bin)) {
      const r = await execa(this.bin, ['--version'], { reject: false });
      return {
        ok: r.exitCode === 0,
        detail: r.exitCode === 0 ? `antigravity ${r.stdout.split('\n')[0]}` : 'binary not found',
      };
    }
    return { ok: true, detail: `antigravity at ${this.bin}` };
  }

  async execute(task: TaskRow, repo: Repo, _timeoutS: number): Promise<ExecResult> {
    if (this.mode !== 'handoff') {
      return {
        ok: false,
        stdout: '',
        durationMs: 0,
        reason:
          `mode "${this.mode}" is not implemented. Antigravity 1.107 exposes no agent API; ` +
          `only "handoff" is honest. Route this task to opencode instead.`,
      };
    }

    const started = Date.now();
    const hints = JSON.parse(task.files_hint) as string[];
    const brief = [
      `# ${task.title}`,
      ``,
      `- task: \`${task.id}\``,
      `- repo: ${repo.id} (${repo.branch})`,
      `- kind: ${task.kind}`,
      `- queued: ${nowIso()}`,
      ``,
      `## Instruction`,
      task.instruction,
      ``,
      `## Acceptance`,
      task.acceptance,
      ``,
      hints.length ? `## Likely files\n${hints.map((f) => `- ${f}`).join('\n')}` : '',
      ``,
      `## Verify`,
      '```bash',
      task.verify_cmd,
      '```',
      ``,
      `---`,
      `Paste the Instruction section into the Antigravity agent. When the verify`,
      `command passes, run: \`npm run sa -- resolve ${task.id}\``,
    ]
      .filter(Boolean)
      .join('\n');

    const file = join(repo.path, '.shanauto', 'handoff', `${task.id}.md`);
    writeFileSafe(file, brief);

    const r = await execa(this.bin, ['--reuse-window', '--goto', file], {
      reject: false,
      timeout: 30_000,
      // Consistent with every other subprocess (SEC-1/SEC-3): nothing secret in
      // the child env. The IDE launcher needs only the standard Windows paths,
      // which safeEnv carries.
      extendEnv: false,
      env: safeEnv(),
    });
    if (r.exitCode !== 0) log.warn(`Could not open Antigravity: ${r.stderr}`);

    log.info(`Handed off ${task.id} to Antigravity: ${file}`);
    return {
      ok: false,
      handoff: true,
      stdout: file,
      durationMs: Date.now() - started,
      reason: 'HANDOFF',
    };
  }
}

export default AntigravityAgent;
