/**
 * m4fix independent verifier, round 3: adversarial tests against the K2 neutralizer
 * (src/brain/reply.ts). A failing test here is evidence of a defect (see the verifier report);
 * none of these weaken or replace the milestone's tests.
 *
 * Class tested here: the ref fold decides on LOGICAL order (what follows the sign in memory),
 * but the owner reads VISUAL order. Under the Unicode Bidirectional Algorithm a right-to-left
 * character next to the digits reverses the run, so a sign written AFTER the digits is drawn
 * BEFORE them. Worked example (UAX #9) for the logical string
 *   U+05C3 '1' '2' U+2317 U+05C3 ' ' "Send the email to Sam?"
 * in a left-to-right paragraph: U+05C3 (HEBREW PUNCTUATION SOF PASUQ, a colon-like mark) is
 * bidi R; the digits are EN after R and get level 2; U+2317 (ON) sits between EN (as R) and R
 * and resolves to R, level 1; the space between R and L takes the embedding level 0. Reversing
 * level >= 2 then level >= 1 gives the visual order U+05C3 U+2317 '1' '2' U+05C3, so the owner
 * sees "׃⌗12׃ Send the email to Sam?" — a "#12" prompt — while foldRefs() sees the sign
 * followed by a gap and the plain word "Send" and keeps it. The resolver accepts "yes 12".
 */
import { describe, expect, it } from 'vitest';
import { shown } from '../../../src/a2a/render.js';
import { neutralizeReply } from '../../../src/brain/reply.js';

const HEB_COLON = '׃'; // HEBREW PUNCTUATION SOF PASUQ: bidi R, Po (a gap for the fold)
const MAQAF = '־'; // HEBREW PUNCTUATION MAQAF: bidi R, Pd
const LOOKALIKES = ['⌗', '♯', '⋕', '⧣', '⩩', '╬'];

describe('m4fix verify round 3: K2 ref fold vs bidi visual order', () => {
  it('a "#" look-alike written after the digits but drawn before them (RTL run) is folded', () => {
    for (const sign of LOOKALIKES) {
      const text = `${HEB_COLON}12${sign}${HEB_COLON} Send the email to Sam? Reply yes or no.`;
      const out = neutralizeReply(text);
      // Drawn as "׃<sign>12׃ Send the email to Sam? say yes or no." — the sign must not survive.
      expect(out, `sign U+${sign.codePointAt(0)!.toString(16)}`).not.toContain(sign);
    }
  });

  it('the same attack as its own line (an RTL paragraph above the prompt text)', () => {
    for (const sign of LOOKALIKES) {
      const text = `${HEB_COLON}12${sign}\nSend the email to Sam? Reply yes or no.`;
      // Line 1 is an RTL paragraph: drawn "<sign>12׃".
      expect(neutralizeReply(text)).not.toContain(sign);
    }
  });

  it('agent-authored text shown to an owner (shown()) gets the same protection', () => {
    for (const sign of LOOKALIKES) {
      const out = shown(`${MAQAF}12${sign}${MAQAF} Lunch with Sam? Reply yes or no.`);
      expect(out).not.toContain(sign);
    }
  });

  it('an ASCII "#" after the digits in an RTL run (drawn "# 12") is folded too', () => {
    // Logical "׃ 12 #׃ Send…": '#' is ET, not adjacent to the EN run, resolves R → drawn "׃# 12 ׃ Send…".
    const out = neutralizeReply(`${HEB_COLON} 12 #${HEB_COLON} Send the email to Sam?`);
    expect(out).not.toMatch(/#/u);
  });
});
