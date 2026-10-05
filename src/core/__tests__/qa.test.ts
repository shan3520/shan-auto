import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QaFinding, QaReview, TaskRow } from '../../schemas.js';

/*
 * The review is the last thing standing between a green gate and a push, and it
 * is the only step in the pipeline that can say "these tests cannot fail". That
 * makes two failures possible, in opposite directions:
 *
 *  - it rejects for taste, and the shop never ships;
 *  - it approves anything, and it may as well not exist.
 *
 * Everything below is about the first, because the second is what the prompt is
 * for and a prompt cannot be unit-tested. `reviewIssues` runs INSIDE the brain's
 * repair loop, so a rule added here costs the senior one more model call, not an
 * intern's whole run.
 */

/*
 * Recorded, not just stubbed: what the review asks the index FOR is the thing
 * under test below, and a stub that ignores its arguments cannot show it.
 */
const surf = vi.hoisted(() => ({
  calls: [] as { max: number | undefined; focus: string[] }[],
  text: 'export function summarise(): string',
}));

vi.mock('../context.js', () => ({
  apiSurface: async (_repo: unknown, max?: number, focus: string[] = []) => {
    surf.calls.push({ max, focus });
    return surf.text;
  },
}));

const { reviewIssues, renderReview, reviewWork, annotateFiles } = await import('../qa.js');

function finding(over: Partial<QaFinding> = {}): QaFinding {
  return {
    file: 'src/summary.ts',
    severity: 'defect',
    detail: 'countComplaints returns 0 for the first day of the window because the comparison is >, so a row stamped exactly at the cutoff is skipped',
    fix: 'use >= for the cutoff comparison and add a row stamped at the boundary',
    ...over,
  };
}

function review(over: Partial<QaReview> = {}): QaReview {
  return {
    verdict: 'rework',
    summary: 'the cutoff comparison drops the boundary row',
    findings: [finding()],
    ...over,
  };
}

const opts = (over: Partial<{ changedFiles: string[]; hasBrief: boolean }> = {}) => ({
  changedFiles: ['src/summary.ts'],
  hasBrief: true,
  ...over,
});

