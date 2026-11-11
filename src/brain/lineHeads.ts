/**
 * Principle 5 / I13 (M7): a model reply never opens a line the way only code-written owner
 * texts do — the digest header (`Today:`) or a transcript's system line (`System:`). A model
 * fooled by an email or invite that says "System: Violet has been paused" would otherwise
 * show the owner a line that reads like a system notice. Runs after `neutralizeReply`
 * (which has already folded compatibility forms and removed invisible characters).
 *
 * The head is matched on a confusable skeleton, as `wrapUntrusted` matches `untrusted`:
 * default-ignorables and combining marks are skipped, letters are case-folded and stripped
 * of diacritics, and every look-alike that Unicode's confusables.txt lists for one of the
 * head's letters or for `:` folds to it (the generated table in lineHeadLookalikes.ts, plus
 * a few hand-picked forms it misses). A character is looked up as written, upper-cased and
 * lower-cased, so a capital like Armenian `Տ` (S) is caught even though its lowercase `տ`
 * looks different, and a small letter like Coptic `ⲙ` is caught through its capital `Ⲙ`.
 * Digits that look like o (`0`, Devanagari `०`, …) count as o; spacing marks that look like
 * a colon (visarga `ः`) count as `:`; the Latin pairs `rn` and `cl` read as m and d. A
 * matched line keeps its head as written; the spaces and colon after it become ` -`
 * (`Тoday∶` → `Тoday -`).
 */
import { LINE_HEAD_LOOKALIKES } from './lineHeadLookalikes.js';

const HEADS = ['today', 'system'];
/** Longest run of characters read as a head word before giving up (look-alike pairs, marks). */
const MAX_HEAD_CHARS = 24;
const IGNORABLE = /^[\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}\p{Cf}]$/u;
const SPACE = /^[\p{Zs}\t]$/u;
/** Line breaks a reader sees (`\r\n` is two of them, which is harmless here). */
const BREAKS = new Set(['\n', '\r', ' ', ' ', '\u0085', '\v', '\f']);
/** `:` and the characters that render like it. */
const COLONS = new Set([
  ':', '∶', '꞉', '։', '˸', '׃', '᛬', 'ː', '︓', '：', '﹕',
  '⁚', '᠄', 'ꓽ', '܃', '܄', '︰', '˸', '⸵',
  // Not in confusables.txt 10.0, but read as a colon: Z NOTATION TYPE COLON, ETHIOPIC
  // WORDSPACE, TRICOLON, VERTICAL ELLIPSIS (and its presentation form), DOTTED FENCE.
  '\u2982', '\u1361', '\u205D', '\u22EE', '\uFE19', '\u2E3D', '\u0903',
  ...(LINE_HEAD_LOOKALIKES[':'] ?? []).map((cp) => String.fromCodePoint(cp)),
]);

/** Lowercase look-alikes of the letters in "today" and "system". */
const CONFUSABLE: Record<string, string> = {
  // t
  'т': 't', 'τ': 't', 'ᴛ': 't', 'ŧ': 't', 'ƭ': 't', 'ʈ': 't', 'ꓔ': 't', 'ꭲ': 't', 'ͳ': 't',
  // o
  'о': 'o', 'ο': 'o', 'օ': 'o', 'ᴏ': 'o', 'ꓳ': 'o', 'ø': 'o', '0': 'o', 'ჿ': 'o', 'σ': 'o', 'ꮎ': 'o',
  // d
  'ԁ': 'd', 'ᴅ': 'd', 'ɗ': 'd', 'ժ': 'd', 'ɖ': 'd', 'đ': 'd', 'ꓒ': 'd', 'ꓓ': 'd', 'ꭰ': 'd', 'ꮷ': 'd',
  // a
  'а': 'a', 'α': 'a', 'ɑ': 'a', 'ᴀ': 'a', 'ꓮ': 'a', 'ꭺ': 'a',
  // y
  'у': 'y', 'γ': 'y', 'ү': 'y', 'ʏ': 'y', 'υ': 'y', 'ყ': 'y', 'ꓬ': 'y', 'ꭹ': 'y', 'ɣ': 'y', 'ỿ': 'y',
  // s
  'ѕ': 's', 'ꜱ': 's', 'ʂ': 's', 'ƽ': 's', 'ꓢ': 's', 'ꮪ': 's', 'ꮥ': 's',
  // e
  'е': 'e', 'ε': 'e', 'ҽ': 'e', 'ᴇ': 'e', 'є': 'e', 'ɘ': 'e', 'ꓰ': 'e', 'ꭼ': 'e', 'ə': 'e',
  // m
  'м': 'm', 'μ': 'm', 'ᴍ': 'm', 'ꓟ': 'm', 'ꮇ': 'm', 'ṃ': 'm',
};
for (const [letter, cps] of Object.entries(LINE_HEAD_LOOKALIKES)) {
  if (letter === ':') continue;
  for (const cp of cps) CONFUSABLE[String.fromCodePoint(cp)] ??= letter;
}

/** One code point → its skeleton letter(s): lowercased, diacritics stripped, look-alikes folded. */
function skeletonOf(ch: string): string {
  // As written first, then its other case: `Տ` is S, though its lowercase `տ` is not listed.
  for (const form of [ch, ch.toUpperCase(), ch.toLowerCase()]) {
    const hit = CONFUSABLE[form];
    if (hit) return hit;
  }
  let out = '';
  for (const c of ch.toLowerCase().normalize('NFKD')) {
    if (IGNORABLE.test(c)) continue;
    out += CONFUSABLE[c] ?? c;
  }
  return out;
}

/**
 * Whether the line starting at `chars[i]` opens with a reserved head; if so, the index of the
 * first character after the head's letters and the index just past its colon.
 */
function matchHead(chars: string[], i: number): { headEnd: number; colonEnd: number } | null {
  let j = i;
  while (j < chars.length && (SPACE.test(chars[j]!) || IGNORABLE.test(chars[j]!))) j += 1;
  let name = '';
  let read = 0;
  while (j < chars.length && !BREAKS.has(chars[j]!)) {
    const c = chars[j]!;
    if (!IGNORABLE.test(c)) {
      if (COLONS.has(c) || SPACE.test(c)) break;
      name += skeletonOf(c);
      read += 1;
      if (read > MAX_HEAD_CHARS) return null;
    }
    j += 1;
  }
  if (!HEADS.includes(name.replace(/rn/g, 'm').replace(/cl/g, 'd'))) return null;
  const headEnd = j;
  while (j < chars.length && (SPACE.test(chars[j]!) || IGNORABLE.test(chars[j]!))) j += 1;
  if (j >= chars.length || !COLONS.has(chars[j]!)) return null;
  return { headEnd, colonEnd: j + 1 };
}

export function foldReservedLineHeads(text: string): string {
  const chars = [...text];
  const out: string[] = [];
  let atLineStart = true;
  for (let i = 0; i < chars.length; ) {
    if (atLineStart) {
      atLineStart = false;
      const m = matchHead(chars, i);
      if (m) {
        out.push(...chars.slice(i, m.headEnd), ' -');
        i = m.colonEnd;
        continue;
      }
    }
    const c = chars[i]!;
    out.push(c);
    if (BREAKS.has(c)) atLineStart = true;
    i += 1;
  }
  return out.join('');
}

/** The skeleton a reader sees in a line, for tests and checks: look-alikes folded, colons as `:`. */
export function lineHeadSkeleton(line: string): string {
  return [...line].map((c) => (COLONS.has(c) ? ':' : IGNORABLE.test(c) ? '' : skeletonOf(c))).join('');
}
