import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDriver, BrainDriver, ChatDriver } from './contracts.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Dynamic import by path from drivers.yaml. Swapping a tool means editing that
 * file and dropping a new module next to the others - no code changes here.
 * `.js` paths in config are rewritten to `.ts` because we run through tsx.
 */
async function loadModule(modPath: string): Promise<any> {
  const asTs = modPath.replace(/\.js$/, '.ts');
  const abs = resolve(HERE, '..', asTs.replace(/^\.\//, ''));
  const mod = await import(pathToFileURL(abs).href);
  return mod.default ?? mod;
}

export async function makeBrain(cfg: AppConfig): Promise<BrainDriver> {
  const { active, registry } = cfg.drivers.brain;
  const entry = registry[active];
  if (!entry) throw new Error(`brain.active="${active}" not found in drivers.yaml registry`);

  const Ctor = await loadModule(entry.module);
  const brain: BrainDriver = new Ctor({
    ...entry,
    model: entry.model ?? cfg.system.brain.model,
    /*
     * The registry entry wins, because model ids belong to the driver.
     * system.yaml's fallback is `google/gemini-3.6-flash`, an opencode id that
     * agy does not recognise — handing it over on a quota failure would have
     * turned the fallback into a second, guaranteed failure.
     */
    fallbackModel: (entry.fallback_model as string | undefined) ?? cfg.system.brain.fallback_model,
    maxRepairs: cfg.system.brain.max_repair_attempts,
    timeoutS: cfg.system.timeouts.brain_s,
  });
  await brain.init();
  log.info(`brain driver: ${brain.id}`);
  return brain;
}

export async function makeChat(cfg: AppConfig): Promise<ChatDriver | null> {
  if (!cfg.drivers.chat.enabled) return null;
  const { active, registry } = cfg.drivers.chat;
  const entry = registry[active];
  if (!entry) throw new Error(`chat.active="${active}" not found in drivers.yaml registry`);

  try {
    const Ctor = await loadModule(entry.module);
    const chat: ChatDriver = new Ctor(entry);
    await chat.init();
    log.info(`chat driver: ${chat.id}`);
    return chat;
  } catch (e) {
    // The chat channel is a convenience. Never let it stop a run.
    log.warn(`chat driver unavailable, continuing without it: ${(e as Error).message}`);
    return null;
  }
}

const agentCache = new Map<string, AgentDriver>();

export async function makeAgent(cfg: AppConfig, id: string): Promise<AgentDriver> {
  const cached = agentCache.get(id);
  if (cached) return cached;

  const entry = cfg.drivers.agents.registry[id];
  if (!entry) throw new Error(`agent "${id}" not found in drivers.yaml registry`);

  const Ctor = await loadModule(entry.module);
  const agent: AgentDriver = new Ctor(entry);
  agentCache.set(id, agent);
  return agent;
}

export function agentIds(cfg: AppConfig): string[] {
  return Object.keys(cfg.drivers.agents.registry);
}