describe('reviewIssues', () => {
  it('accepts a rework that names a real file and a real behaviour', () => {
    expect(reviewIssues(review(), opts())).toEqual([]);
  });

  it('accepts a ship with no findings', () => {
    expect(
      reviewIssues({ verdict: 'ship', summary: 'reads correctly', findings: [] }, opts()),
    ).toEqual([]);
  });

  it('rejects a rework that lists nothing to change', () => {
    const issues = reviewIssues(review({ findings: [] }), opts());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/no findings/i);
  });

  /*
   * The shape that quietly destroys the rule: work that shipped with objections
   * attached teaches the next reader that findings do not stop anything.
   */
  it('rejects a ship that carries findings', () => {
    const issues = reviewIssues(review({ verdict: 'ship' }), opts());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/reason NOT to ship/);
  });

  it('rejects a finding about a file this task never touched', () => {
    const issues = reviewIssues(
      review({ findings: [finding({ file: 'src/other.ts' })] }),
      opts(),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('src/other.ts');
    // The list of what WAS changed goes back with it, so the senior can retarget
    // the finding rather than guess at why it was refused.
    expect(issues[0]).toContain('src/summary.ts');
  });

  it('names no file at all when the task changed nothing git could show', () => {
    const issues = reviewIssues(review(), opts({ changedFiles: [] }));
    expect(issues[0]).toContain('(none)');
  });

  /*
   * git prints forward slashes; a model reading a Windows checkout writes back
   * whatever it saw. Refusing a finding over a separator would send the senior
   * round the repair loop for being right.
   */
  it('matches a path the senior spelled differently to git', () => {
    for (const file of ['src\\summary.ts', './src/summary.ts', 'SRC/Summary.ts', ' src/summary.ts '])
      expect(reviewIssues(review({ findings: [finding({ file })] }), opts()), file).toEqual([]);
  });

  it('rejects off_brief on a task that was dispatched without a brief', () => {
    const issues = reviewIssues(
      review({ findings: [finding({ severity: 'off_brief' })] }),
      opts({ hasBrief: false }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/without a brief/);
  });

  it('allows off_brief when there was a brief to depart from', () => {
    expect(
      reviewIssues(review({ findings: [finding({ severity: 'off_brief' })] }), opts()),
    ).toEqual([]);
  });

  it('rejects a finding that is a preference', () => {
    for (const detail of [
      'consider renaming countComplaints to something clearer',
      'the helper might be nicer as a small class, and the naming is inconsistent',
      'a minor nitpick: the imports would be cleaner grouped by origin',
      'personally I would prefer this split into two functions for readability',
      'for consistency with the other modules this should be a named export',
    ]) {
      const issues = reviewIssues(review({ findings: [finding({ detail })] }), opts());
      expect(issues, detail).toHaveLength(1);
      expect(issues[0], detail).toMatch(/preference, not a defect/);
    }
  });

  /*
   * A preference and a vague finding are the same refusal to the senior, so the
   * checks are exclusive: a taste finding must produce ONE issue, not two, or
   * the repair prompt contradicts itself about what is wrong with it.
   */
  it('calls a preference a preference rather than also calling it vague', () => {
    const issues = reviewIssues(
      review({ findings: [finding({ detail: 'consider a clearer name for this variable' })] }),
      opts(),
    );
    expect(issues).toHaveLength(1);
  });

  it('rejects a finding that does not say what goes wrong', () => {
    for (const detail of [
      'the implementation here is incomplete and should be revisited before release',
      'this module does not feel like a finished piece of engineering work at all',
      'the approach taken in this file is unsound for the problem being solved here',
    ]) {
      const issues = reviewIssues(review({ findings: [finding({ detail })] }), opts());
      expect(issues, detail).toHaveLength(1);
      expect(issues[0], detail).toMatch(/does not say what actually goes wrong/);
    }
  });

  /*
   * The words that make a finding actionable. These are the sentences the prompt
   * asks for by name; if the filter rejected them it would be teaching one thing
   * and enforcing another.
   */
  it('accepts the anchored phrasings the prompt asks the senior to write', () => {
    for (const detail of [
      'test_ratio mocks the query chain to return 4 and 10, so the assertion passes against any implementation',
      'the loop skips the last element because the bound is length - 1 rather than length',
      'the handler swallows the parse error and returns undefined, so a malformed row looks like an absent one',
      'the cutoff is hard-coded to 1970, so no row is ever excluded from the window',
      'the file handle is never closed on the error path, so a failed import leaks one descriptor per call',
      'a duplicate id overwrites the earlier row instead of raising, so the first entry is lost silently',
    ])
      expect(reviewIssues(review({ findings: [finding({ detail })] }), opts()), detail).toEqual([]);
  });

  /*
   * Substance beats phrasing. Both of the first two are real findings from the
   * run on 2026-08-21, and the filter threw both away for their manners: one
   * was a missing auth check on an endpoint serving document titles to
   * anonymous callers, the other was the duplicate endpoint that run most
   * needed caught.
   *
   * This is the expensive direction to fail in. reviewIssues is the `accept`
   * callback, so a discarded finding goes back as invalid — and the cheapest
   * repair available to the senior is to drop it and ship.
   */
  it('keeps a finding that names a real failure, however politely it is worded', () => {
    for (const detail of [
      'for consistency with the other stats routes this endpoint should require get_current_user; as written the auth dependency is missing and it returns document titles to anonymous callers',
      'this duplicates the existing /api/stats/unsearched-documents endpoint; consider removing one',
      'a minor point, but the assertion mocks the session so the test passes against any implementation',
      'naming aside, the loop skips the last row because the bound is length - 1',
    ])
      expect(reviewIssues(review({ findings: [finding({ detail })] }), opts()), detail).toEqual([]);
  });

  /*
   * Verbatim from the run of 2026-08-21, all four thrown out, all four real.
   *
   * The word list was acting as a vocabulary test: `\bincorrect\b` does not
   * match "incorrectly", and "omitted" was in no list at all. The senior paid
   * for a second call and rewrote the second one as "The test suite skips
   * asserting on the status filter and returns a passing result for the suite"
   * — bent to hit `skip` and `assert`, and worse to read for it.
   *
   * The last two are the sentences DECISIONS.md records as discarded, quoted as
   * the senior actually wrote them rather than padded with anchor words the way
   * the fixture above pads them. They name a symbol and a path and nothing
   * else, and that has to be enough.
   */
  it('keeps a finding that points at something, in whatever words it chose', () => {
    for (const detail of [
      "aggregate_failed_searches does not filter out 'running' or 'errored' searches. Because it only filters on the absence of document opens, in-progress searches will be incorrectly aggregated",
      "The brief mandated a test that fails if a search with a 'running' status is included in the failure aggregation. This test was completely omitted.",
      'For consistency with the other stats routes, this endpoint should require get_current_user.',
      'This duplicates the existing /api/stats/unsearched-documents endpoint; consider removing one.',
    ])
      expect(reviewIssues(review({ findings: [finding({ detail })] }), opts()), detail).toEqual([]);
  });

  /*
   * One sentence per way of being anchored, each carrying exactly one.
   *
   * The four real findings above are anchored several times over, so they say
   * the rule works without saying which part of it did the work — take any one
   * alternation out and they still pass. These are the isolating cases: drop
   * `incorrect\w*`, or quoted literals, or paths, or camelCase, and exactly one
   * of these stops being a finding.
   */
  it('recognises each kind of anchor on its own', () => {
    for (const detail of [
      'the totals come back incorrectly whenever the window is longer than a week',
      'the guard clause the brief asked for was omitted from the new branch',
      "the response body says 'ok' where the brief asked for the count",
      'the new route sits at /api/stats/failed-searches, not where the brief put it',
      'the countByDay helper takes its window from the caller and hands back the whole table',
    ])
      expect(reviewIssues(review({ findings: [finding({ detail })] }), opts()), detail).toEqual([]);
  });

  /*
   * The other half of the same rule. A finding that names a symbol is usually
   * about behaviour — but not when the name is what it is complaining about.
   * "Consider" is how a reviewer is polite; "rename" is what it is about.
   */
  it('still calls a named nitpick a nitpick', () => {
    for (const detail of [
      'consider renaming countComplaints to something clearer',
      'the getUserById helper would read better split in two, and the naming is off',
      'minor: `failed_count` should be `failure_count`',
    ]) {
      const issues = reviewIssues(review({ findings: [finding({ detail })] }), opts());
      expect(issues, detail).toHaveLength(1);
      expect(issues[0], detail).toMatch(/preference, not a defect/);
    }
  });

  /*
   * The summary was the one field no rule read, and the senior found it: on
   * 2026-08-21 it shipped a duplicate unauthenticated endpoint with findings
   * `[]` and the objection written out in prose. It saw the defect, said so,
   * and shipped it.
   */
  it('rejects a ship whose summary concedes the defect it did not file', () => {
    for (const summary of [
      'the junior added an extra route alias (/stats/dead-documents), which ships fine but is technically redundant',
      'the change is correct and tested, though the second helper it adds is unused',
      'solid work overall, but the error path is not covered by any test',
      'this does what the brief asked, although the old constant is now dead',
    ]) {
      const issues = reviewIssues({ verdict: 'ship', summary, findings: [] }, opts());
      expect(issues, summary).toHaveLength(1);
      expect(issues[0], summary).toMatch(/concedes a problem/);
      // The senior is shown its own sentence, so it can see what was read.
      expect(issues[0], summary).toContain(summary.slice(0, 40));
    }
  });

  /*
   * "but" and "however" are ordinary connectives. A rule that fired on them
   * alone would send every clean ship round the repair loop, and the cheapest
   * repair is to say less — which is the opposite of what this is for.
   */
  it('leaves a clean ship alone, however it is phrased', () => {
    for (const summary of [
      'this does nothing but add tests, all of which are meaningful',
      'the migration is repeated on every boot, however it is idempotent and safe to rerun',
      'straightforward implementation of the brief, but a well-judged one',
      'the tests are thorough and the cutoff case is covered',
      'though the diff is large, every file in it is named by the brief',
      // A hedge in one sentence and a defect word in another are not a
      // concession — they are two separate remarks. This is why the pattern
      // is `[^.]*` and not `[^]*`: both of these read as clean ships.
      'the tests are thorough, but I would have written them in the other order. The intern also deleted the unused import the brief asked about',
      'this took two attempts, however the second is right. Nothing here is duplicated',
    ])
      expect(reviewIssues({ verdict: 'ship', summary, findings: [] }, opts()), summary).toEqual([]);
  });

  /*
   * A rework has already stopped the push, and its summary is supposed to say
   * what is wrong. Flagging the concession there would punish the verdict that
   * behaved correctly.
   */
  it('does not also accuse a bare rework of hedging', () => {
    // It already failed to file the finding; telling it twice, in two
    // different words, is a worse repair prompt than telling it once.
    const issues = reviewIssues(
      { verdict: 'rework', summary: 'ships fine, but the alias is redundant', findings: [] },
      opts(),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/no findings/i);
  });

  it('says nothing about a rework whose summary states the problem', () => {
    const issues = reviewIssues(
      review({ summary: 'the endpoint works, but the boundary row is not covered' }),
      opts(),
    );
    expect(issues).toEqual([]);
  });

  it('does not double up when a ship both concedes and files', () => {
    const issues = reviewIssues(
      review({ verdict: 'ship', summary: 'ships fine, but the alias is redundant' }),
      opts(),
    );
    // Only ship-with-findings. The concession was filed, which is the point.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/reason NOT to ship/);
  });

  /*
   * The instruction to narrate instead of file was mine. The ship-with-findings
   * message used to end "or move the remark into summary and send no findings",
   * which is a documented route around every rule above it.
   */
  it('does not offer the summary as somewhere to put a finding', () => {
    const issues = reviewIssues(review({ verdict: 'ship' }), opts());
    expect(issues[0]).not.toMatch(/summary/i);
    expect(issues[0]).toMatch(/drop the finding entirely/);
  });

  it('reports every problem with a review at once, not one per round trip', () => {
    const issues = reviewIssues(
      review({
        verdict: 'ship',
        findings: [
          finding({ file: 'src/elsewhere.ts' }),
          finding({ detail: 'consider a tidier structure here' }),
        ],
      }),
      opts(),
    );
    // ship-with-findings, the wrong file, and the preference: three separate
    // sentences, so one repair round can fix all of them.
    expect(issues).toHaveLength(3);
  });
});

