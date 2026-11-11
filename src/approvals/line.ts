import { sanitize } from '../core/sanitize.js';

/** Number signs: `#` and the look-alikes `＃` `﹟` that NFKC folds to it. */
const NUMBER_SIGNS = /[#＃﹟]/g;

/**
 * I13: one code-rendered line built from stored data. Control characters and line breaks
 * are stripped, the length is capped, and the text is NFKC-normalized before every number
 * sign is removed, so it can carry no `#<ref>` of its own: in an approval prompt the
 * leading `#<ref>` is the only reference, and a digest line never names one.
 */
export function codeLine(text: string, max: number): string {
  return sanitize(sanitize(text, max).normalize('NFKC').replace(NUMBER_SIGNS, ''), max);
}
