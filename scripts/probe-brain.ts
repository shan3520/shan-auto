/** Is the brain alive, and how fast? One tiny structured call. */
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { makeBrain } from '../src/drivers/registry.js';

const cfg = loadConfig();
console.log(`brain driver : ${cfg.drivers.brain.active}`);
const reg = cfg.drivers.brain.registry[cfg.drivers.brain.active] as Record<string, unknown>;
console.log(`model        : ${reg?.model || '(driver default)'}`);

const brain = await makeBrain(cfg);
const Schema = z.object({ answer: z.string(), n: z.number() });

const t0 = Date.now();
try {
  const out = await brain.ask(
    'Reply with ONLY a fenced json block: {"answer":"alive","n":7}',
    Schema,
    'probe',
  );
  console.log(`result       : OK  ${JSON.stringify(out)}`);
} catch (e) {
  console.log(`result       : FAILED  ${(e as Error).name}: ${(e as Error).message.slice(0, 300)}`);
} finally {
  console.log(`elapsed      : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await brain.dispose();
}