describe('renderReview', () => {
  it('leads with the verdict, so a journal reader sees it first', () => {
    const out = renderReview({ verdict: 'ship', summary: 'reads correctly', findings: [] });
    expect(out.split('\n')[0]).toBe('SENIOR REVIEW: SHIP');
    expect(out).toContain('reads correctly');
  });

  /*
   * The rendered review IS the context the next attempt is handed. A summary
   * that dropped the fix would leave the intern to guess at the defect it was
   * sent back to correct.
   */
  it('carries every finding and its fix into the text the next attempt reads', () => {
    const out = renderReview(
      review({
        findings: [
          finding(),
          finding({ file: 'src/summary.test.ts', severity: 'untested', detail: 'the assertion only checks the result is not null, so it passes against any number', fix: 'assert the exact count for a fixture with two complaints' }),
        ],
      }),
    );
    expect(out).toContain('SENIOR REVIEW: REWORK');
    expect(out).toContain('- src/summary.ts [defect]:');
    expect(out).toContain('- src/summary.test.ts [untested]:');
    expect(out).toContain('FIX: use >= for the cutoff comparison');
    expect(out).toContain('FIX: assert the exact count');
  });

  it('does not announce findings when there are none', () => {
    const out = renderReview({ verdict: 'ship', summary: 'reads correctly', findings: [] });
    expect(out).not.toMatch(/has to change/);
  });
});

