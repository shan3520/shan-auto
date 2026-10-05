/**
 * Checks the two anti-duplication mechanisms without spending a model call.
 *
 *   npx tsx scripts/probe-planner.ts
 */
import { loadConfig, resolveRepo } from '../src/config.js';
import { apiSurface, findDuplicate } from '../src/core/context.js';
import * as ledger from '../src/ledger.js';

const cfg = loadConfig();
const repo = resolveRepo(cfg, cfg.repos[0]!.id);

const surface = await apiSurface(repo);
console.log('--- API SURFACE the planner now sees ---');
console.log(surface.split('\n').slice(0, 12).join('\n'));
console.log(`  ...(${surface.split('\n').length} lines, ${surface.length} chars total)\n`);

console.log('  contains "sleep"      :', /\bsleep\b/.test(surface));
console.log('  contains "jitter"     :', /\bjitter\b/.test(surface));
console.log('  contains "commitAndPush":', /commitAndPush/.test(surface));

const known = ledger.knownTitles(repo.id);
console.log(`\n--- DEDUPE against ${known.length} known title(s) ---`);

const probes = [
  'Add sleep utility function',
  'Create a sleep helper',
  'Add retry status fields to task schema',
  'Implement exponential backoff with jitter for brain calls',
  'Write a completely unrelated CSV exporter',
];
for (const p of probes) {
  const clash = findDuplicate(p, known);
  console.log(`  ${clash ? 'DUP ' : 'new '} "${p}"${clash ? `  <- matches "${clash}"` : ''}`);
}
