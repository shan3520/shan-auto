/**
 * Terminal drawing and key handling.
 *
 * Written against Node's own tty rather than a UI library, because "no new
 * runtime dependencies" has held since the first commit and a menu is not a
 * good reason to break it. Everything here is escape codes and a keypress
 * reader — nothing clever, and nothing to keep updated.
 *
 * The audience is a person who does not read YAML. Every string that reaches
 * the screen is written for them: no `verify_cmd`, no "killswitch", no ids.
 */

const ESC = '\x1b';
export const RESET = `${ESC}[0m`;

export const c = {
  dim: (s: string) => `${ESC}[2m${s}${RESET}`,
  bold: (s: string) => `${ESC}[1m${s}${RESET}`,
  green: (s: string) => `${ESC}[32m${s}${RESET}`,
  yellow: (s: string) => `${ESC}[33m${s}${RESET}`,
  red: (s: string) => `${ESC}[31m${s}${RESET}`,
  cyan: (s: string) => `${ESC}[36m${s}${RESET}`,
  invert: (s: string) => `${ESC}[7m${s}${RESET}`,
};

export function clear(): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}

export function hideCursor(): void {
  process.stdout.write(`${ESC}[?25l`);
}

export function showCursor(): void {
  process.stdout.write(`${ESC}[?25h`);
}

export type Key =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'space'
  | 'tab'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'delete'
  | 'unknown'
  | { char: string };

/**
 * The named sequences, longest first.
 *
 * Order matters: `ESC[1~` has to be tried before a bare `ESC`, or Home reads as
 * Escape and leaves "[1~" behind to be typed into whatever is open.
 */
const SEQUENCES: [string, Key][] = [
  [`${ESC}[A`, 'up'],
  [`${ESC}[B`, 'down'],
  [`${ESC}[D`, 'left'],
  [`${ESC}[C`, 'right'],
  [`${ESC}[H`, 'home'],
  [`${ESC}[1~`, 'home'],
  [`${ESC}[7~`, 'home'],
  [`${ESC}OH`, 'home'],
  [`${ESC}[F`, 'end'],
  [`${ESC}[4~`, 'end'],
  [`${ESC}[8~`, 'end'],
  [`${ESC}OF`, 'end'],
  [`${ESC}[5~`, 'pageup'],
  [`${ESC}[6~`, 'pagedown'],
  [`${ESC}[3~`, 'delete'],
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\x7f', 'backspace'],
  ['\b', 'backspace'],
  [' ', 'space'],
  ['\t', 'tab'],
];

/**
 * A complete but unnamed CSI/SS3 sequence — F5, a mouse report, a paste marker.
 *
 * Deliberately does NOT match a bare ESC. Escape is a key the operator presses,
 * and it means "back" on every screen in this TUI; matching it here would file
 * it under "sequence this build has no name for" and go nowhere.
 */
