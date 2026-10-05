import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot } from './config.js';
import { ensureDir, nowIso, today, writeFileSafe } from './util.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let runId = 'adhoc';
export function setRunId(id: string) {
  runId = id;
}
export function getRunId() {
  return runId;
}

function emit(level: Level, msg: string, data?: unknown) {
  const line = { ts: nowIso(), level, runId, msg, ...(data ? { data } : {}) };
  // Follows SHANAUTO_DB via dataRoot() so a redirected instance logs beside
  // its ledger instead of into the real data/runs (see reportsDir for why).
  const dir = join(dataRoot(), 'runs');
  ensureDir(dir);
  appendFileSync(`${dir}/${today()}.jsonl`, `${JSON.stringify(line)}\n`, 'utf8');

  const tag = `${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
  const extra = data && level !== 'debug' ? ` ${JSON.stringify(data)}` : '';
  // eslint-disable-next-line no-console
  console.log(`${tag} ${msg}${extra}`);
}

export const log = {
  debug: (m: string, d?: unknown) => emit('debug', m, d),
  info: (m: string, d?: unknown) => emit('info', m, d),
  warn: (m: string, d?: unknown) => emit('warn', m, d),
  error: (m: string, d?: unknown) => emit('error', m, d),
};

/** Every raw LLM response is archived before parsing, so failures stay debuggable. */
export function archive(step: string, content: string): string {
  const file = join(dataRoot(), 'artifacts', runId, `${Date.now()}-${step}.md`);
  writeFileSafe(file, content);
  return file;
}

/**
 * Archive without letting a disk problem cost a task.
 *
 * Used on the agent path, where the alternative is losing work that has already
 * been done and paid for. The brain path keeps the throwing version: there, a
 * failed archive means the response about to be parsed is unrecoverable.
 */
export function archiveSafe(step: string, content: string): string | undefined {
  try {
    return archive(step, content);
  } catch (e) {
    log.debug(`could not archive ${step}: ${(e as Error).message}`);
    return undefined;
  }
}