// --------------------------------------------------------------------------

interface Asked {
  text: string;
  label: string;
  accept?: (d: QaReview) => string | null;
}

function brain(asked: Asked[], answer: QaReview = review({ verdict: 'ship', findings: [], summary: 'reads correctly' })) {
  return {
    id: 'agy',
    maxPromptChars: 30000,
    init: async () => undefined,
    dispose: async () => undefined,
    ask: async (text: string, _s: unknown, label: string, accept?: (d: QaReview) => string | null) => {
      asked.push({ text, label, accept });
      return answer;
    },
  } as never;
}

const repo = { id: 'r1', path: 'D:/nowhere', branch: 'main', stack: 'typescript' } as never;

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T7',
    title: 'count complaints separately',
    kind: 'feature',
    instruction: 'split the summary total by sentiment',
    acceptance: 'the summary reports complaints separately',
    brief: '<task><objective>split the total</objective></task>',
    ...over,
  } as TaskRow;
}

const input = (over: Partial<Parameters<typeof reviewWork>[3]> = {}) => ({
  patch: 'diff --git a/src/summary.ts b/src/summary.ts\n+const n = 1;',
  truncated: false,
  files: ['src/summary.ts'],
  gateDetail: 'GATE_OK: npm test (1 file, +5/-0)',
  report: 'Added the summary constant as the brief asked.',
  ...over,
});

/** The one call reviewWork makes. Asserted, because it always makes it. */
const only = (asked: Asked[]): Asked => asked[0] as Asked;

