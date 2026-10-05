import { readFileSync } from 'node:fs';
import { parseDocument, Scalar } from 'yaml';
import { p } from '../config.js';
import { writeFileAtomic } from '../util.js';
import { c, confirm, menu, notice, type MenuItem } from './ui.js';

/**
 * Settings, described in the words a person would use.
 *
 * Each entry names a key in config/system.yaml, what it means in plain English,
 * and what happens if you get it wrong. Nobody operating this should have to
 * know what "overselect" is, or open a YAML file to find out what it does.
 *
 * Edited by arrow keys: left/right walks the allowed values, so it is not
 * possible to type something the schema will reject. Free-text numbers were the
 * obvious design and the wrong one — a mistyped ceiling is a real cost, and the
 * person here cannot be expected to know the safe range.
 */

export interface Setting {
  /** Dotted path into system.yaml, e.g. "limits.max_attempts". */
  path: string;
  label: string;
  help: string;
  /** Allowed values, walked with left/right. */
  choices: (number | string | boolean)[];
  /** How the value reads on screen. */
  format?: (v: number | string | boolean) => string;
  /** Shown before a change is saved, when the change deserves a warning. */
  warn?: (v: number | string | boolean) => string | null;
}

const hours = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, '0')}:00`).map((h) =>
  h === '24:00' ? '23:59' : h,
);

export const SETTINGS: Setting[] = [
  {
    path: 'daily_target',
    label: 'Changes to aim for each day',
    help: 'It stops for the day once it has landed this many. Higher needs more ideas from you to feed it.',
    choices: [5, 10, 15, 20, 25, 30, 40, 50],
  },
  {
    path: 'max_daily_commits',
    label: 'Hard limit on changes per day',
    help: 'A safety ceiling it can never cross, even if something goes wrong. Keep it above the target above.',
    choices: [10, 20, 30, 40, 60, 80, 100],
    warn: (v) =>
      Number(v) <= 10 ? 'That is close to the daily target — a normal day may stop early.' : null,
  },
  {
    path: 'work_hours.start',
    label: 'Start working at',
    help: 'It will not touch your projects before this time.',
    choices: hours,
  },
  {
    path: 'work_hours.end',
    label: 'Stop working at',
    help: 'It finishes the job in hand and then stops. Must be later than the start time.',
    choices: hours,
  },
  {
    path: 'limits.max_attempts',
    label: 'Retries before giving up on a job',
    help: 'How many times it re-tries a job that failed. More retries cost more of your daily allowance.',
    choices: [1, 2, 3, 4],
  },
  {
    path: 'limits.max_files_per_task',
    label: 'Most files one job may change',
    help: 'Keeps each change small enough to check. Raising it lets jobs sprawl across your project.',
    choices: [2, 3, 4, 5, 6, 8],
  },
  {
    path: 'limits.max_run_hours',
    label: 'Longest a single session may run',
    help: 'A stop-watch on the whole session, so it can never run all night by accident.',
    choices: [1, 2, 4, 6, 8, 12],
    format: (v) => `${v} hour${Number(v) === 1 ? '' : 's'}`,
  },
  {
    path: 'limits.forbid_dead_exports',
    label: 'Reject code nothing uses',
    help: 'Refuses to save code that is never called. Turning this off lets useless work count as progress.',
    choices: [true, false],
    format: (v) => (v ? 'On (recommended)' : 'Off'),
    warn: (v) => (v === false ? 'Two thirds of one day\'s work was once code nothing called.' : null),
  },
  {
    path: 'backlog.min_ready',
    label: 'Plan more work when fewer than',
    help: 'When the queue drops below this many jobs, it thinks up more on its own.',
    choices: [10, 20, 30, 50, 90],
    format: (v) => `${v} jobs left`,
  },
  {
    path: 'budget.daily_agent_units',
    label: 'Daily spending warning',
    help: 'Warns when the helpers have used this much of your monthly allowance in a day. 0 means never warn.',
    choices: [0, 5, 10, 20, 50, 100],
    format: (v) => (Number(v) === 0 ? 'Off' : `${v} units`),
  },
  {
    path: 'retention.artifact_days',
    label: 'Keep raw working files for',
    help: 'The full transcripts of every job. They are large. Summaries are kept forever regardless.',
    choices: [0, 7, 14, 30, 60, 90],
    format: (v) => (Number(v) === 0 ? 'Forever' : `${v} days`),
  },
  {
    path: 'retention.journal_days',
    label: 'Keep the daily diary for',
    help: 'The readable record of what it did. Filed into permanent memory before it is ever removed.',
    choices: [0, 30, 60, 90, 180, 365],
    format: (v) => (Number(v) === 0 ? 'Forever' : `${v} days`),
  },
];

const FILE = () => p('config', 'system.yaml');

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

/**
 * Rewrite one value in system.yaml, guided by the parsed document.
 *
 * The audit (§9.8) objected to a dotted-path regex edited against live YAML: a
 * hand-edited file could defeat the regex, and there was no lock against a
 * concurrent read seeing a torn write. The replacement answers both without
 * giving up what the old code was built to protect:
 *
 *   - `parseDocument` resolves the path the same way the reader resolves it, by
 *     YAML grammar — no regex over lines that a hand edit could mislead.
 *   - Only the value's exact source span is replaced. Comments, their column
 *     alignment, blank lines and the EOL convention survive byte-for-byte.
 *   - The write is atomic (temp + rename), so a reader that races this edit
 *     sees the old file or the new one, never a half-written one.
 *
 * A full parse -> mutate -> serialise round-trip was measured and rejected: it
 * collapses comment column alignment (`daily_target`'s `#` moved col 26 -> 17),
 * drops CRLF, and re-indents multi-line comments — precisely the degradation
 * this file and its tests exist to prevent.
 */
