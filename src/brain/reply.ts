/**
 * K2 / principle 5: a model reply must not look like an approval prompt. Only prompts the
 * approval service renders carry `#<ref>` and the tail "Reply yes or no.". This runs on every
 * model reply (purpose 'reply') and on every agent-authored text an owner is shown (a2a
 * `shown()`, stranger text in the digest via `quoteFolded`). It does not try to know which
 * characters render blank; it decides by what is NOT a gap, and it judges the tail on the text
 * as the owner will see it (after NFKC), so nothing the function itself normalizes can rebuild it.
 *
 *  1. Invisible characters are removed: Cf and every Default_Ignorable_Code_Point (this
 *     includes the blank-rendering *letters*: the Hangul fillers are Lo and Default_Ignorable).
 *     Kept: a zero-width joiner between two emoji, a variation selector right after an emoji.
 *  2. Each remaining code point, AS WRITTEN, is a sign, a number, a letter, a mark or a GAP:
 *     - strong sign: anything whose NFKC form contains `#`, and the look-alikes ♯ ⌗ ⋕ ⧣ ⩩ ▦ ▩ ╪ ╫ ╬ 井 丼
 *       and the musical sharps U+1D130–U+1D132;
 *     - weak sign: any other non-Latin-1 symbol (\p{S}) whose NFKC form has no letter, except
 *       currency, emoji, arrows, the Misc Symbols / Dingbats / Braille / Geometric Shapes / Misc
 *       Symbols and Arrows / Musical Symbols blocks and a few common math signs (± − ≤ ≥ ≈ ≠ ∞ √ ∑ …) — fail closed: an unknown symbol may be a `#`;
 *     - number: \p{N}, or anything whose NFKC form contains one (⑦, ㏩);
 *     - plain letter: a letter whose NFKD form without marks is one ASCII letter (é, Ｂ); digit-like
 *       if that letter is I, O, l or o; cjk letter: Han / Hiragana / Katakana; other letter: the rest;
 *     - gap: everything else — spaces, punctuation, U+2800, U+1D159, private-use, unassigned,
 *       symbols whose NFKC form is letters (Ⓡ) and every MODIFIER LETTER (Lm: ʼ ˈ ˍ ꓸ ー), which
 *       reads as punctuation; marks are gaps too, except inside a word.
 *  3. Fail closed: a strong sign becomes `№` unless its next non-gap (signs skipped) begins a
 *     word of at least two plain letters whose first two are not both digit-like and that ends
 *     at a gap, a sign or the end (not at a number or another letter); 井 丼 also stay before a cjk
 *     letter. So no list of digit-shaped letters is load-bearing: ʒ ȝ ɜ ƻ ɡ З … after `#` fold
 *     because they are not plain. A weak sign whose next non-gap is a number becomes `№`.
 *  4. The text is NFKC-normalized (the fold mark `№` kept as is) and NFC-composed.
 *  5. On that normalized text, the letters of "reply yes or no", in order, with only gaps between
 *     ANY two of them, become "say yes or no" (no word boundary is required: "reply yes or
 *     nothing" reads "say yes or nothing"). Letters are compared on a skeleton: NFKD, marks
 *     dropped, the Unicode confusables of r e p l y s o n folded (`confusables.ts`, plus hand
 *     entries); a letter whose skeleton is still not ASCII (ɹ ǝ ŋ ɐ …) is a wildcard, at most 3 per
 *     match, so unlisted look-alikes fold while other scripts never match. A non-letter that is
 *     such a confusable (`|`, `¥`), and the fold mark `№` (it reads "No": "Reply yes or #" →
 *     "say yes or no"), is tried both as that letter and as a gap.
 *  6. Steps 1–5 repeat until the text no longer changes (normally one round), so the function is
 *     idempotent.
 *
 * The ref fold (3) is the main guarantee: a forged prompt names no `#<ref>`, and the resolver
 * acts only on a real pending approval, booking its stored payload; the tail fold (5) is a
 * second layer. What remains, documented in docs/ARCHITECTURE.md 8.2: a weak symbol (outside the
 * strong list) followed by a digit-shaped LETTER is not folded, and a tail with four or more
 * look-alike letters outside the data is not folded (the ref fold still holds).
 *
 * What the owner sees for ordinary text: "#1 priority" → "№1 priority", "#love" / "#lol" →
 * "№love" / "№lol" (l o read as 1 0), "#a7" → "№a7", "#straße" → "№straße", "#東京" → "№東京",
 * "C#" at the very end → "C№", "C♯7" → "C№7", "⊕ 5" → "№ 5", "reply yes or no to Sam" → "say yes
 * or no to Sam"; "#friends", "#café", "#iPhone", "C# is", "井戸", "★ 5 stars", "≤ 5" and all other
 * text are unchanged apart from NFKC and removed invisible characters.
 */