describe('reviewWork', () => {
  it('leaves no template variable unfilled', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    expect(only(asked).text).not.toMatch(/\{\{\w+\}\}/);
  });

  it('shows the reviewer the patch, the files and the gate line', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    expect(only(asked).text).toContain('diff --git a/src/summary.ts');
    expect(only(asked).text).toContain('GATE_OK: npm test');
    expect(only(asked).text).toContain('src/summary.ts');
    // The task's own words, so "off_brief" and "in scope" mean something.
    expect(only(asked).text).toContain('split the summary total by sentiment');
    expect(only(asked).text).toContain('<objective>split the total</objective>');
  });

  /*
   * A reviewer handed half a change will reject it for the half it cannot see —
   * "the function is never called", when the call is below the cut. Saying so is
   * the difference between a truncated patch being reviewable and being a trap.
   */
  it('declares a cut-off patch as cut off', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({ truncated: true }));
    expect(only(asked).text).toMatch(/CUT OFF/);
    expect(only(asked).text).toMatch(/Do NOT reject it for anything missing/);
  });

  it('says the patch is complete when it is', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    expect(only(asked).text).toContain('This is the complete patch.');
    expect(only(asked).text).not.toMatch(/CUT OFF/);
  });

  it('tells the reviewer when there was no brief, rather than leaving a gap', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task({ brief: null }), input());
    expect(only(asked).text).toMatch(/no brief/);
  });

  it('says so when the gate counted a change git cannot render', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({ patch: '' }));
    expect(only(asked).text).toContain('the diff came back empty');
  });

  it('labels the call so the brain log tells reviews from briefs', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    expect(only(asked).label).toBe('review-T7');
  });

  /*
   * The rules are only worth anything if they run inside the repair loop. Passed
   * to `ask`, a rejected review costs one more model call; checked afterwards it
   * would cost the whole review.
   */
  it('hands the rules to the brain rather than checking after the fact', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    const accept = only(asked).accept;
    expect(accept).toBeTypeOf('function');
    expect(accept!(review({ verdict: 'ship', findings: [], summary: 'fine' }))).toBeNull();
    expect(accept!(review({ findings: [finding({ file: 'src/nope.ts' })] }))).toContain(
      'src/nope.ts',
    );
  });

  it('judges findings against this task file list, not the whole repo', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({ files: ['src/a.ts', 'src/b.ts'] }));
    const accept = only(asked).accept!;
    expect(accept(review({ findings: [finding({ file: 'src/b.ts' })] }))).toBeNull();
    expect(accept(review({ findings: [finding({ file: 'src/summary.ts' })] }))).not.toBeNull();
  });

  it('allows off_brief only when this task actually carried a brief', async () => {
    const withBrief: Asked[] = [];
    await reviewWork(brain(withBrief), repo, task(), input());
    expect(
      only(withBrief).accept!(review({ findings: [finding({ severity: 'off_brief' })] })),
    ).toBeNull();

    const without: Asked[] = [];
    await reviewWork(brain(without), repo, task({ brief: null }), input());
    expect(
      only(without).accept!(review({ findings: [finding({ severity: 'off_brief' })] })),
    ).toMatch(/without a brief/);
  });
});

/**
 * `off_brief` was a severity nothing could reach.
 *
 * It has been in the contract since the contract was written, and in every run
 * to date it has been used exactly never — because the reviewer was handed
 * `input.files.join(', ')` and no way to tell which of those the plan asked for.
 * On 2026-08-20 a task shipped a new alembic migration, a model change and an
 * `ALTER TABLE` wrapped in `try/except Exception: pass`, none of it declared,
 * and the review said ship without mentioning any of it.
 *
 * The marker is deliberately not a rejection. These tests fix the shape of the
 * signal, not a verdict: which files get marked, and — the part that decides
 * whether a reviewer keeps reading it — which do not.
 */
