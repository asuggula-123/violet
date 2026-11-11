import { FLAG_MAX_LENGTH } from '../core/flags.js';
import { sanitize } from '../core/sanitize.js';

/** Rendered by code only (no model): the digest header, section titles and caps. */
export const DIGEST_HEADER = 'Today:';
export const SECTION_LINE_CAP = 10;
export const DIGEST_CHAR_CAP = 3500;
/** Room kept for the "left out" footer line. */
const FOOTER_RESERVE = 40;

export interface DigestGroup {
  title: string;
  /** Raw item texts (untrusted: sanitized here to exactly one line each, I13). */
  items: string[];
}

export interface RenderedDigest {
  /** null when there is nothing to say. */
  body: string | null;
  itemCount: number;
  /** Items counted as delivered in this digest but not shown ('+N more', length cap). */
  leftOut: number;
}

/** kind: 'title' line, one 'item', or a section's '+N more' (already counted as left out). */
type Entry = { text: string; items: number; kind: 'title' | 'item' | 'more' };

/**
 * Plain text: 'Today:', then each non-empty group as a title line and one '- ' line per
 * item (at most SECTION_LINE_CAP, then '+N more'). Item text never starts a line (the
 * '- ' prefix comes first) and never holds a line break, so it cannot pose as a header,
 * a title, a second item or an approval prompt. Whole lines are cut at DIGEST_CHAR_CAP.
 */
export function renderDigest(groups: DigestGroup[]): RenderedDigest {
  const entries: Entry[] = [];
  let itemCount = 0;
  let sectionCut = 0;
  for (const g of groups) {
    if (g.items.length === 0) continue;
    itemCount += g.items.length;
    entries.push({ text: g.title, items: 0, kind: 'title' });
    for (const item of g.items.slice(0, SECTION_LINE_CAP)) entries.push({ text: `- ${sanitize(item, FLAG_MAX_LENGTH)}`, items: 1, kind: 'item' });
    const more = g.items.length - SECTION_LINE_CAP;
    if (more > 0) {
      sectionCut += more;
      entries.push({ text: `+${more} more`, items: more, kind: 'more' });
    }
  }
  if (itemCount === 0) return { body: null, itemCount: 0, leftOut: 0 };

  const shown: Entry[] = [];
  let length = DIGEST_HEADER.length;
  let lengthCut = 0;
  let notShown = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (length + 1 + e.text.length > DIGEST_CHAR_CAP - FOOTER_RESERVE) {
      for (const rest of entries.slice(i)) {
        notShown += rest.items;
        if (rest.kind === 'item') lengthCut += rest.items;
      }
      break;
    }
    shown.push(e);
    length += 1 + e.text.length;
  }
  // A cut never leaves a title line with no item under it.
  if (notShown > 0 && shown.at(-1)?.kind === 'title') shown.pop();
  const lines = [DIGEST_HEADER, ...shown.map((e) => e.text)];
  if (notShown > 0) lines.push(`+${notShown} more not shown`);
  return { body: lines.join('\n'), itemCount, leftOut: sectionCut + lengthCut };
}
