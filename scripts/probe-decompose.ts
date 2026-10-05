/**
 * The brain's real job, end to end: the full decompose prompt against the real
 * schema. A toy prompt proves the model answers; this proves it can plan.
 *
 * Read-only — nothing is written to the ledger.
 */
import { loadConfig, fill, prompt, resolveRepo } from '../src/config.js';
import { makeBrain } from '../src/drivers/registry.js';
import { DecomposeSchema } from '../src/schemas.js';
import { apiSurface } from '../src/core/context.js';
import { readRecent } from '../src/core/journal.js';
import { fileTree } from '../src/git.js';
import { truncate } from '../src/util.js';

const cfg = loadConfig();
const repo = resolveRepo(cfg, cfg.repos[0]!.id);
const [minTasks, maxTasks] = cfg.system.backlog.tasks_per_milestone;

const text = fill(prompt('decompose'), {
  MIN_LINES: cfg.system.limits.min_insertions,
  MAX_FILES: cfg.system.limits.max_files_per_task,
  MIN_TASKS: minTasks,
  MAX_TASKS: maxTasks,
  REPO_ID: repo.id,
  REPO_PATH: repo.path,
  STACK: repo.stack,
  DEFAULT_VERIFY: repo.verify_cmd,
  TREE: truncate(await fileTree(repo, 150), 4000),
  SYMBOLS: await apiSurface(repo),
  COMPLETED: '(nothing yet)',
  RESOLVED: '(nothing yet)',
  JOURNAL: readRecent(2500) || '(nothing recorded yet)',
  MILESTONE:
    process.env.MILESTONE ??
    'Make the working journal prunable\n\n' +
      'data/journal/ and data/artifacts/ grow without bound now that nothing is ' +
      'truncated. Add a way to delete entries older than a retention period, ' +
      'defaulting to keeping everything, and surface it as a CLI command.',
});

console.log(`brain    : ${cfg.drivers.brain.active}`);
console.log(`prompt   : ${text.length} chars`);

const override = process.argv[2];
if (override) {
  (cfg.drivers.brain.registry[cfg.drivers.brain.active] as Record<string, unknown>).model = override;
}
console.log(`model    : ${override ?? '(configured)'}`);
const brain = await makeBrain(cfg);
const t0 = Date.now();
try {
  const out = await brain.ask(text, DecomposeSchema, 'probe-decompose');
  console.log(`elapsed  : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`tasks    : ${out.tasks.length}\n`);
  for (const t of out.tasks) {
    const files = (t.files_hint ?? []).join(', ');
    console.log(`  [${t.kind}] ${t.title}`);
    console.log(`      accept: ${(t.acceptance ?? '').slice(0, 100)}`);
    console.log(`      files : ${files || '(none)'}`);
    console.log(`      deps  : ${(t.depends_on ?? []).join(', ') || '(none)'}`);
  }
} catch (e) {
  console.log(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`${(e as Error).name}: ${(e as Error).message.slice(0, 500)}`);
} finally {
  await brain.dispose();
}
