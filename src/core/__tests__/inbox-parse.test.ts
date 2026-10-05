import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../logger.js';

/*
 * A real file on a real disk, read by the real reader.
 *
 * parseInbox resolves its path through config's `p`, which is pinned to the
 * checkout root — so without this the tests would read the operator's actual
 * inbox, and either find nothing or plan something. `p` is the only thing
 * replaced; everything else in config is the shipped module.
 */
const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
mkdirSync(join(dir, 'ideas'), { recursive: true });

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  p: (...parts: string[]) => join(dir, ...parts),
}));

const { parseInbox } = await import('../planner.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg = { repos: [{ id: 'example-api' }, { id: 'shanauto' }] } as never;

const write = (s: string) => writeFileSync(join(dir, 'ideas', 'inbox.md'), s);
const warnings = () => vi.mocked(log.warn).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  vi.spyOn(log, 'info').mockImplementation(() => undefined);
});

/*
 * The 2026-08-20 run that found this: a hand-written inbox, one idea in it, and
 * a run that shaped nothing, planned nothing and reported "Nothing to work on"
 * — because the idea was written with one hash. The file was correct English
 * and completely invisible.
 *
 * The operator does not write this file by hand; the TUI writes "## " for them.
 * But the file is plain markdown sitting in the repo, the goal describes typing
 * into it directly, and the failure mode is an idea that vanishes without a
 * word. Every other rejection in parseInbox already says why.
 */
describe('text the inbox will not plan', () => {
  it('parses an idea written the way the TUI writes it', () => {
    write('# Ideas\n\n## Show me the failed searches\n\nrepo: example-api\n\nGroup them so the repeats stand out at a glance.\n');

    const ideas = parseInbox(cfg);

    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.title).toBe('Show me the failed searches');
    expect(ideas[0]?.repo).toBe('example-api');
    expect(warnings()).toEqual([]);
  });

  it('says so when an idea was written with one hash instead of two', () => {
    write('# Let me see what people keep asking for\n\nrepo: example-api\n\nWhen someone searches and does not find what they wanted, that is a signal.\nShow me those, grouped so I can tell which ones keep coming up.\n');

    expect(parseInbox(cfg)).toEqual([]);

    const w = warnings().join('\n');
    expect(w).toContain('not part of any idea');
    // The fix, not just the complaint. This is read by someone who did nothing
    // wrong except use one hash.
    expect(w).toContain('## ');
  });

  it('does not mistake the document title for an abandoned idea', () => {
    // Every real inbox opens with this line, and warning about it every run
    // would train the operator to ignore the warning that matters.
    write('# Ideas\n\n## A real one\n\nrepo: example-api\n\nA body long enough to be planned from, which this is.\n');

    expect(parseInbox(cfg)).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it('keeps quiet about a scrap too small to have been an idea', () => {
    // Same threshold the body check uses. A stray word is not a lost idea, and
    // treating it as one is how a warning stops being worth reading.
    write('# Ideas\n\nnote to self\n\n## A real one\n\nrepo: example-api\n\nA body long enough to be planned from, which this is.\n');

    expect(parseInbox(cfg)).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it('still plans the ideas it can see while complaining about the rest', () => {
    // The point of warning rather than refusing: the run is not held hostage by
    // a paragraph someone left at the top of the file.
    write('# Ideas\n\nI was going to describe the export thing here but never finished writing it out properly.\n\n## A real one\n\nrepo: example-api\n\nA body long enough to be planned from, which this is.\n');

    expect(parseInbox(cfg)).toHaveLength(1);
    expect(warnings().join('\n')).toContain('not part of any idea');
  });
});
