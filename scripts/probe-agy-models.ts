/**
 * Which agy models actually answer, and how fast?
 *
 * A model appearing in `agy models` does not mean it is usable on this account:
 * eligibility and quota are per-model. Structured output, not chat, because
 * that is what the brain actually needs.
 */
import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../src/util.js';
import { p } from '../src/config.js';

const BIN = join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe');
const cwd = p('data', 'brain-cwd');
ensureDir(cwd);

if (!existsSync(BIN)) {
  console.log(`agy not found at ${BIN}`);
  process.exit(1);
}

const PROMPT =
  'Reply with ONLY a fenced json code block and no other text: {"answer":"alive","n":7}';

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-6',
      'gemini-3.1-pro-high',
      'gemini-3.6-flash-high',
    ];

for (const model of CANDIDATES) {
  const t0 = Date.now();
  const res = await execa(BIN, ['-p', PROMPT, '--model', model, '--print-timeout', '3m'], {
    cwd,
    reject: false,
    timeout: 200_000,
    killSignal: 'SIGKILL',
    stdin: 'ignore',
    env: { NO_COLOR: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = stripAnsi(`${res.stdout ?? ''}\n${res.stderr ?? ''}`).trim();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = /"answer"\s*:\s*"alive"/.test(out);
  const why = ok ? '' : `  <- ${out.replace(/\s+/g, ' ').slice(0, 120)}`;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${secs.padStart(6)}s  ${model}${why}`);
}