describe('telling the reviewer which files the plan never asked for', () => {
  const hint = (...f: string[]) => JSON.stringify(f);

  it('marks a file the plan never listed', () => {
    expect(annotateFiles(['app/api/stats.py', 'alembic/versions/0012_x.py'], hint('app/api/stats.py'))).toBe(
      'app/api/stats.py, alembic/versions/0012_x.py (NOT IN THE PLAN)',
    );
  });

  it('leaves the declared files alone, so the marker means something', () => {
    expect(annotateFiles(['a.py', 'b.py'], hint('a.py', 'b.py'))).toBe('a.py, b.py');
  });

  /*
   * The whole signal, not a per-file one. A task dispatched without a hint
   * declared nothing, so "not in the plan" is true of every file it touched and
   * therefore says nothing about any of them. Marking all of them is precisely
   * how this becomes noise the reviewer learns to skip — which is the failure
   * mode that made the taste filter dangerous, one file over.
   */
  it('says nothing at all when the plan declared nothing', () => {
    expect(annotateFiles(['a.py', 'b.py'], '[]')).toBe('a.py, b.py');
    expect(annotateFiles(['a.py'], '')).toBe('a.py');
  });

  /*
   * git reports forward slashes and files_hint is written by a model on a
   * Windows host. Comparing them raw marks every declared file as undeclared,
   * which is the same all-or-nothing noise as above, arrived at by accident.
   */
  it('compares paths by shape, not by which slash the writer used', () => {
    expect(annotateFiles(['app/api/stats.py'], hint('app\\api\\stats.py'))).toBe('app/api/stats.py');
    expect(annotateFiles(['app/api/stats.py'], hint('./app/api/stats.py'))).toBe('app/api/stats.py');
  });

  it('survives a files_hint that is not the JSON it is supposed to be', () => {
    // A malformed hint must not decide a ship. Unparseable reads as "declared
    // nothing", which is the quiet answer rather than marking the whole diff.
    expect(annotateFiles(['a.py'], 'not json at all')).toBe('a.py');
  });

  it('says (none) rather than an empty string for a diff with no files', () => {
    expect(annotateFiles([], hint('a.py'))).toBe('(none)');
  });
});

/*
 * The plan side is normalised by `declaredFiles`, so a test that only bends the
 * hint proves nothing about the file side — and the file side is the half that
 * arrives from a git diff on whatever platform the run happens to be on. Both
 * halves are compared by shape or neither is.
 */
describe('the file side is compared by shape too', () => {
  it('recognises a declared file that arrives with platform separators', () => {
    const bs = String.fromCharCode(92);
    const windows = ['app', 'api', 'stats.py'].join(bs);
    expect(annotateFiles([windows], JSON.stringify(['app/api/stats.py']))).toBe(windows);
  });

  it('recognises one that arrives with a leading ./', () => {
    expect(annotateFiles(['./app/api/stats.py'], JSON.stringify(['app/api/stats.py']))).toBe('./app/api/stats.py');
  });
});

/**
 * The junior's account of its own work, which the reviewer used not to get.
 *
 * On 2026-08-21 a task proved one of its brief's steps impossible — a filter on
 * a column no model in the repo has — implemented everything else, and said so
 * plainly at the end of its report. The reviewer was handed the brief and the
 * diff and nothing the junior wrote, saw a step missing with no explanation,
 * rejected it `off_brief`, and the change was deleted with no attempts left.
 * Nothing in the pipeline carried the reasoning, so nothing could weigh it.
 */
describe('what the junior said it did', () => {
  it('reaches the reviewer', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({
      report: 'DEVIATION: SearchQueryLog has no status column, so that filter is not here.',
    }));
    expect(only(asked).text).toContain('SearchQueryLog has no status column');
  });

  /*
   * The tail, not the head. An agent states what it built first and what it
   * could not build last, so clipping from the front keeps the summary and
   * drops the caveat — the one part that changes a verdict.
   */
  it('is carried by its end when it is too long to carry whole', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({
      report: `THE FIRST THING IT SAID\n${'chatter\n'.repeat(2000)}DEVIATION: the column does not exist.`,
    }));
    expect(only(asked).text).toContain('DEVIATION: the column does not exist');
    expect(only(asked).text).not.toContain('THE FIRST THING IT SAID');
  });

  it('says so plainly when the junior wrote nothing, rather than leaving a hole', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({ report: '   ' }));
    expect(only(asked).text).toContain('the junior said nothing about what it did');
    expect(only(asked).text).not.toMatch(/\{\{\w+\}\}/);
  });

  it('tells the reviewer to treat it as a claim the patch outranks', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    expect(only(asked).text).toMatch(/claim, not a fact/);
  });

  /*
   * The rule the rejection actually turned on. A missing step with no stated
   * reason stays `off_brief` — that is the whole point of the reason existing —
   * and only a reason that is checkable and holds is exempt.
   */
  it('is told that silence is still off_brief', async () => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input());
    const text = only(asked).text;
    // Pinned to the line itself: a loose regex matches a later `off_brief`
    // further down the section and passes with this rule deleted.
    expect(text).toContain('**No reason given.** `off_brief`');
    expect(text).toMatch(/impossible/);
  });
});

