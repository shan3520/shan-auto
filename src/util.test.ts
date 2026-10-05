import { describe, it, expect } from 'vitest';
import { today, sleep } from './util.js';

describe('today', () => {
  it('returns a date in YYYY-MM-DD format', () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('sleep', () => {
  it('resolves after the specified time', async () => {
    const start = Date.now();
    await sleep(10);
    const end = Date.now();
    expect(end - start).toBeGreaterThanOrEqual(9);
  });
});