export function writeSetting(path: string, value: number | string | boolean, file = FILE()): void {
  const raw = readFileSync(file, 'utf8');
  const doc = parseDocument(raw);
  if (doc.errors.length) {
    throw new Error(`Cannot edit ${file}: it is not valid YAML (${doc.errors[0]!.message})`);
  }
  const node = doc.getIn(path.split('.'), true);
  if (!(node instanceof Scalar)) {
    throw new Error(`Could not find "${path}" in ${file}`);
  }
  /*
   * The value token's span in the source. `range` is [start, valueEnd, nodeEnd];
   * for a value with a trailing comment the nodeEnd extends past the comment, so
   * only the value span is replaced and the comment keeps its column.
   */
  const range = node.range;
  if (!range) {
    // A Scalar with no source span is degenerate (constructed programmatically);
    // nothing in the real file can hit this, but refuse rather than slice by 0.
    throw new Error(`Could not locate the value span for "${path}" in ${file}`);
  }
  const start = range[0];
  const end = range[1];
  const rendered = typeof value === 'string' && /[:\s]/.test(value) ? `"${value}"` : String(value);
  /*
   * Pad a shorter replacement back to the token's width so a trailing comment
   * keeps its column (`daily_target: 30` -> `5` must not drag the `#` left).
   * A longer value shifts the comment right; trailing space is legal YAML, so
   * nothing about the file degrades either way.
   */
  const pad = Math.max(0, end - start - rendered.length);
  writeFileAtomic(file, `${raw.slice(0, start)}${rendered}${' '.repeat(pad)}${raw.slice(end)}`);
}

function label(s: Setting, v: unknown): string {
  const val = v as number | string | boolean;
  return s.format ? s.format(val) : String(val);
}

/**
 * The settings screen. Left/right changes a value, Enter saves it.
 */