const UNKNOWN_SEQ = /^\x1B(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/;

/**
 * Take ONE key off the front of a chunk and return what is left.
 *
 * What is left is the whole point. This used to `switch` on the entire chunk,
 * so a chunk carrying two keys matched no case at all and BOTH were thrown
 * away — silently, with the screen redrawn unchanged.
 *
 * stdin coalesces whenever input arrives faster than the app reads it: an arrow
 * key held down, two quick presses, a paste, a slow connection catching up.
 * Measured 2026-08-15 — "\x1B[B\r" moved no cursor and chose nothing, and three
 * Downs in one chunk moved nothing at all. To the operator the menu has simply
 * stopped responding. It also cost a 40-minute unattended run, which sat on the
 * main menu waiting for a keypress that had already been made.
 */
export function nextKey(s: string): { key: Key; rest: string } {
  for (const [seq, key] of SEQUENCES) {
    if (s.startsWith(seq)) return { key, rest: s.slice(seq.length) };
  }
  // Ctrl-C must always work, whatever screen is drawn.
  if (s.startsWith('\x03')) {
    showCursor();
    process.exit(0);
  }
  /*
   * Never hand an escape sequence back as text. A key this build does not
   * recognise — F5, a mouse report, a bracketed-paste marker — would otherwise
   * be typed straight into whatever field is open, and a stray "[15~" inside an
   * idea goes on to the planner as part of the brief. Consumed, then ignored.
   */
  const esc = UNKNOWN_SEQ.exec(s);
  if (esc) return { key: 'unknown', rest: s.slice(esc[0].length) };
  // A bare ESC, or ESC starting something this build does not know: the key
  // itself. Only the ESC is consumed, so whatever follows is read next.
  if (s.startsWith(ESC)) return { key: 'escape', rest: s.slice(1) };
  return { key: { char: s.slice(0, 1) }, rest: s.slice(1) };
}

/**
 * Keys that arrived in a chunk but have not been asked for yet.
 *
 * Kept across screens deliberately — that is ordinary type-ahead, and it is
 * what makes a held arrow key work. It cannot answer a dangerous question by
 * itself, though the reason has narrowed: it used to be that EVERY `confirm`
 * opens on "No, go back", and one now opens on Yes (see `confirm`).
 *
 * That one is still not reachable by a stray Enter, because it is not the last
 * word. "Also create it on GitHub?" is followed immediately by `Create "name"?`
 * — which lists what is about to happen, including whether it goes on GitHub,
 * and still opens on No. Type-ahead cannot walk through both, and nothing is
 * created until the second one is answered deliberately.
 *
 * So the invariant to keep is not "every confirm starts on No". It is that the
 * LAST confirm before anything happens starts on No.
 */
let pending = '';

/**
 * One keypress.
 *
 * Raw mode is entered per read and left afterwards, so an exception anywhere in
 * a screen cannot strand the terminal with echo off — which looks to the user
 * like their computer has stopped responding to typing.
 */
export function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    if (pending) {
      const { key, rest } = nextKey(pending);
      pending = rest;
      return resolve(key);
    }

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    const onData = (buf: Buffer) => {
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
      stdin.pause();

      const { key, rest } = nextKey(buf.toString());
      pending = rest;
      resolve(key);
    };

    stdin.on('data', onData);
  });
}

export function isChar(k: Key, ch: string): boolean {
  return typeof k === 'object' && k.char.toLowerCase() === ch.toLowerCase();
}

const WIDTH = () => Math.min(process.stdout.columns || 80, 100);

/** Length ignoring colour codes, so padding lines up once they are coloured. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function pad(s: string, width: number): string {
  const gap = width - visibleLength(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

export function rule(): string {
  return c.dim('─'.repeat(WIDTH()));
}

/** The banner every screen shares, so the user always knows where they are. */
export function header(title: string, subtitle?: string): string[] {
  return [
    '',
    `  ${c.bold(c.cyan('ShanAuto'))}  ${c.dim('·')}  ${c.bold(title)}`,
    subtitle ? `  ${c.dim(subtitle)}` : '',
    `  ${rule()}`,
    '',
  ].filter((l) => l !== '');
}

export function footer(hint: string): string[] {
  return ['', `  ${rule()}`, `  ${c.dim(hint)}`, ''];
}

export function draw(lines: string[]): void {
  clear();
  process.stdout.write(lines.join('\n') + '\n');
}

export interface MenuItem {
  label: string;
  /** Shown under the highlighted row. This is where the jargon gets explained. */
  help?: string;
  /** Right-aligned status, e.g. a current value or a count. */
  value?: string;
  disabled?: boolean;
  /** Already at the lowest / highest choice, so that arrow does nothing. */
  atStart?: boolean;
  atEnd?: boolean;
}

/**
 * Arrow-key menu. Returns the chosen index, or -1 if the user backed out.
 *
 * The help line for the highlighted row is always visible rather than hidden
 * behind a key, because the person using this does not know what any of these
 * words mean yet and should not have to discover a help key to find out.
 */
