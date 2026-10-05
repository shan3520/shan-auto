import { c, draw, footer, header, isChar, pad, readKey, type MenuItem } from './ui.js';

/**
 * A menu that reports left/right instead of ignoring them.
 *
 * The settings screen needs to change a value in place — a page per setting
 * would be a dozen screens for what should be one keystroke — and `menu()`
 * deliberately swallows those keys so ordinary lists cannot be nudged sideways
 * by accident. Rather than give every menu a mode, this is its own function.
 */
export async function menuRaw(
  title: string,
  items: MenuItem[],
  opts: { subtitle?: string; hint?: string; start?: number } = {},
): Promise<{ index: number; key: string }> {
  let i = Math.max(0, Math.min(opts.start ?? 0, items.length - 1));

  for (;;) {
    const width = Math.min(process.stdout.columns || 80, 100);
    const lines = [...header(title, opts.subtitle)];

    items.forEach((item, n) => {
      const selected = n === i;
      const bullet = selected ? c.cyan('❯') : ' ';
      /*
       * The arrows show which way this value can still move.
       *
       * A fixed pair was drawn on every selected row, so at the end of a list
       * the screen offered a direction that does nothing — and the natural
       * reading of pressing it and seeing no change is that the setting is
       * stuck, or that the screen has frozen.
       */
      const lo = item.atStart ? ' ' : c.cyan('◀');
      const hi = item.atEnd ? ' ' : c.cyan('▶');
      const value = item.value ? (selected ? `${lo} ${item.value} ${hi}` : c.dim(item.value)) : '';
      const left = `  ${bullet} ${item.label}`;
      lines.push(
        value ? `${pad(left, width - stripLen(value) - 2)}${value}` : left,
      );
    });

    lines.push('', items[i]?.help ? `    ${c.dim(items[i]!.help!)}` : '');
    lines.push(...footer(opts.hint ?? '↑↓ move · Enter choose · Esc back'));
    draw(lines);

    const k = await readKey();
    if (k === 'up') i = (i - 1 + items.length) % items.length;
    else if (k === 'down') i = (i + 1) % items.length;
    else if (k === 'left' || k === 'right') return { index: i, key: k };
    else if (k === 'enter') return { index: i, key: 'enter' };
    else if (k === 'escape' || isChar(k, 'q')) return { index: -1, key: 'escape' };
  }
}

function stripLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