import { quote, sanitize } from '../core/sanitize.js';
import { DIGIT_LIKE_LETTERS, TAIL_CONFUSABLES } from './confusables.js';

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_BEFORE = /\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?$/u;
const EMOJI_BEFORE_VS = /\p{Extended_Pictographic}$/u;
const EMOJI_AFTER = /^\p{Extended_Pictographic}/u;
const LETTER = /^\p{L}$/u;
const NUMBER = /\p{N}/u;
const HAS_LETTER = /\p{L}/u;
/** Modifier letters (ʼ ˈ ʰ …) read as punctuation or marks: gaps in the tail stream. */
const MODIFIER_LETTER = /^\p{Lm}$/u;
const SYMBOL = /^\p{S}$/u;
const CURRENCY = /^\p{Sc}$/u;
const MARK = /\p{M}/gu;
const IS_MARK = /^\p{M}$/u;
const PLAIN_SKELETON = /^[A-Za-z]$/u;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
/** Stand-in for a letter whose skeleton is not ASCII, in the tail stream (step 5). */
const WILD = '\u0000';
/** At most this many such letters in one tail match (a quarter of its 12 letters). */
const MAX_WILD = 3;
const FOLD_MARK = '№';
const TAIL = 'replyyesorno';
const TAIL_TEXT = 'say yes or no';

/** Shapes of `#` that NFKC does not fold to it (the confusables data lists none). */
const STRONG_SIGNS = new Set([...'♯⌗⋕⧣⩩▦▩╪╫╬井丼\u{1D130}\u{1D131}\u{1D132}']);
/** Strong signs that are CJK letters themselves: they stay before a CJK letter (井戸, 牛丼です). */
const LETTER_SIGNS = new Set([...'井丼']);
/** Symbols common in ordinary text that are not `#`-shaped (weak-sign exceptions). */
const COMMON_SYMBOLS = new Set([...'−∓≤≥≈≠≡∞√∑∏∆∙∘∗∼≪≫⁄']);
/** Letters confusable with a digit (confusables data, plus 丨): decides only whether a plain word starts like a number. */
const DIGIT_LIKE = new Set([...DIGIT_LIKE_LETTERS, '丨']);

/** Hand look-alikes of the tail letters, beyond the confusables data. */
const EXTRA_TAIL: Record<string, string> = {
  'г': 'r', 'ʀ': 'r', 'ᴦ': 'r', 'ꭇ': 'r', 'ꭈ': 'r', 'ꮁ': 'r', 'ɼ': 'r', 'ɽ': 'r', 'ɾ': 'r',
  'е': 'e', 'ε': 'e', 'ҽ': 'e', 'ᴇ': 'e', 'ɛ': 'e', 'є': 'e', 'ꬲ': 'e', 'ɘ': 'e', 'ё': 'e',
  'р': 'p', 'ρ': 'p', 'ϱ': 'p', 'ᴘ': 'p', 'ҏ': 'p', 'Ρ': 'p',
  'ӏ': 'l', 'Ӏ': 'l', 'ǀ': 'l', 'ɩ': 'l', 'ʟ': 'l', 'ꓲ': 'l', 'I': 'l', 'Ι': 'l', 'І': 'l', '1': 'l', '١': 'l', '۱': 'l',
  'у': 'y', 'ү': 'y', 'γ': 'y', 'ʏ': 'y', 'ɣ': 'y', 'ყ': 'y', 'Υ': 'y', 'У': 'y', 'Ү': 'y',
  'ѕ': 's', 'ꜱ': 's', 'ʂ': 's', 'ƽ': 's', 'Ѕ': 's',
  'о': 'o', 'ο': 'o', 'օ': 'o', 'ᴏ': 'o', 'ⲟ': 'o', 'σ': 'o', 'Ο': 'o', 'О': 'o', '0': 'o', '〇': 'o',
  '०': 'o', '০': 'o', '੦': 'o', '૦': 'o', '୦': 'o', '௦': 'o', '౦': 'o', '೦': 'o', '൦': 'o', '๐': 'o', '໐': 'o', '၀': 'o', '٥': 'o',
  'ɹ': 'r', 'ꞃ': 'r', 'Ꞃ': 'r', 'ꝛ': 'r', 'Ꝛ': 'r', 'ȿ': 's', 'ǝ': 'e', 'Ǝ': 'e', 'ŋ': 'n', 'Ŋ': 'n', 'ɲ': 'n',
  'п': 'n', 'ո': 'n', 'ռ': 'n', 'ɴ': 'n', 'η': 'n', 'Ν': 'n', 'Π': 'n', 'Ꮑ': 'n',
};
const TAIL_MAP = new Map<string, string>();
for (const [letter, all] of Object.entries(TAIL_CONFUSABLES)) for (const c of all) TAIL_MAP.set(c, letter);
for (const [c, letter] of Object.entries(EXTRA_TAIL)) TAIL_MAP.set(c, letter);
// Step 5 sees NFKC text, so a stand-in's NFKC form stands in too (￨ → │ reads as l).
for (const [c, letter] of [...TAIL_MAP]) {
  const k = c.normalize('NFKC');
  if ([...k].length === 1 && !TAIL_MAP.has(k) && !/^[a-z]$/iu.test(k)) TAIL_MAP.set(k, letter);
}

