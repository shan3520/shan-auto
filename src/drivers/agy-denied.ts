import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Work out WHICH command agy was refused.
 *
 * agy never says. Its whole headless output on a denial is one sentence holding
 * a literal placeholder — `command(<target>)` — so the operator is told to
 * allow-list "the command" with no way on earth to learn which one. Measured
 * 2026-08-15: a run failed on `alembic revision --autogenerate -m "document
 * groups" --rev-id 0003_document_groups`, and finding that took an hour of
 * digging through agy's private files. The operator does not have that hour and
 * should not need it.
 *
 * agy does keep the answer, in its own conversation transcript: one JSON object
 * per line, where a PLANNER_RESPONSE holds the tool calls it ASKED for and a
 * RUN_COMMAND step records a command that actually STARTED. A command that was
 * asked for and has no step of its own never ran — which, on a run that reported
 * a permission denial, is the command that was refused.
 *
 * Best effort, always. This reads a file belonging to another program, whose
 * shape can change under us at any release. Everything here is wrapped so that a
 * missing, renamed, or reshaped transcript costs the operator a hint and never
 * the run.
 */

/** Where agy keeps its per-conversation logs. */
export function agyBrainDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'brain');
}

const TRANSCRIPT = join('.system_generated', 'logs', 'transcript_full.jsonl');

/**
 * The transcripts touched since a moment, newest first.
 *
 * Bounded by time because the brain directory keeps every past conversation, and
 * naming an old run's command would be worse than saying nothing.
 */
function transcriptsSince(sinceMs: number, dir = agyBrainDir()): string[] {
  if (!existsSync(dir)) return [];
  const found: { path: string; mtime: number }[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry, TRANSCRIPT);
    try {
      const st = statSync(path);
      if (st.mtimeMs >= sinceMs) found.push({ path, mtime: st.mtimeMs });
    } catch {
      // No transcript in this conversation folder yet. Nothing to say about it.
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

type Step = {
  type?: string;
  tool_calls?: { name?: string; args?: { CommandLine?: string } }[];
};

/**
 * The commands asked for in a transcript that never started.
 *
 * Pairing is positional: agy runs what it asks for in the order it asks, so the
 * Nth started command answers the Nth request. Whatever is left unanswered at
 * the end was never run. On a denial that is the refused command; a run cut
 * short by a timeout can also leave one here, which is why the caller only
 * consults this when agy has already reported a permission problem.
 */
export function unrunCommands(transcript: string): string[] {
  const asked: string[] = [];
  let started = 0;

  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let step: Step;
    try {
      step = JSON.parse(line) as Step;
    } catch {
      continue; // A half-written last line while agy is still going.
    }
    if (step.type === 'RUN_COMMAND') started++;
    for (const call of step.tool_calls ?? []) {
      const cmd = call?.args?.CommandLine;
      if (call?.name === 'run_command' && typeof cmd === 'string' && cmd.trim()) asked.push(cmd);
    }
  }

  return asked.slice(started);
}

/**
 * The command agy was most likely refused, or undefined if it cannot be told.
 *
 * Undefined is a perfectly good answer here and is returned freely — a wrong
 * command name sends the operator off to allow-list something harmless while the
 * real blocker stays, which is worse than the honest silence they get today.
 */
export function deniedCommand(sinceMs: number, dir = agyBrainDir()): string | undefined {
  try {
    for (const path of transcriptsSince(sinceMs, dir)) {
      const unrun = unrunCommands(readFileSync(path, 'utf8'));
      // The last one: the request agy was on when it stopped.
      if (unrun.length) return unrun[unrun.length - 1];
    }
  } catch {
    // Reading another program's private files is allowed to fail.
  }
  return undefined;
}
