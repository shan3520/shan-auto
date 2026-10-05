import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting, SETTINGS } from '../tui/settings.js';

/**
 * The settings screen edits config/system.yaml in place.
 *
 * A YAML round-trip would have been simpler and was rejected: nearly every value
 * in that file sits under a comment explaining why it holds the value it does,
 * and several record an actual incident. Re-serialising would discard all of it
 * the first time someone nudged a number with an arrow key.
 */

const dir = mkdtempSync(join(tmpdir(), 'sa-settings-'));
const file = join(dir, 'system.yaml');

const ORIGINAL = [
  '# Global system behaviour.',
  '',
  '# This comment explains a real incident and must survive.',
  'daily_target: 30          # tasks to land per day',
  'max_daily_commits: 40     # HARD ceiling. A bug can never exceed this.',
  '',
  'work_hours:',
  '  start: "00:00"          # commits are only pushed inside this window',
  '  end: "23:59"',
  '',
  'limits:',
  '  max_attempts: 2         # retries per task',
  '  forbid_dead_exports: true',
  '',
  'retention:',
  '  journal_days: 90',
  '  artifact_days: 30       # the bulk of it',
].join('\n');

beforeEach(() => writeFileSync(file, ORIGINAL, 'utf8'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(file, 'utf8');

describe('writeSetting', () => {
  it('changes a top-level number', () => {
    writeSetting('daily_target', 25, file);
    expect(read()).toMatch(/^daily_target: 25\b/m);
  });

  it('changes a nested value without touching its sibling', () => {
    writeSetting('work_hours.start', '07:00', file);
    expect(read()).toMatch(/start: "07:00"/);
    expect(read()).toMatch(/end: "23:59"/);
  });

  it('quotes a value that would otherwise break the file', () => {
    // "07:00" unquoted is a different YAML type, and the schema would reject it.
    writeSetting('work_hours.end', '18:00', file);
    expect(read()).toContain('end: "18:00"');
  });

  it('changes a boolean', () => {
    writeSetting('limits.forbid_dead_exports', false, file);
    expect(read()).toMatch(/forbid_dead_exports: false/);
  });

  it('keeps every comment', () => {
    const before = ORIGINAL.split('\n').filter((l) => l.includes('#')).length;
    writeSetting('daily_target', 15, file);
    writeSetting('limits.max_attempts', 4, file);
    expect(read().split('\n').filter((l) => l.includes('#')).length).toBe(before);
    expect(read()).toContain('This comment explains a real incident and must survive.');
  });

  it('keeps a trailing comment in its original column', () => {
    // Otherwise a file that carries its own reasoning degrades a little every
    // time someone nudges a value with an arrow key.
    const col = ORIGINAL.split('\n').find((l) => l.startsWith('daily_target'))!.indexOf('#');
    writeSetting('daily_target', 5, file);
    expect(read().split('\n').find((l) => l.startsWith('daily_target'))!.indexOf('#')).toBe(col);
  });

  it('does not confuse a key with the same name in another block', () => {
    // `journal_days` and `artifact_days` both live under retention; a naive
    // search would take whichever came first.
    writeSetting('retention.artifact_days', 7, file);
    expect(read()).toMatch(/journal_days: 90/);
    expect(read()).toMatch(/artifact_days: 7\b/);
  });

  it('survives Windows line endings', () => {
    // This repo is checked out CRLF, and splitting on "\n" alone leaves a "\r"
    // that stopped the key matching at all — the first real edit threw
    // "could not find daily_target" on a line plainly containing it.
    writeFileSync(file, ORIGINAL.replace(/\n/g, '\r\n'), 'utf8');
    writeSetting('daily_target', 12, file);
    expect(read()).toMatch(/^daily_target: 12\b/m);
    expect(read()).toContain('\r\n');
  });

  it('refuses a key it cannot find rather than appending a broken line', () => {
    expect(() => writeSetting('nonsense.key', 1, file)).toThrow(/could not find/i);
    expect(read()).toBe(ORIGINAL);
  });

  it('refuses to edit a file that is not valid YAML (§9.8)', () => {
    // The value span is located by parsing the document, so a syntactically
    // broken file must be refused, not regex-patched blind. The file is left
    // untouched — no partial edit lands.
    writeFileSync(file, 'daily_target: [30\n', 'utf8');
    expect(() => writeSetting('daily_target', 25, file)).toThrow(/not valid YAML/i);
    expect(read()).toBe('daily_target: [30\n');
  });

  it('leaves no temp file behind after an edit (§9.8)', () => {
    // writeFileAtomic writes a sibling temp then renames it over the target.
    // A leftover temp would ride into the owner's next `git add -A`, so assert
    // the directory holds exactly the edited file afterwards.
    writeSetting('daily_target', 25, file);
    expect(readdirSync(dir)).toEqual(['system.yaml']);
  });
});

describe('the settings on offer', () => {
  it('gives every setting plain-language wording and choices', () => {
    for (const s of SETTINGS) {
      expect(s.label).not.toMatch(/_/); // no config vocabulary on screen
      expect(s.help.length).toBeGreaterThan(20);
      expect(s.choices.length).toBeGreaterThan(1);
    }
  });

  it('only offers values the real config file actually contains', () => {
    // A setting whose path is wrong would look editable and silently fail.
    const real = readFileSync(new URL('../../config/system.yaml', import.meta.url), 'utf8');
    for (const s of SETTINGS) {
      const key = s.path.split('.').pop()!;
      expect(real, `${s.path} is not in system.yaml`).toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
  });
});