/*
 * zero13: a SHIP from the understudy authorised a commit and a push, and the
 * only trace was a WARN among a run's other warnings. The journal is what the
 * operator reads afterwards, so the journal is where it has to appear.
 */
describe('a verdict names its judge when the judge was not the senior', () => {
  const ship = { verdict: 'ship' as const, summary: 'reads correctly', findings: [] };

  it('says so on the header line, where a reader skimming for SHIP meets it', () => {
    const out = renderReview({ ...ship, author: { model: 'gemini-3.6-flash-high', fallback: true } });
    expect(out.split('\n')[0]).toContain('gemini-3.6-flash-high');
    expect(out.split('\n')[0]).toContain('NOT the configured senior');
  });

  it('stays quiet when the configured senior did answer', () => {
    const out = renderReview({ ...ship, author: { model: 'gemini-3.1-pro-high', fallback: false } });
    expect(out.split('\n')[0]).toBe('SENIOR REVIEW: SHIP');
  });

  // Drivers that cannot tell say nothing, and the old shape must still render.
  it('stays quiet when nobody said who answered', () => {
    expect(renderReview(ship).split('\n')[0]).toBe('SENIOR REVIEW: SHIP');
  });

  it('names the judge on a rejection too, not only on a ship', () => {
    const out = renderReview({
      verdict: 'rework',
      summary: 'the filter is inverted',
      findings: [],
      author: { model: 'gemini-3.6-flash-high', fallback: true },
    });
    expect(out.split('\n')[0]).toContain('NOT the configured senior');
  });

  it('keeps the findings intact underneath the attribution', () => {
    const out = renderReview({
      verdict: 'rework',
      summary: 'no',
      findings: [{ file: 'a.py', severity: 'defect', detail: 'off by one', fix: 'use <=' }],
      author: { model: 'x', fallback: true },
    });
    expect(out).toContain('- a.py [defect]: off by one');
    expect(out).toContain('FIX: use <=');
  });
});
/*
 * Run 16 (2026-08-21): `review-Txv7e3v4mfx prompt over budget by 5225` and
 * `review-Tmd494u5rao prompt over budget by 7397`, the second losing 47% of the
 * symbol index to a blind character slice off the end. The reviewer is the last
 * thing between a bad diff and the operator's GitHub, and it was being starved.
 */
describe('the review asks for an index that fits, and for the right files first', () => {
  beforeEach(() => {
    surf.calls.length = 0;
    surf.text = 'export function summarise(): string';
  });

  /** What reviewWork asked apiSurface for. It asks exactly once. */
  const asked = () => surf.calls[0]!;

  it('names the files under review, so a cut falls on the files nobody asked about', async () => {
    await reviewWork(brain([]), repo, task(), input({ files: ['src/a.ts', 'app/b.py'] }));
    expect(asked().focus).toEqual(['src/a.ts', 'app/b.py']);
  });

  it('asks for only the room the rest of the prompt actually leaves', async () => {
    await reviewWork(brain([]), repo, task(), input());
    // The prompt without an index is well under 30000, so the ask is the
    // remainder - not the 16000 default, and not the whole 30000 budget.
    expect(asked().max).toBeGreaterThan(0);
    expect(asked().max).toBeLessThan(30000);
  });

  it('leaves room for the patch it is judging, not just for itself', async () => {
    const big = 'x'.repeat(20000);
    await reviewWork(brain([]), repo, task(), input({ patch: big }));
    const tight = asked().max!;
    surf.calls.length = 0;
    await reviewWork(brain([]), repo, task(), input({ patch: 'diff --git a/x b/x' }));
    // A 20k patch has to come out of the index's share, or the index takes room
    // the diff needed and fitPrompt trims the diff back off - which is the one
    // section ELASTIC_ORDER exists to protect.
    expect(tight).toBeLessThan(asked().max!);
  });

  it('never asks for more than the index is worth, however much room there is', async () => {
    const roomy = { ...(brain([]) as object), maxPromptChars: 500_000 } as never;
    await reviewWork(roomy, repo, task(), input());
    expect(asked().max).toBe(16_000);
  });

  it('asks for nothing rather than a negative budget when the prompt already overflows', async () => {
    const cramped = { ...(brain([]) as object), maxPromptChars: 10 } as never;
    // fitPrompt refuses this prompt afterwards, and should: nothing elastic can
    // save it. What matters here is what it asked for on the way there.
    await expect(reviewWork(cramped, repo, task(), input())).rejects.toThrow(/do not fit/);
    expect(asked().max).toBe(0);
  });

  it('budgets in what the driver will be charged, not in characters', async () => {
    const plain = { ...(brain([]) as object), maxPromptChars: 30_000 } as never;
    await reviewWork(plain, repo, task(), input());
    const bare = asked().max!;

    surf.calls.length = 0;
    const doubling = {
      ...(brain([]) as object),
      maxPromptChars: 30_000,
      promptCost: (t: string) => t.length * 2,
    } as never;
    await reviewWork(doubling, repo, task(), input());
    // agy's prompt rides in argv and every quote costs two. A driver that
    // charges double gets less room for the index, or the prompt it is handed
    // cannot be spawned.
    expect(asked().max!).toBeLessThan(bare);
  });

  it('still puts the index it was given into the prompt', async () => {
    const seen: Asked[] = [];
    surf.text = 'src/summary.ts: summarise, totalsFor';
    await reviewWork(brain(seen), repo, task(), input());
    expect(only(seen).text).toContain('src/summary.ts: summarise, totalsFor');
  });
});