export async function settingsScreen(load: () => Record<string, unknown>): Promise<void> {
  let cursor = 0;

  for (;;) {
    let cfg: Record<string, unknown>;
    try {
      cfg = load();
    } catch (e) {
      await notice('Settings', [
        c.red('The settings file could not be read.'),
        '',
        `  ${(e as Error).message}`,
      ]);
      return;
    }

    const items: MenuItem[] = SETTINGS.map((s) => {
      const at = nearest(s, get(cfg, s.path) as number | string | boolean);
      return {
        label: s.label,
        help: `${s.help}   ${c.dim('← → to change')}`,
        value: label(s, get(cfg, s.path)),
        // So the screen never offers a direction that does nothing.
        atStart: at === 0,
        atEnd: at === s.choices.length - 1,
      };
    });
    items.push({ label: c.dim('Back'), help: 'Return to the main menu.' });

    const { index, key } = await menuWithArrows('Settings', items, cursor);
    if (index < 0 || index === SETTINGS.length) return;
    cursor = index;

    const setting = SETTINGS[index]!;
    if (key !== 'left' && key !== 'right') continue;

    const current = get(cfg, setting.path) as number | string | boolean;
    const at = nearest(setting, current);
    const step = key === 'right' ? 1 : -1;

    /*
     * Stop at the ends instead of wrapping round.
     *
     * Wrapping is fine for a list of names and dangerous for a range. One press
     * of → on "Stop working at 23:59" landed on 00:00, which is not "midnight
     * tonight" — it is before every start time, so the work window becomes zero
     * minutes and the system never runs again. No error, no warning; it simply
     * stops doing anything, and the reason is a single keystroke on a screen the
     * owner visited weeks earlier. The same press on "aim for 50 changes a day"
     * gave 5.
     */
    const target = at + step;
    if (target < 0 || target >= setting.choices.length) continue;
    const next = setting.choices[target]!;

    if (!(await allowed(setting, next, cfg))) continue;

    try {
      writeSetting(setting.path, next);
    } catch (e) {
      await notice('Could not save', [
        c.red((e as Error).message),
        '',
        'Nothing was changed.',
      ]);
    }
  }
}

/**
 * Where the current value sits in the list of choices.
 *
 * A value hand-edited into system.yaml — 12, say, when the list offers 10 and 15
 * — matched nothing, and the code fell back to index 0. So the first arrow press
 * on any hand-tuned setting jumped it to the LOWEST allowed value rather than
 * nudging it, silently rewriting a deliberate choice.
 */
function nearest(s: Setting, current: number | string | boolean): number {
  const exact = s.choices.findIndex((v) => String(v) === String(current));
  if (exact >= 0) return exact;

  const n = Number(current);
  if (!Number.isFinite(n)) return 0;

  let best = 0;
  let bestGap = Infinity;
  s.choices.forEach((v, i) => {
    const gap = Math.abs(Number(v) - n);
    if (Number.isFinite(gap) && gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
}

/**
 * Checks that need the whole config, plus the per-setting `warn`.
 *
 * `Setting.warn` was declared, written for two settings and never once called —
 * including the one that says two thirds of a day's work was code nothing
 * called. A warning nobody sees is a comment.
 */
async function allowed(
  s: Setting,
  next: number | string | boolean,
  cfg: Record<string, unknown>,
): Promise<boolean> {
  /*
   * The work window has to stay a window. Set the end before the start and the
   * system has nowhere left to run, which it reports as nothing at all.
   */
  if (s.path === 'work_hours.end' || s.path === 'work_hours.start') {
    const start = String(s.path === 'work_hours.start' ? next : get(cfg, 'work_hours.start'));
    const end = String(s.path === 'work_hours.end' ? next : get(cfg, 'work_hours.end'));
    if (end <= start) {
      await notice('That would leave no time to work', [
        `Start ${start} and stop ${end} means the working day is empty,`,
        'so it would never do anything again — with nothing on screen to say why.',
        '',
        'Nothing was changed. Move the other time first if you want a window',
        'this narrow.',
      ]);
      return false;
    }
  }

  const warning = s.warn?.(next);
  if (warning) {
    return confirm(`Set "${s.label}" to ${s.format ? s.format(next) : String(next)}?`, [warning]);
  }
  return true;
}

/**
 * A menu that also reports left/right, so a value can be changed without
 * leaving the list. `menu()` swallows those keys, and splitting the screens
 * would mean a page per setting for what should be one keystroke.
 */
async function menuWithArrows(
  title: string,
  items: MenuItem[],
  start: number,
): Promise<{ index: number; key: string }> {
  const { menuRaw } = await import('./menuRaw.js');
  return menuRaw(title, items, {
    start,
    subtitle: 'Change a value with ← and →. Changes save immediately.',
    hint: '↑↓ move · ← → change · Esc back',
  });
}
