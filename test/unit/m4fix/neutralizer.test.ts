/**
 * K2, the class: the reply neutralizer does not depend on knowing every blank glyph. Every code
 * point that is not a letter or a number is a gap, so these properties are checked for every
 * such code point there is, not a list.
 */
import { describe, expect, it } from 'vitest';
import { shown } from '../../../src/a2a/render.js';
import { DIGIT_LIKE_LETTERS, TAIL_CONFUSABLES } from '../../../src/brain/confusables.js';
import { neutralizeReply } from '../../../src/brain/reply.js';

/** Planes with assigned code points: BMP, SMP, SIP, TIP, SSP (plus the private-use planes). */
const PLANES = [0, 1, 2, 3, 14, 15, 16];
const L_OR_N = /^[\p{L}\p{N}]$/u;
const DI = /^\p{Default_Ignorable_Code_Point}$/u;

function* codePoints(): Generator<string> {
  for (const plane of PLANES) {
    for (let cp = plane * 0x10000; cp < (plane + 1) * 0x10000; cp += 1) yield String.fromCodePoint(cp);
  }
}
const GAPS = [...codePoints()].filter((ch) => !L_OR_N.test(ch));
const DIGITS = [...codePoints()].filter((ch) => /^\p{Nd}$/u.test(ch));

