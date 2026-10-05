/** Are all registered agents actually runnable on this machine? */
import { loadConfig } from '../src/config.js';
import { makeAgent } from '../src/drivers/registry.js';

const cfg = loadConfig();
for (const id of Object.keys(cfg.drivers.agents.registry)) {
  try {
    const agent = await makeAgent(cfg, id);
    const h = await agent.healthCheck();
    console.log(`${h.ok ? 'OK  ' : 'FAIL'} ${id.padEnd(12)} ${h.detail}`);
  } catch (e) {
    console.log(`FAIL ${id.padEnd(12)} ${(e as Error).message.slice(0, 120)}`);
  }
}