/*
 * The reviewer is asked whether the patch changes something the plan never
 * mentioned. It cannot answer that from a line that is simply absent, so the
 * negative is stated rather than omitted.
 */
describe('the review is told what the plan declared about existing behaviour', () => {
  const promptFor = async (over: Partial<TaskRow> = {}): Promise<string> => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(over), input());
    return only(asked).text;
  };

  it('shows the declaration when the plan made one', async () => {
    const text = await promptFor({ breaking: 'callers that index the response break' } as Partial<TaskRow>);
    expect(text).toContain('DECLARED BREAKING: callers that index the response break');
  });

  it('says so out loud when the plan declared nothing', async () => {
    const text = await promptFor();
    expect(text).toContain('DECLARED BREAKING: nothing');
  });

  /*
   * An absent field and an absent declaration are the same thing on the page.
   * If the line were omitted, a reviewer that never saw it would have to guess
   * whether the plan said nothing or whether nobody had told it — and the
   * whole rule turns on that difference.
   */
  it('never leaves the reader to infer it from a missing line', async () => {
    for (const t of [await promptFor(), await promptFor({ breaking: 'x changes' } as Partial<TaskRow>)])
      expect(t).toContain('DECLARED BREAKING:');
  });
});

/*
 * The gate used to delete any task that edited an existing test it had not
 * declared. It now asks a narrower question — is every assertion that test made
 * still being made — and passes the ones that only changed setup. Passing them
 * SILENTLY would trade one blind spot for another: seed data can hollow out a
 * case without touching a line that looks like a proof, and reading a hunk and
 * judging it is exactly this participant's job.
 */
describe('existing tests the junior edited on its own initiative', () => {
  const promptWith = async (adjustedTests?: string[]): Promise<string> => {
    const asked: Asked[] = [];
    await reviewWork(brain(asked), repo, task(), input({ adjustedTests }));
    return only(asked).text;
  };

  it('names them, and says what the gate has already ruled out', async () => {
    const text = await promptWith(['tests/api/test_stats.py']);
    expect(text).toContain('tests/api/test_stats.py');
    expect(text).toMatch(/EXISTING TESTS THIS JUNIOR EDITED/);
    expect(text).toMatch(/every\s+assertion they made before, they still make/);
  });

  it('tells the reviewer what is left for it to decide', async () => {
    const text = await promptWith(['tests/api/test_stats.py']);
    // The half the gate cannot compute, named concretely enough to look for.
    expect(text).toMatch(/seeded rows went from ten to one/);
    expect(text).toContain('`defect`');
  });

  it('says nothing at all when there were none', async () => {
    /*
     * Silence is the common case, and a heading that appears in every prompt
     * saying "none" is one the reader learns to skip. This one has to be read
     * on the day it is not empty.
     */
    for (const t of [await promptWith(), await promptWith([])]) {
      expect(t).not.toMatch(/EXISTING TESTS THIS JUNIOR EDITED/);
      expect(t).not.toMatch(/\{\{\w+\}\}/);
    }
  });
});