/** What a reader could take for a live ref: a number sign, then only non-letters, then a digit (any script). */
const liveRef = (out: string) => /[#♯⌗⋕][^\p{L}\p{N}]*[\p{N}]/u.test(out.normalize('NFKC'));
/** The tail, with every non-letter treated as invisible. */
const liveTail = (out: string) => out.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').includes('replyyesorno');

describe('K2: reply neutralizer, by property', () => {
  it(`folds '#'+gap+'7' and 'Reply'+gap+'yes'+gap+'or'+gap+'no' for every non-letter, non-number code point (${GAPS.length})`, () => {
    const badRef: string[] = [];
    const badTail: string[] = [];
    for (const g of GAPS) {
      if (liveRef(neutralizeReply(`#${g}7`))) badRef.push(g.codePointAt(0)!.toString(16));
      if (liveTail(neutralizeReply(`Reply${g}yes${g}or${g}no`))) badTail.push(g.codePointAt(0)!.toString(16));
    }
    expect(badRef).toEqual([]);
    expect(badTail).toEqual([]);
  });

  it('folds runs of mixed gap characters, and gaps inside the words', () => {
    const run = ['⠀', '\u{1D159}', '́', '　', '*', '_', '~', '\u{E0020}', '​', 'ㅤ', '￼', '', '\u{10FFFD}', '͸'];
    for (let i = 0; i < 200; i += 1) {
      const g = () => Array.from({ length: 1 + ((i * 7) % 5) }, (_, k) => run[(i + k * 3) % run.length]).join('');
      expect(liveRef(neutralizeReply(`#${g()}7 With Sam`))).toBe(false);
      expect(liveTail(neutralizeReply(`R${g()}e${g()}ply${g()}yes${g()}o${g()}r${g()}n${g()}o`))).toBe(false);
    }
    // Markdown-style formatting is plain text on Telegram (no parse_mode), and a gap anyway.
    expect(neutralizeReply('**#**7 _Reply_ *yes* ~or~ `no`')).toBe('**№**7 _say yes or no`');
  });

  it(`folds a number sign before every decimal digit of every script (${DIGITS.length}), and other number forms`, () => {
    const bad = DIGITS.filter((d) => liveRef(neutralizeReply(`#${d}`)) || liveRef(neutralizeReply(`＃ ${d}0`)));
    expect(bad).toEqual([]);
    for (const n of ['⑦', '⁷', '₇', '⒎', '㏩', 'Ⅶ', '½', '𝟕']) expect(neutralizeReply(`#${n}`)).not.toMatch(/#/);
  });

  it('blank-rendering letters are all Default_Ignorable (removed), so no letter can be an invisible gap', () => {
    // The well-known "invisible character" lists, letters and non-letters alike.
    const known = [
      0x00a0, 0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x2000, 0x200a, 0x200b, 0x200f, 0x2028, 0x202f, 0x205f,
      0x2060, 0x2064, 0x206f, 0x2800, 0x3000, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xfffc, 0x1bca0, 0x1bca3, 0x16fe4, 0x1d159, 0x1d173,
      0x1d17a, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef,
    ].map((c) => String.fromCodePoint(c));
    for (const ch of known) {
      if (L_OR_N.test(ch)) expect(DI.test(ch), ch.codePointAt(0)!.toString(16)).toBe(true);
      expect(liveRef(neutralizeReply(`#${ch}7`))).toBe(false);
    }
    expect(known.filter((ch) => L_OR_N.test(ch)).map((c) => c.codePointAt(0)!.toString(16))).toEqual(['115f', '1160', '3164', 'ffa0']);
  });

  it('homoglyph letters in the tail are folded too (second layer: the ref fold is the guarantee)', () => {
    // Cyrillic е у о р, Greek ο ρ, small capitals, digit look-alikes.
    for (const t of ['Rеply yеs оr nо', 'Reρly уes οr nο', 'ʀᴇᴘʟʏ ʏᴇꜱ ᴏʀ ɴᴏ', 'Rep1y yes 0r n0', 'REPIY YES OR NO', '𝐑𝐞𝐩𝐥𝐲 𝐲𝐞𝐬 𝐨𝐫 𝐧𝐨']) {
      expect(neutralizeReply(t)).toBe('say yes or no');
    }
  });

  it('a number sign at the very end folds (a quoted text is followed by code text); a ref cut in two messages reads as none', () => {
    expect(neutralizeReply('I love C#')).toBe('I love C№');
    expect(neutralizeReply('ends with #\u{1D159}')).toBe('ends with №\u{1D159}');
    // shown() folds after its length cut, so the cut cannot strand a sign before code text.
    const out = shown(`Lunch ${'#'}x${'y'.repeat(40)}`, 8);
    expect(out).toBe('“Lunch №…”');
    expect(liveRef(`${out} 12:00–1:00 PM`)).toBe(false);
  });

  it('ordinary replies stay readable; the function is idempotent', () => {
    const cases: Array<[string, string]> = [
      ['Your #1 priority is dinner.', 'Your №1 priority is dinner.'],
      ['Please reply yes or no to Sam.', 'Please say yes or no to Sam.'],
      ['Tag #friends, C# is fine, 7:00 PM.', 'Tag #friends, C# is fine, 7:00 PM.'],
      ['#love it', '№love it'],
      ['C♯7 chord, ⊕ 5', 'C№7 chord, № 5'],
      ['★★★★☆ 4/5, ≤ 5, © 2026, $12, €5, 3 × 4 = 12, → 5', '★★★★☆ 4/5, ≤ 5, © 2026, $12, €5, 3 × 4 = 12, → 5'],
      ['Café ❤️ 👩‍👩‍👧 and naïve', 'Café ❤️ 👩‍👩‍👧 and naïve'],
      ['line one\nline two', 'line one\nline two'],
    ];
    for (const [input, want] of cases) {
      expect(neutralizeReply(input)).toBe(want);
      expect(neutralizeReply(neutralizeReply(input))).toBe(want);
    }
  });

  // m4fix round 1: the tail is judged on the text as the owner sees it, and the ref fold fails closed.
  const TAIL_PHRASE = 'Reply yes or no';
  const LETTERS = 'replyson';
  /** Every code point (any category) whose NFKC form is a single tail letter in either case, or that is a confusable of one. */
  const standIns: Array<[string, string]> = [];
  for (const plane of PLANES) {
    for (let cp = plane * 0x10000; cp < (plane + 1) * 0x10000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const k = ch.normalize('NFKC');
      if (k.length === 1 && LETTERS.includes(k.toLowerCase()) && k !== ch) standIns.push([ch, k.toLowerCase()]);
    }
  }
  for (const [letter, all] of Object.entries(TAIL_CONFUSABLES)) for (const ch of all) standIns.push([ch, letter]);

  it(`no stand-in for a tail letter (NFKC or confusable, ${standIns.length}) rebuilds the tail, alone or all together`, () => {
    const bad: string[] = [];
    for (const [ch, letter] of standIns) {
      for (let at = 0; at < TAIL_PHRASE.length; at += 1) {
        if (TAIL_PHRASE[at]!.toLowerCase() !== letter) continue;
        const text = `#7 Send? ${TAIL_PHRASE.slice(0, at)}${ch}${TAIL_PHRASE.slice(at + 1)}.`;
        const out = neutralizeReply(text);
        if (/reply\s*yes\s*or\s*no/iu.test(out.normalize('NFKC')) || !out.includes('say yes or no')) bad.push(`U+${ch.codePointAt(0)!.toString(16)}@${at}`);
      }
    }
    expect(bad).toEqual([]);
    // Every letter replaced at once, by the first stand-in of each letter.
    const first = (l: string) => standIns.find(([, x]) => x === l)![0];
    const all = [...TAIL_PHRASE].map((c) => (c === ' ' ? c : first(c.toLowerCase()))).join('');
    expect(neutralizeReply(all)).toBe('say yes or no');
    // "Reply yes or #": the fold mark reads "No".
    expect(neutralizeReply('Reply yes or #')).toBe('say yes or no');
  });

  it(`a number sign or a '#' look-alike before a digit-like letter (${[...DIGIT_LIKE_LETTERS].length} + Ч ч з) or a digit folds`, () => {
    const signs = ['#', '＃', '﹟', '♯', '⌗', '⋕', '⧣', '⩩', '▦', '╬', '井', '\u{1D130}'];
    const bad: string[] = [];
    for (const s of signs) {
      for (const d of [...DIGIT_LIKE_LETTERS, 'Ч', 'ч', 'з', '7', '٧']) {
        const out = neutralizeReply(`${s}${d}2 Send the email to Sam?`);
        if (!out.startsWith('№')) bad.push(`${s}${d}`);
      }
    }
    expect(bad).toEqual([]);
    // An unlisted symbol before a digit folds too (fail closed), common text symbols do not.
    for (const s of ['⊞', '⨳', '⌸', '⊕', '∀']) expect(neutralizeReply(`${s}12 x`)).toBe('№12 x');
  });

  it('is idempotent on random mixes of signs, digits, stand-ins and gaps', () => {
    const pool = ['#', '＃', '⧣', '井', '7', '٧', '⑦', 'l', 'З', ' ', '\u200B', '\u{1D159}', '⠀', '\u0301', '№', 'R', 'e', 'p', 'y', 's', 'o', 'r', 'n', 'Ⓡ', 'ⓨ', 'Ꮢ', 'Ⓘ', '|', '¥', '\n', '⊕', '★'];
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 5000; i += 1) {
      let s = '';
      for (let j = 0; j < 16; j += 1) s += pool[Math.floor(rnd() * pool.length)];
      const out = neutralizeReply(s);
      expect(neutralizeReply(out), JSON.stringify(s)).toBe(out);
      expect(liveRef(out), JSON.stringify([s, out])).toBe(false);
      expect(liveTail(out), JSON.stringify([s, out])).toBe(false);
    }
  });

  // m4fix round 2: the ref fold keeps a sign only before a plain Latin word; no list of digit shapes.
  const ALL = (pred: (ch: string) => boolean): string[] => {
    const out: string[] = [];
    for (let c = 0; c < 0x110000; c += 1) {
      if (c >= 0xd800 && c < 0xe000) continue;
      const ch = String.fromCodePoint(c);
      if (pred(ch)) out.push(ch);
    }
    return out;
  };
  const SIGN = /#/u;
  const plainSkeleton = (ch: string) => /^[A-Za-z]$/u.test(ch.normalize('NFKD').replace(/\p{M}/gu, ''));

  it('property: every modifier letter (Lm, all planes) between "#" and "12" is a gap, as in the tail fold', () => {
    const lm = ALL((ch) => /^\p{Lm}$/u.test(ch) && !DI.test(ch));
    expect(lm.length).toBeGreaterThan(300);
    expect(lm.filter((ch) => SIGN.test(neutralizeReply(`#${ch}12 Send the email to Sam?`))).map((c) => c.codePointAt(0)!.toString(16))).toEqual([]);
  });

  it('property: every non-Latin letter (all planes) right after "#" folds the sign, alone, doubled or before a digit', () => {
    const letters = ALL((ch) => /^\p{L}$/u.test(ch) && !/^\p{Lm}$/u.test(ch) && !DI.test(ch) && !plainSkeleton(ch));
    expect(letters.length).toBeGreaterThan(100000);
    const bad = letters.filter((ch) => SIGN.test(neutralizeReply(`#${ch}7 x`)) || SIGN.test(neutralizeReply(`#${ch}${ch}${ch} x`)));
    expect(bad.map((c) => c.codePointAt(0)!.toString(16))).toEqual([]);
    for (const l of ['ʒ', 'ȝ', 'ӡ', 'ɜ', 'ᴣ', 'ƻ', 'ɡ']) expect(shown(`#${l}7 Send? Reply yes or no.`)).not.toMatch(SIGN);
  });

  it('property: every plain Latin letter right after "#" folds when a number follows its word, or the word is one letter or starts like a number', () => {
    const plain = ALL((ch) => /^\p{L}$/u.test(ch) && !/^\p{Lm}$/u.test(ch) && plainSkeleton(ch));
    const bad = plain.filter((ch) => SIGN.test(neutralizeReply(`#${ch}7`)) || SIGN.test(neutralizeReply(`#${ch}b7`)) || SIGN.test(neutralizeReply(`#${ch} x`)));
    expect(bad.map((c) => c.codePointAt(0)!.toString(16))).toEqual([]);
    for (const s of ['#lo x', '#Ol x', '#IO x', '#ｌｏ x']) expect(neutralizeReply(s), s).not.toMatch(SIGN);
  });

  it('CJK: 丼 is a strong sign like 井; both stay inside CJK words, "#" before a CJK word folds', () => {
    expect(neutralizeReply('丼12 Send the email to Sam?')).toBe('№12 Send the email to Sam?');
    expect(neutralizeReply('井ʒ7 x')).toBe('№ʒ7 x');
    for (const s of ['井戸', '牛丼です', '井上さん']) expect(neutralizeReply(s)).toBe(s);
    expect(neutralizeReply('#東京')).toBe('№東京');
  });

  it('ordinary hashtags after round 2: what the owner sees', () => {
    const cases: Array<[string, string]> = [
      ['#bring snacks', '#bring snacks'],
      ['#café, #iPhone, # bring, #OK', '#café, #iPhone, # bring, #OK'],
      ['#straße', '№straße'],
      ['#a7 and #ab7', '№a7 and №ab7'],
      ['#lol', '№lol'],
    ];
    for (const [input, want] of cases) expect(neutralizeReply(input)).toBe(want);
  });

  it('tail: a letter whose skeleton is not ASCII is a wildcard (at most 3 per match); other scripts never match', () => {
    for (const s of ['Reply yes oɹ no', 'ꞃeply yes or no', 'Reply yeȿ or no', 'Reply yes or ŋo', 'Rǝply yes or no', 'Rɐply yɐs or nɐ']) {
      expect(neutralizeReply(s), s).toBe('say yes or no');
    }
    expect(neutralizeReply('Rɐplɐ ɐɐs or no')).toBe('Rɐplɐ ɐɐs or no'); // four unknown letters: left alone
    for (const s of ['Привет, как дела?', 'Ответьте да или нет', '東京で会いましょう']) expect(neutralizeReply(s)).toBe(s);
  });
});