/**
 * - plain: a letter (not Lm) whose NFKD form without marks is ONE ASCII letter (é, Ｂ, ſ);
 *   `digitLike` marks the plain letters that read as a digit (I O l o, confusables data);
 * - cjk: a Han / Hiragana / Katakana letter that is not digit-like (only matters after 井 丼);
 * - letter: any other letter (not Lm): IPA, Cyrillic, Greek, ʒ ȝ ɜ ƻ ɡ … — never a hashtag word;
 * - mark: \p{M}, transparent inside a word, a gap otherwise.
 */
type Kind = 'plain' | 'cjk' | 'letter' | 'number' | 'strong' | 'weak' | 'mark' | 'gap';

function isWeakSign(cp: string): boolean {
  if (!SYMBOL.test(cp) || CURRENCY.test(cp) || EMOJI.test(cp) || COMMON_SYMBOLS.has(cp)) return false;
  const c = cp.codePointAt(0)!;
  const ordinary =
    c <= 0xff || (c >= 0x2190 && c <= 0x21ff) || (c >= 0x25a0 && c <= 0x25ff) || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2800 && c <= 0x28ff) || (c >= 0x2b00 && c <= 0x2bff) || (c >= 0x1d100 && c <= 0x1d1ff);
  return !ordinary;
}

function kindOf(cp: string): Kind {
  if (cp === FOLD_MARK) return 'gap';
  const k = cp.normalize('NFKC');
  if (k.includes('#') || STRONG_SIGNS.has(cp)) return 'strong';
  if (isWeakSign(cp) && !HAS_LETTER.test(k)) return 'weak';
  if (NUMBER.test(cp) || NUMBER.test(k)) return 'number';
  if (IS_MARK.test(cp)) return 'mark';
  // Modifier letters (ʼ ˈ ˍ ꓸ ー …) read as punctuation: gaps, here as in the tail fold.
  if (!LETTER.test(cp) || MODIFIER_LETTER.test(cp)) return 'gap';
  if (PLAIN_SKELETON.test(asciiSkeleton(cp))) return 'plain';
  if (CJK.test(cp) && !DIGIT_LIKE.has(cp)) return 'cjk';
  return 'letter';
}

function asciiSkeleton(cp: string): string {
  return cp.normalize('NFKD').replace(MARK, '');
}

function isDigitLikePlain(cp: string): boolean {
  return DIGIT_LIKE.has(cp) || DIGIT_LIKE.has(asciiSkeleton(cp));
}

/** Step 1: code points with the invisible ones removed. */
function visibleCodePoints(text: string): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += 1) {
    const ch = cps[i]!;
    if (!INVISIBLE.test(ch)) {
      out.push(ch);
      continue;
    }
    const before = out.slice(-2).join('');
    if (ch === '\u200D' && EMOJI_BEFORE.test(before) && EMOJI_AFTER.test(cps[i + 1] ?? '')) out.push(ch);
    else if ((ch === '\uFE0F' || ch === '\uFE0E') && EMOJI_BEFORE_VS.test(before)) out.push(ch);
  }
  return out;
}

/**
 * Step 3, right to left, linear. A strong sign is kept only when its next non-gap (signs and
 * marks skipped) begins a WORD: a run of at least two plain letters (marks inside it allowed),
 * whose first two letters are not both digit-like, that ends at a gap, a sign or the end of the
 * text (not at a number or another kind of letter). Everything else folds — fail closed, so no
 * list of digit-shaped letters is load-bearing: "#ʒ7", "#ƻ7", "#Зl", "#a7", "#lo", "#東京" fold;
 * "#bring", "#friends", "C# is" stay. 井 and 丼 (letters themselves) also stay before a cjk
 * letter ("井戸", "牛丼です"). A weak sign folds only when its next non-gap (weak signs count) is
 * a number.
 */
