import { describe, it, expect } from 'vitest';
import { looksFailed, harnessText, classifyAgyOutput } from '../drivers/agent.agy.js';

/**
 * Regression guard for a real incident on 2026-08-06.
 *
 * The agy driver classified failures by pattern-matching agy's text output. agy
 * has no structured output, so the agent's own narrative shares the stream with
 * any error. A task titled "Integrate executeWithRetry into BrainDriver" made the
 * agent write about rate limits, the QUOTA pattern matched that prose, the run was
 * declared fatally throttled and aborted — after the task had actually succeeded,
 * and its work was then rolled back.
 */
describe('looksFailed', () => {
  const narrative =
    'I have successfully updated the main execution method once() in ' +
    'src/drivers/brain.opencode.ts to wrap its execa call in executeWithRetry, ' +
    'which now retries on rate limit and quota errors with exponential backoff.';

  it('does not treat a successful run as failed just because it mentions quota', () => {
    expect(looksFailed(0, narrative)).toBe(false);
  });

  it('treats a non-zero exit as failed', () => {
    expect(looksFailed(1, narrative)).toBe(true);
  });

  it('treats a killed process (undefined exit) as failed', () => {
    expect(looksFailed(undefined, narrative)).toBe(true);
  });

  it('treats an empty or near-empty response as failed', () => {
    expect(looksFailed(0, '')).toBe(true);
    expect(looksFailed(0, '   \n  ')).toBe(true);
    expect(looksFailed(0, 'quota exceeded')).toBe(true);
  });

  it('still lets a genuine short provider error through to classification', () => {
    // Short + zero exit is the shape a bare provider error takes.
    expect(looksFailed(0, 'You exceeded your current quota.')).toBe(true);
  });
});

/**
 * The same incident class as above, one layer deeper, from a real run on
 * 2026-08-20.
 *
 * `looksFailed` only asks WHETHER the run failed. It cannot say anything about
 * WHY, and the why is drawn from the same shared stream. agy refused a command,
 * quoted the agent's own Python back in the refusal, and that Python contained
 * `_get_authenticated_client`. /authenticat/i matched, the driver reported
 * `AUTH`, the executor marked agy out for the run, and — copilot having been
 * removed in 1c3db1c — the run stopped with seven tasks still queued and
 * nothing whatsoever wrong with the credentials.
 *
 * Verbatim from data/artifacts/Rae9l3i8tum/1787166113242-agent-agy-Tj8jqqvu4k3.md.
 */
describe('harnessText', () => {
  const AUTH = [/unauthor/i, /not logged in/i, /authenticat/i, /credential/i, /sign in/i];
  const denial =
    'Error: permission check failed for command "cat << \'EOF\' >> tests/api/test_documents.py\\n' +
    '\\ndef test_document_extract_with_group_id():\\n    client, headers = ' +
    '_get_authenticated_client(\\"extract_group_user\\")\\n"';

  it('does not read the agent\'s own code as an auth failure', () => {
    // The bug: this assertion fails against the raw text.
    expect(AUTH.some((re) => re.test(denial))).toBe(true);
    expect(AUTH.some((re) => re.test(harnessText(denial)))).toBe(false);
  });

  it('leaves the denial itself intact, so it is still classified as one', () => {
    expect(harnessText(denial)).toMatch(/permission check failed/i);
  });

  it('blanks fenced code the agent wrote, without touching agy\'s own words', () => {
    const out = 'Error: not logged in\n```python\nclient = get_credentials()\n```';
    const h = harnessText(out);
    expect(h).toMatch(/not logged in/i);
    expect(h).not.toMatch(/get_credentials/);
  });

  it('still lets a real auth failure through', () => {
    const real = 'Error: unauthorized. Please sign in with `agy auth login`.';
    expect(AUTH.some((re) => re.test(harnessText(real)))).toBe(true);
  });

  it('leaves ordinary output alone', () => {
    const plain = 'Wrote app/models/audit.py and updated tests/api/test_audit.py.';
    expect(harnessText(plain)).toBe(plain);
  });
});

/**
 * The order of the three verdicts, which is what actually ended the run.
 *
 * PERMISSION_DENIED is not fatal and the other two are, so testing them in the
 * wrong order does not merely mislabel a run — it takes the only remaining
 * complex agent out of service and stops everything still queued.
 */
describe('classifyAgyOutput', () => {
  const denial =
    'Error: permission check failed for command "cat << \'EOF\' >> tests/api/test_documents.py\\n' +
    '\\n    client, headers = _get_authenticated_client(\\"extract_group_user\\")\\n"';

  it('calls a denial a denial, even when the agent quoted auth code', () => {
    expect(classifyAgyOutput(denial, 1)).toBe('PERMISSION_DENIED');
  });

  it('reports a real auth failure as AUTH', () => {
    expect(classifyAgyOutput('Error: unauthorized — run `agy auth login`.', 1)).toBe('AUTH');
  });

  it('reports a real quota failure as QUOTA', () => {
    expect(classifyAgyOutput('Error: resource exhausted, quota reached for today.', 1)).toBe(
      'QUOTA',
    );
  });

  it('prefers the stated denial over an inferred quota failure', () => {
    // Both signatures present. The one agy states outright must win, because it
    // is the non-fatal reading and the other is a guess.
    const both = `${denial}\nthe agent also wrote about rate limit handling`;
    expect(classifyAgyOutput(both, 1)).toBe('PERMISSION_DENIED');
  });

  it('says nothing about a successful run that merely discusses quotas', () => {
    const narrative =
      'I wrapped the call in executeWithRetry, which now retries on rate limit ' +
      'and quota errors with exponential backoff, and added tests for both.';
    expect(classifyAgyOutput(narrative, 0)).toBeNull();
  });

  it('does not invent a verdict for an ordinary non-zero exit', () => {
    expect(classifyAgyOutput('Traceback: ImportError: no module named app.models.audit', 1)).toBe(
      null,
    );
  });
});
