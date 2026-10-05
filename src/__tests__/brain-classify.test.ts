import { describe, it, expect } from 'vitest';
import { classifyBrainOutput } from '../drivers/brain.agy.js';

/**
 * The brain used to scan its OWN ANSWER for error signatures.
 *
 * On the first real planning run, a spec containing "JWT authentication" came
 * back as a valid plan full of the word "Authentication", matched /authenticat/i
 * and was discarded as a fatal AUTH failure. The whole run died. The agent
 * driver had already been fixed for the identical mistake — a task about retry
 * logic wrote "rate limit" and aborted a run — but the brain had not.
 *
 * These lock in the rule: a substantive answer is an answer, and its contents
 * are not evidence of a provider failure.
 */

/*
 * These call the driver's own classifier. They used to re-declare the pattern
 * lists here and had already drifted — this file carried a `/credential/i` the
 * driver never had, so it would have kept passing if the real rule were deleted.
 */
const classify = (stdout: string, stderr = '') => classifyBrainOutput(stdout, stderr);

const REAL_PLAN = JSON.stringify({
  epics: [
    {
      title: 'JWT Authentication and BYOK provider keys',
      summary:
        'Users can register, sign in, and store provider credentials. ' +
        'Authentication uses hashed passwords and short-lived tokens.',
    },
  ],
});

describe('brain failure classification', () => {
  it('does not mistake a plan ABOUT authentication for an auth failure', () => {
    expect(classify(REAL_PLAN)).toBeNull();
  });

  it('does not mistake a plan about rate limiting for a quota failure', () => {
    const plan = JSON.stringify({
      epics: [{ title: 'Add rate limiting', summary: 'Throttle requests per API credential.' }],
    });
    expect(classify(plan)).toBeNull();
  });

  it('still catches a real auth failure on stderr', () => {
    expect(classify(REAL_PLAN, 'Error: not logged in. Run agy login.')).toBe('AUTH');
  });

  it('still catches a real quota failure on stderr', () => {
    expect(classify(REAL_PLAN, 'RESOURCE_EXHAUSTED: quota exceeded')).toBe('QUOTA');
  });

  it('still classifies when there is no real answer at all', () => {
    // Empty or near-empty stdout means the words really are the failure.
    expect(classify('', 'unauthorized')).toBe('AUTH');
    expect(classify('quota exceeded')).toBe('QUOTA');
  });

  it('treats a short answer as suspect but a substantive one as an answer', () => {
    expect(classify('not logged in')).toBe('AUTH');
    expect(classify(`${'x'.repeat(60)} not logged in`)).toBeNull();
  });
});
