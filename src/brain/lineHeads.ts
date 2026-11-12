/**
 * Principle 5 / I13 (M7), best effort: a model reply should not open a line the way only
 * code-written owner texts do — the digest header (`Today:`) or a transcript's system line
 * (`System:`). A model fooled by an email or invite that says "System: Violet has been paused"
 * would otherwise show the owner a line that reads like a system notice. This reduces
 * confusion; it is not a guarantee, and no safety property rests on it (docs/ARCHITECTURE.md
 * 8.2). Runs after `neutralizeReply` (compatibility forms folded, invisible characters removed).
 *
 * The head WORD is matched on a confusable skeleton, as `wrapUntrusted` matches `untrusted`:
 * default-ignorables and non-spacing marks are skipped, letters are case-folded and stripped
 * of diacritics, and every look-alike that Unicode's confusables.txt lists for one of the
 * head's letters folds to it (the generated table in lineHeadLookalikes.ts, plus a few
 * hand-picked forms it misses). A character is looked up as written, upper-cased and
 * lower-cased (Armenian `Տ` is S; Coptic `ⲙ` is caught through `Ⲙ`). Digits that look like o
 * count as o; the Latin pairs `rn` and `cl` read as m and d.
 *
 * What follows the head is NOT matched against a list of colons (that class has no end:
 * visargas, Ethiopic and Tibetan punctuation, …). Once the head word reads `today` or
 * `system`, the line is folded unless the next character that is not a space or ignorable is
 *  - after a space, a letter or digit of any script (a new word: "Today is Friday", "System 7"),
 *    or nothing on that line;
 *  - one of SENTENCE_PUNCTUATION: `,` `.` `!` `?` end or pause a sentence ("Today, you
 *    have…", "Today."), `/` joins alternatives ("Today/tomorrow works") and
 *    the apostrophes `'` `’` make a possessive ("Today's plan"); none of them is drawn as two
 *    stacked dots. `-` is the fold's own mark, so folding is idempotent.
 * The head word runs while each character reads as a Latin letter or digit, so whatever is
 * written right after it without a space — a spacing mark such as a visarga `ః`, a modifier
 * letter `ː`, a Lisu letter `ꓽ` — folds unless it is in SENTENCE_PUNCTUATION, and that
 * punctuation must itself end the head (`Today.:` folds). A folded line keeps its head as
 * written; the spaces and the character after it become ` -` (`Today፥` → `Today -`), with a
 * space added before a word written right after it; an emoji, an opening bracket or quote, or
 * a currency sign there is kept (the ASCII `"` counts as an opening quote: `Today "big" day` →
 * `Today - "big" day`) (`Today 🎉` → `Today - 🎉`, `Today (Fri)` → `Today - (Fri)`).
 */
import { LINE_HEAD_LOOKALIKES } from './lineHeadLookalikes.js';

const HEADS = ['today', 'system'];
/** Longest run of characters read as a head word before giving up (look-alike pairs, marks). */
const MAX_HEAD_CHARS = 24;
const IGNORABLE = /^[\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}\p{Cf}]$/u;
const SPACE = /^[\p{Zs}\t]$/u;
/** Line breaks a reader sees (`\r\n` is two of them, which is harmless here). */
const BREAKS = new Set(['\n', '\r', ' ', ' ', '\u0085', '\v', '\f']);
/** Characters after the head word that keep the line as it is (see the header). */
const SENTENCE_PUNCTUATION = new Set([',', '.', '!', '?', '/', "'", '’', '-']);
/** Starts a new word after a space; modifier letters (ː ˸) read as punctuation, as in reply.ts. */
const LETTER_OR_DIGIT = /^(?!\p{Lm})[\p{L}\p{N}]$/u;
const EMOJI = /^\p{Extended_Pictographic}$/u;
/** Kept after the fold mark: opening brackets and quotes (the ASCII `"` included), currency signs (see `folded`). */
const KEPT_AFTER_FOLD = /^[\p{Ps}\p{Pi}\p{Sc}"]$/u;
/** A head-word character's skeleton: Latin letters and digits only. */
const LATIN_SKELETON = /^[a-z0-9]+$/u;

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

/** The head word runs while each character reads as a Latin letter or digit (look-alikes folded). */
const inWord = (c: string) => IGNORABLE.test(c) || LATIN_SKELETON.test(skeletonOf(c));
const blank = (c: string) => SPACE.test(c) || IGNORABLE.test(c);

/**
 * Whether the line starting at `chars[i]` opens with a reserved head; if so, the index of the
 * first character after the head word, and the index after the character that follows it
 * (spaces skipped) and how that character is kept.
 */
function matchHead(chars: string[], i: number): { headEnd: number; restAt: number; keep: string } | null {
  let j = i;
  while (j < chars.length && blank(chars[j]!)) j += 1;
  let name = '';
  let read = 0;
  for (; j < chars.length && !BREAKS.has(chars[j]!) && inWord(chars[j]!); j += 1) {
    if (IGNORABLE.test(chars[j]!)) continue;
    name += skeletonOf(chars[j]!);
    read += 1;
    if (read > MAX_HEAD_CHARS) return null;
  }
  if (!HEADS.includes(name.replace(/rn/g, 'm').replace(/cl/g, 'd'))) return null;
  const headEnd = j;
  while (j < chars.length && blank(chars[j]!)) j += 1;
  const next = chars[j];
  if (next === undefined || BREAKS.has(next)) return null;
  if (SENTENCE_PUNCTUATION.has(next)) {
    // The punctuation run must itself end the head: at a space, a line end, a letter or digit
    // ("Today's"), or an emoji. Anything else written right after it ("Today.:", "Today,꞉")
    // folds the run and that character, by the same rule as after the head word.
    let k = j;
    while (k < chars.length && (SENTENCE_PUNCTUATION.has(chars[k]!) || IGNORABLE.test(chars[k]!))) k += 1;
    const after = chars[k];
    if (after === undefined || BREAKS.has(after) || SPACE.test(after) || LETTER_OR_DIGIT.test(after) || EMOJI.test(after)) return null;
    return folded(chars, headEnd, k);
  }
  // After a space, a letter or digit of any script starts the next word. Right after the head,
  // any other letter (ꓽ, ː are letters) is not part of a Latin word: it folds.
  if (j > headEnd && LETTER_OR_DIGIT.test(next)) return null;
  return EMOJI.test(next) ? { headEnd, restAt: j, keep: ' ' } : folded(chars, headEnd, j);
}

/**
 * The fold drops the character at `at` (and the spaces before it), except an opening bracket
 * or quote, or a currency sign, which are kept (`Today (Friday)` → `Today - (Friday)`): by
 * their general category (Ps, Pi, Sc), not a list, and none of them is drawn as two stacked
 * dots. When what follows is not a space, a space is added so the next word stays a word.
 */
function folded(chars: string[], headEnd: number, at: number): { headEnd: number; restAt: number; keep: string } {
  const c = chars[at]!;
  if (KEPT_AFTER_FOLD.test(c)) return { headEnd, restAt: at, keep: ' ' };
  const after = chars[at + 1];
  return { headEnd, restAt: at + 1, keep: after === undefined || BREAKS.has(after) || SPACE.test(after) ? '' : ' ' };
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
        out.push(...chars.slice(i, m.headEnd), ' -', m.keep);
        i = m.restAt;
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
