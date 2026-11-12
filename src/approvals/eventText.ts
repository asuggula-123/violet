import { neutralizeReply, quoteFolded } from '../brain/reply.js';
import { storable } from '../core/outbound.js';
import { sanitize } from '../core/sanitize.js';
import { NUMBER_SIGNS } from './line.js';

const NO_CAP = Number.MAX_SAFE_INTEGER;
const DOUBLE_QUOTES = /["“”„‟″‶❝❞〝-〟＂]/g;

/**
 * What you see is what gets booked: a text field written to a calendar is stored in the form
 * the code-rendered prompt shows it. One line, folded like every quoted text (`quoteFolded`),
 * NFKC, inner double quotes made single, number signs dropped — repeated until nothing
 * changes, so `quoteFolded` and the prompt's own `codeLine` leave it exactly as stored. It is made
 * storable first (U+0000 dropped, lone surrogates become U+FFFD; `jsonb` rejects both).
 */
export function canonicalEventText(text: string): string {
  let cur = sanitize(storable(text), NO_CAP);
  for (let i = 0; i < 10; i += 1) {
    const next = sanitize(neutralizeReply(cur).normalize('NFKC').replace(DOUBLE_QUOTES, "'").replace(NUMBER_SIGNS, ''), NO_CAP);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** A canonical text field in curly quotes, never cut (the prompt's fit check refuses what is too long). */
export function quotedField(text: string): string {
  return quoteFolded(text, NO_CAP);
}