export async function menu(
  title: string,
  items: MenuItem[],
  opts: { subtitle?: string; hint?: string; start?: number; body?: string[] } = {},
): Promise<number> {
  let i = Math.max(0, Math.min(opts.start ?? 0, items.length - 1));
  // Never open on a disabled row — the help text would explain an option that
  // cannot be chosen.
  if (items[i]?.disabled) {
    const firstEnabled = items.findIndex((it) => !it.disabled);
    if (firstEnabled >= 0) i = firstEnabled;
  }

  for (;;) {
    const width = WIDTH();
    const lines = [...header(title, opts.subtitle), ...(opts.body ?? [])];

    items.forEach((item, n) => {
      const selected = n === i;
      const bullet = selected ? c.cyan('❯') : ' ';
      const label = item.disabled ? c.dim(item.label) : item.label;
      const value = item.value ? c.dim(item.value) : '';
      const left = `  ${bullet} ${label}`;
      lines.push(value ? `${pad(left, width - visibleLength(value) - 2)}${value}` : left);
    });

    const help = items[i]?.help;
    lines.push('', help ? `    ${c.dim(help)}` : '');
    lines.push(...footer(opts.hint ?? '↑↓ move · Enter choose · Esc back'));
    draw(lines);

    const k = await readKey();
    if (k === 'up' || isChar(k, 'k')) {
      do {
        i = (i - 1 + items.length) % items.length;
      } while (items[i]?.disabled);
    } else if (k === 'down' || isChar(k, 'j')) {
      do {
        i = (i + 1) % items.length;
      } while (items[i]?.disabled);
    } else if (k === 'enter') {
      if (!items[i]?.disabled) return i;
    } else if (k === 'escape' || isChar(k, 'q')) {
      return -1;
    }
  }
}

/**
 * A yes/no question. Defaults to NO, because NO is the safe answer to almost
 * every question worth stopping to ask.
 *
 * `defaultYes` is for the exceptions, and there is currently one kind: a
 * question where the cautious-looking answer is the one that quietly breaks
 * what the operator asked for. "Also create it on GitHub?" is that question.
 * This system exists to push what survives the gate; a project that
 * never leaves this computer is not a safer version of that, it is a failure
 * of it, and it fails SILENTLY — nothing is wrong until days of work turn out
 * to be invisible on the profile they were for.
 *
 * The operator drives this system through this menu and does not read the
 * config. Whichever option sits under the cursor when they press Enter is the
 * one the system chose for them, so it had better be the one that does what
 * they came here to do.
 */
export async function confirm(
  question: string,
  detail: string[] = [],
  opts: { defaultYes?: boolean } = {},
): Promise<boolean> {
  const items = [{ label: 'No, go back' }, { label: 'Yes, do it' }];
  const pick = await menu('Are you sure?', items, {
    subtitle: question,
    body: detail.length ? [...detail.map((d) => `  ${d}`), ''] : [],
    hint: '↑↓ move · Enter choose · Esc cancel',
    start: opts.defaultYes ? 1 : 0,
  });
  return pick === 1;
}

/** A message the user has to acknowledge, so output is never wiped instantly. */
export async function notice(title: string, lines: string[]): Promise<void> {
  // Anything longer than the window gets a pager rather than being cut off,
  // because the interesting part of a diary or an error is rarely the top.
  const room = (process.stdout.rows || 24) - 8;
  if (lines.length > room) return pager(title, lines);
  draw([...header(title), ...lines.map((l) => `  ${l}`), ...footer('Press any key to go back')]);
  await readKey();
}

/**
 * A scrolling reader for output taller than the terminal.
 *
 * The diary was truncated to its first 200 lines with no indication that
 * anything followed — and a day the system worked properly runs to several
 * hundred. The end of the day is the part someone is looking for.
 */
export async function pager(title: string, lines: string[]): Promise<void> {
  const room = () => Math.max(5, (process.stdout.rows || 24) - 8);
  let top = 0;

  for (;;) {
    const height = room();
    const max = Math.max(0, lines.length - height);
    top = Math.min(top, max);
    const shown = lines.slice(top, top + height).map((l) => `  ${l}`);
    const pos = max === 0 ? '' : ` · line ${top + 1}-${Math.min(top + height, lines.length)} of ${lines.length}`;

    draw([
      ...header(title),
      ...shown,
      ...footer(`↑↓ scroll · PgUp/PgDn page · Esc back${pos}`),
    ]);

    const k = await readKey();
    if (k === 'escape' || k === 'enter' || isChar(k, 'q')) return;
    if (k === 'up') top = Math.max(0, top - 1);
    else if (k === 'down') top = Math.min(max, top + 1);
    else if (k === 'pageup') top = Math.max(0, top - height);
    else if (k === 'pagedown' || k === 'space') top = Math.min(max, top + height);
    else if (k === 'home') top = 0;
    else if (k === 'end') top = max;
  }
}

/**
 * A single-line text field.
 *
 * Deliberately not readline: this has to coexist with the raw-mode menu above,
 * and switching modes mid-screen leaves the terminal echoing keystrokes into
 * the drawing.
 */
