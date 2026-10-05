import type { BrainDriver } from '../contracts.js';

/**
 * A brain that exists but never thinks.
 *
 * The Part 3 subprocess tests point drivers.yaml at this so `sa plan` boots a
 * brain without touching a real binary or a network. The plan test seeds the
 * backlog past min_ready, so refillBacklog short-circuits and ask() is never
 * reached; if a test ever does call it, the throw IS the failure — loud and
 * local — rather than a silent provider request.
 */
export class StubBrain implements BrainDriver {
  readonly id = 'stub';

  async init(): Promise<void> {
    /* nothing to initialise */
  }

  async ask<T>(_prompt: string, _schema: unknown, label: string): Promise<T> {
    /*
     * One label can be answered, from the environment, and only that one.
     *
     * The acceptance check (O25) runs on every milestone that closes, so a
     * subprocess test cannot reach it by seeding the backlog — the throw below
     * would fire before the behaviour under test. This seam lets a test say
     * what the checker decided, and leaves every other label throwing, which is
     * the guarantee the rest of this file is here for.
     */
    const canned = process.env.SHANAUTO_STUB_ACCEPT;
    if (label === 'accept' && canned) return JSON.parse(canned) as T;
    throw new Error(`stub brain.ask(${label}) must not be called — seed the backlog past min_ready`);
  }

  async dispose(): Promise<void> {
    /* nothing to dispose */
  }
}

export default StubBrain;