function foldRefs(cps: string[], kinds: Kind[], out: string[]): void {
  const n = kinds.length;
  const runLen = new Array<number>(n).fill(0);
  const second = new Array<number>(n).fill(-1);
  const term = new Array<Kind | 'end'>(n).fill('end');
  let nextNonMark = n; // next index > i that is not a mark
  let next = -1; // next index > i that is a letter or a number
  let nextRaw: Kind | 'end' = 'end';
  for (let i = n - 1; i >= 0; i -= 1) {
    const k = kinds[i]!;
    if (k === 'strong') {
      const j = next;
      let keep = false;
      if (j !== -1 && kinds[j] === 'plain') {
        const t = term[j]!;
        keep = runLen[j]! >= 2 && !(isDigitLikePlain(cps[j]!) && isDigitLikePlain(cps[second[j]!]!)) && (t === 'gap' || t === 'strong' || t === 'weak' || t === 'end');
      }
      if (j !== -1 && kinds[j] === 'cjk' && LETTER_SIGNS.has(cps[i]!)) keep = true;
      if (!keep) out[i] = FOLD_MARK;
    }
    if (k === 'weak' && nextRaw === 'number') out[i] = FOLD_MARK;
    if (k === 'plain') {
      const after = nextNonMark < n ? kinds[nextNonMark]! : 'end';
      if (after === 'plain') {
        runLen[i] = 1 + runLen[nextNonMark]!;
        second[i] = nextNonMark;
        term[i] = term[nextNonMark]!;
      } else {
        runLen[i] = 1;
        term[i] = after;
      }
    }
    if (k === 'plain' || k === 'cjk' || k === 'letter' || k === 'number') next = i;
    if (k === 'plain' || k === 'cjk' || k === 'letter' || k === 'number' || k === 'weak') nextRaw = k;
    if (k !== 'mark') nextNonMark = i;
  }
}

/** Skeleton letters of one code point (step 5). */
function skeleton(cp: string): string {
  const direct = TAIL_MAP.get(cp);
  if (direct) return direct;
  let out = '';
  for (const c of cp.normalize('NFKD').replace(MARK, '')) out += TAIL_MAP.get(c) ?? TAIL_MAP.get(c.toLowerCase()) ?? c.toLowerCase();
  return out;
}

/**
 * Step 5 over the stream of letters and numbers (and, with `symbolsAsLetters`, of non-letters
 * that are confusables of a tail letter, and the fold mark `№`, which reads "No"); everything
 * else is a gap and not in the stream. A letter whose skeleton is not ASCII (ɹ, ǝ, ŋ, a Cyrillic
 * letter the data does not list) is a wildcard: it matches any tail letter, at most MAX_WILD of
 * them per match, so "Rǝply yes oɹ no" folds without a list of every look-alike, while text in
 * another script never matches (it needs nine exact Latin letters of the phrase, in order).
 */
function foldTails(cps: string[], symbolsAsLetters: boolean): string[] {
  const out = [...cps];
  let stream = '';
  const owner: number[] = [];
  cps.forEach((cp, i) => {
    const isLetter = LETTER.test(cp) && !MODIFIER_LETTER.test(cp);
    const letterOrNumber = isLetter || NUMBER.test(cp);
    if (!letterOrNumber && !(symbolsAsLetters && (TAIL_MAP.has(cp) || cp === FOLD_MARK))) return;
    const skel = skeleton(cp);
    for (const c of isLetter && !/^[a-z0-9]+$/u.test(skel) ? WILD : skel) {
      stream += c;
      owner.push(i);
    }
  });
  for (let at = 0; at + TAIL.length <= stream.length; ) {
    let wild = 0;
    let k = 0;
    for (; k < TAIL.length; k += 1) {
      const c = stream[at + k]!;
      if (c === WILD) wild += 1;
      else if (c !== TAIL[k]) break;
    }
    if (k < TAIL.length || wild > MAX_WILD) {
      at += 1;
      continue;
    }
    const first = owner[at]!;
    const last = owner[at + TAIL.length - 1]!;
    out[first] = TAIL_TEXT;
    for (let i = first + 1; i <= last; i += 1) out[i] = '';
    at += TAIL.length;
  }
  return out;
}

/** One round of steps 1–5. */
function neutralizeOnce(text: string): string {
  const cps = visibleCodePoints(text);
  const out = cps.map((cp) => (cp === FOLD_MARK ? cp : cp.normalize('NFKC')));
  foldRefs(cps, cps.map(kindOf), out);
  const shown = [...out.join('').normalize('NFC')];
  const once = foldTails(shown, false).join('');
  return foldTails([...once], true).join('').normalize('NFC');
}

export function neutralizeReply(text: string): string {
  let cur = text;
  for (let round = 0; round < 8; round += 1) {
    const next = neutralizeOnce(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Third-party text quoted to an owner (I13): folded, cut to `max`, folded again (a sign the cut
 * left at the end, "Lunch #…", folds too; folding never lengthens NFKC text, so quote() does
 * not cut a second time), then sanitized and quoted with curly quotes it cannot close.
 */
export function quoteFolded(text: string, max: number): string {
  return quote(neutralizeReply(sanitize(neutralizeReply(text), max)), max);
}
