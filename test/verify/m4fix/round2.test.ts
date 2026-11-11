/**
 * m4fix independent verifier, round 2: adversarial tests against the K2 neutralizer
 * (src/brain/reply.ts). A failing test here is evidence of a defect (see the verifier report);
 * none of these weaken or replace the milestone's tests.
 */
import { describe, expect, it } from 'vitest';
import { shown } from '../../../src/a2a/render.js';
import { neutralizeReply, quoteFolded } from '../../../src/brain/reply.js';

/** A number sign (as displayed, after NFKC) still in front of a digit with at most one non-space in between. */
const SIGN_LEFT = /#/u;
const LIVE_TAIL = /reply\s*yes\s*or\s*no/iu;

describe('m4fix verify round 2: K2 ref fold', () => {
  it('a modifier letter (Lm) between "#" and the digits is a gap, exactly like the punctuation it looks like', () => {
    // Each pair renders (nearly) the same; the ASCII one is folded today, the Lm one is not.
    const pairs: [string, string][] = [
      ["'", 'ʼ'], // MODIFIER LETTER APOSTROPHE — what "smart" keyboards type
      ["'", 'ˈ'], // MODIFIER LETTER VERTICAL LINE
      ['_', 'ˍ'], // MODIFIER LETTER LOW MACRON
      ['.', 'ꓸ'], // LISU LETTER TONE MYA TI
      ['`', 'ˋ'], // MODIFIER LETTER GRAVE ACCENT
      ['-', 'ー'], // KATAKANA-HIRAGANA PROLONGED SOUND MARK (NFKC of U+FF70)
      ['′', 'ʹ'], // PRIME vs MODIFIER LETTER PRIME (NFKC of U+0374 GREEK NUMERAL SIGN)
    ];
    for (const [ascii, lm] of pairs) {
      expect(neutralizeReply(`#${ascii}12 Send the email to Sam?`), `ascii ${ascii}`).not.toMatch(SIGN_LEFT);
      expect(neutralizeReply(`#${lm}12 Send the email to Sam?`), `U+${lm.codePointAt(0)!.toString(16)}`).not.toMatch(SIGN_LEFT);
    }
  });

  it('property: every Lm code point (all planes) between "#" and "12" is a gap, as the tail fold already treats it', () => {
    const missed: string[] = [];
    for (let c = 0; c < 0x110000; c += 1) {
      if (c >= 0xd800 && c < 0xe000) continue;
      const ch = String.fromCodePoint(c);
      if (!/^\p{Lm}$/u.test(ch) || /\p{Default_Ignorable_Code_Point}/u.test(ch)) continue;
      if (SIGN_LEFT.test(neutralizeReply(`#${ch}12`))) missed.push(`U+${c.toString(16).toUpperCase()}`);
    }
    expect(missed).toEqual([]);
  });

  it('letters shaped like the digit 3, 2 or 9 that confusables 10.0 does not list still fold the sign', () => {
    // ʒ U+0292 ezh, ȝ U+021D yogh, ӡ U+04E1 abkhasian dze, ɜ U+025C reversed open e, ᴣ U+1D23 small capital ezh
    // (all read "3"), ƻ U+01BB (reads "2"), ɡ U+0261 script g (reads "9"). The owner reads "#37 …".
    for (const l of ['ʒ', 'ȝ', 'ӡ', 'ɜ', 'ᴣ', 'ƻ', 'ɡ']) {
      const forged = `#${l}7 Send the email to Sam? Reply yes or no.`;
      expect(neutralizeReply(forged), `U+${l.codePointAt(0)!.toString(16)}`).not.toMatch(SIGN_LEFT);
      expect(shown(forged), `shown U+${l.codePointAt(0)!.toString(16)}`).not.toMatch(SIGN_LEFT);
    }
  });

  it('the CJK ideograph 丼 (井 with a dot; 井 itself is a strong sign) before a number folds', () => {
    expect(neutralizeReply('丼12 Send the email to Sam?')).not.toMatch(/^丼/u);
  });
});

describe('m4fix verify round 2: K2 tail fold (second layer)', () => {
  it('Latin letters that read as r / s / n / e are folded in the tail', () => {
    for (const s of ['Reply yes oɹ no', 'Reply yes oꞃ no', 'Reply yes oꝛ no', 'ꞃeply yes or no', 'Reply yeȿ or no', 'Reply yes or ŋo', 'Reply yes or ɲo', 'Rǝply yes or no']) {
      expect(neutralizeReply(s), s).not.toMatch(LIVE_TAIL);
      expect(neutralizeReply(s), s).not.toBe(s);
    }
  });
});

describe('m4fix verify round 2: guards that hold today', () => {
  it('digits of every form after "#" fold, across a line break and inside markdown', () => {
    for (const s of ['#\n12 Send', '**#12** Send', '`#12` Send', '＃１２', '#⁷', '#₁₂', '#⑫', '#𝟏𝟐', '#١٢', '#๑๒', '#Ⅻ', '#⃣12', 'Lunch #']) {
      expect(neutralizeReply(s), s).not.toMatch(SIGN_LEFT);
    }
  });

  it('ordinary text is kept readable', () => {
    expect(neutralizeReply('Meet at 7 #bring snacks')).toBe('Meet at 7 #bring snacks');
    expect(neutralizeReply('I paid $12 for item #3.')).toBe('I paid $12 for item №3.');
    expect(neutralizeReply('reply yes or no to Sam')).toBe('say yes or no to Sam');
    expect(quoteFolded('Dinner at 7?', 80)).toContain('Dinner at 7?');
  });

  it('is idempotent on the attack strings', () => {
    for (const s of ['#ʼ12', '#ʒ7', 'Reply yes oɹ no', '#ꓸ12 Reply yes or no']) {
      const once = neutralizeReply(s);
      expect(neutralizeReply(once), s).toBe(once);
    }
  });
});