export async function input(
  title: string,
  opts: { subtitle?: string; initial?: string; placeholder?: string } = {},
): Promise<string | null> {
  let text = opts.initial ?? '';

  /*
   * A pre-filled value behaves like selected text: the first thing typed
   * REPLACES it, and Backspace keeps it to edit.
   *
   * It used to append. Offered "D:/repos" as the folder to create a project
   * in, someone typing where they actually wanted it got
   * "D:/reposD:/repos/xyzProject" — a path that cannot exist, from a field
   * that was only pre-filled to be helpful. Every text editor and browser
   * address bar behaves this way, which is why nobody expects otherwise.
   */
  let prefilled = (opts.initial ?? '').length > 0;

  for (;;) {
    const shown = text.length > 0
      ? (prefilled ? c.invert(text) : text)
      : c.dim(opts.placeholder ?? '');
    draw([
      ...header(title, opts.subtitle),
      `  ${shown}${prefilled ? '' : c.cyan('▏')}`,
      ...footer(
        prefilled
          ? 'Enter to accept · type to replace · Backspace to edit · Esc to cancel'
          : 'Type · Enter to save · Esc to cancel',
      ),
    ]);

    const k = await readKey();
    if (k === 'enter') return text.trim();
    if (k === 'escape') return null;

    if (k === 'backspace') {
      // Edit what is there rather than discarding it.
      prefilled = false;
      text = text.slice(0, -1);
    } else if (k === 'space') {
      if (prefilled) text = '';
      prefilled = false;
      text += ' ';
    } else if (typeof k === 'object') {
      if (prefilled) text = '';
      prefilled = false;
      text += k.char;
    }
  }
}

/**
 * A multi-line editor, for describing what to build.
 *
 * The idea is the one thing the user actually has to write, so it gets room to
 * breathe and an explicit "finish" key rather than Enter — Enter has to stay
 * free for new paragraphs.
 */
export async function editor(
  title: string,
  opts: { subtitle?: string; initial?: string; hint?: string } = {},
): Promise<string | null> {
  const lines: string[] = (opts.initial ?? '').split('\n');
  if (lines.length === 0) lines.push('');
  let row = lines.length - 1;

  for (;;) {
    const shown = lines.map((l, n) =>
      n === row ? `  ${l}${c.cyan('▏')}` : `  ${l || c.dim('·')}`,
    );
    draw([
      ...header(title, opts.subtitle),
      ...(opts.hint ? [`  ${c.dim(opts.hint)}`, ''] : []),
      ...shown,
      ...footer('Enter for a new line · Ctrl-S when finished · Esc to cancel'),
    ]);

    const k = await readKey();
    if (k === 'escape') {
      /*
       * Ask before throwing away what someone has written. Esc used to discard
       * the whole description instantly and silently, and this is the one screen
       * where the user has typed something they cannot get back — several
       * paragraphs, and Esc is right next to the keys they have been using to
       * move around.
       */
      const typed = lines.join('\n').trim();
      if (typed.length === 0) return null;
      const scrap = await confirm('Throw away what you have written?', [
        `You have written ${typed.length} character(s). This cannot be undone.`,
        '',
        'Choose "No" to carry on writing, then Ctrl-S when you are finished.',
      ]);
      if (scrap) return null;
      continue;
    }
    if (k === 'enter') {
      lines.splice(row + 1, 0, '');
      row++;
    } else if (k === 'backspace') {
      const cur = lines[row] ?? '';
      if (cur.length > 0) lines[row] = cur.slice(0, -1);
      else if (row > 0) {
        lines.splice(row, 1);
        row--;
      }
    } else if (k === 'space') {
      lines[row] = (lines[row] ?? '') + ' ';
    } else if (k === 'up' && row > 0) row--;
    else if (k === 'down' && row < lines.length - 1) row++;
    else if (typeof k === 'object') {
      // Ctrl-S finishes. Enter cannot, because paragraphs need it.
      if (k.char === '') {
        const text = lines.join('\n').trim();
        return text.length > 0 ? text : null;
      }
      // Ignore other control characters rather than printing them as garbage.
      if (k.char >= ' ') lines[row] = (lines[row] ?? '') + k.char;
    }
  }
}
