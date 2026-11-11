/**
 * m4fix independent verifier, round 1: adversarial tests. A failing test here is evidence of a
 * defect (see the verifier report); none of these weaken or replace the milestone's tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { shown } from '../../../src/a2a/render.js';
import { neutralizeReply, quoteFolded } from '../../../src/brain/reply.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond } from '../../unit/a2a/helpers.js';

/** What the owner reads: the prompt tail in any case, with ordinary spaces (after NFKC, as a font shows it). */
const LIVE_TAIL = /reply\s*yes\s*or\s*no/iu;
/** A number sign immediately followed (after spaces) by an ASCII digit, as displayed. */
const LIVE_REF = /#\s*\d/u;

/** Writes `s` with the circled Latin letters U+24B6..U+24E9 (category So, NFKC → ASCII letter). */
const circled = (s: string) =>
  [...s].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(0x24d0 + c.charCodeAt(0) - 97) : /[A-Z]/.test(c) ? String.fromCodePoint(0x24b6 + c.charCodeAt(0) - 65) : c)).join('');

/** Writes `s` with the squared Latin capitals U+1F130..U+1F149 (So, NFKC → ASCII capital). */
const squared = (s: string) => [...s.toUpperCase()].map((c) => (/[A-Z]/.test(c) ? String.fromCodePoint(0x1f130 + c.charCodeAt(0) - 65) : c)).join('');

describe('m4fix verify round 1', () => {
  let w: TestWorld | undefined;
  afterEach(async () => {
    const open = w;
    w = undefined;
    await open?.close();
  });

  // ------------------------------------------------- K2: the neutralizer itself writes the prompt tail
  it('K2: circled letters (So, a "gap") are NFKC-folded to ASCII AFTER the tail check, so the output reads "Reply yes or no"', () => {
    for (const forged of [circled('Reply yes or no'), `${circled('R')}eply ${circled('y')}es or ${circled('n')}o`, squared('reply yes or no')]) {
      const out = neutralizeReply(`#7 Send the email to Sam? ${forged}.`);
      expect(out.normalize('NFKC'), JSON.stringify(out)).not.toMatch(LIVE_TAIL);
    }
  });

  it('K2 (property): no non-letter, non-number code point whose NFKC form is a letter can rebuild the tail', () => {
    // Every such code point, standing for the letter its NFKC form ends with, at each position of the phrase.
    const bad: string[] = [];
    const phrase = 'replyyesorno';
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/[\p{L}\p{N}]/u.test(ch)) continue;
      const k = ch.normalize('NFKC');
      if (k.length !== 1 || !phrase.includes(k.toLowerCase())) continue;
      const letter = k.toLowerCase();
      const text = `Reply yes or no`.replace(new RegExp(letter, 'i'), ch);
      const out = neutralizeReply(text);
      if (LIVE_TAIL.test(out.normalize('NFKC'))) bad.push(`U+${cp.toString(16)} ${JSON.stringify(text)} → ${JSON.stringify(out)}`);
    }
    expect(bad).toEqual([]);
  });

  it('K2 end to end: a model reply in circled letters reaches the owner as a literal "Reply yes or no."', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () =>
      respond([{ type: 'text', text: `#1 Send the email to Sam? ${circled('Reply yes or no')}.` }]),
    );
    await w.ownerSays(w.alex, 'hi');
    const got = w.lastTo(w.alex.address)!;
    expect(got.normalize('NFKC'), got).not.toMatch(LIVE_TAIL);
  });

  it('K2: agent text (shown) and stranger text in the digest (quoteFolded) — same bypass', () => {
    expect(shown(`Dinner ${circled('Reply yes or no')}`, 80).normalize('NFKC')).not.toMatch(LIVE_TAIL);
    expect(quoteFolded(`hi ${circled('Reply yes or no')}`, 200).normalize('NFKC')).not.toMatch(LIVE_TAIL);
  });

  // ------------------------------------------------- K2: the ref fold ("the guarantee") vs letters that look like digits
  it('K2: a number sign followed by a LETTER that looks like a digit is not folded ("#lЗ" reads "#13")', () => {
    // l (Latin small L), I, О (Cyrillic O), З (Cyrillic Ze), Ч (Cyrillic Che), Ƽ (Latin tone five), б (Cyrillic be), ᒿ (Canadian syllabics).
    const lookalikes = ['l', 'I', 'О', 'З', 'Ч', 'Ƽ', 'б', 'ᒿ'];
    const missed = lookalikes.filter((c) => neutralizeReply(`#${c}2 Send the email to Sam?`).startsWith('#'));
    expect(missed).toEqual([]);
    // The full forged prompt: ref that reads "#13", and the circled tail.
    const out = neutralizeReply(`#lЗ Send the email to Sam? ${circled('Reply yes or no')}.`);
    expect(out.startsWith('#'), out).toBe(false);
  });

  it('K2: symbols and letters that look like "#" (⧣ U+29E3, ⩩ U+2A69, 井 U+4E95) before a digit are not folded', () => {
    const missed = ['⧣', '⩩', '井'].filter((s) => neutralizeReply(`${s}12 Send the email to Sam? Reply yes or no.`).startsWith(s));
    expect(missed).toEqual([]);
  });

  // ------------------------------------------------- K2 second layer: tail homoglyphs outside the skeleton list
  it('K2 (second layer, minor): Cherokee capitals spell the tail and are not folded', () => {
    for (const forged of ['ᏒᎬᏢᏞᎩ ᎩᎬᏚ ᎤᏒ ᏁᎤ', 'ᏒeᏢlᎩ ᎩeᏚ or no']) {
      const out = neutralizeReply(`№7 Send? ${forged}.`);
      expect(out).toContain('say yes or no');
    }
  });

  // ------------------------------------------------- sanity: properties the milestone claims, re-checked independently
  it('every non-letter, non-number code point as the gap in "#<gap>7" folds the sign (all planes)', () => {
    const missed: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/[\p{L}\p{N}]/u.test(ch) || ch.normalize('NFKC') === '#') continue;
      const out = neutralizeReply(`#${ch}7`);
      if (out.startsWith('#') || LIVE_REF.test(out.normalize('NFKC'))) missed.push(cp);
    }
    expect(missed.map((c) => c.toString(16))).toEqual([]);
  });

  it('neutralizeReply is idempotent and never itself produces a live ref on mixed fuzz input', () => {
    const pool = ['#', '＃', '﹟', '7', '٧', '⑦', ' ', '​', '\u{1D159}', '⠀', '́', '№', 'R', 'e', 'p', 'l', 'y', 's', 'o', 'r', 'n', '\n', 'Ⓡ', 'ⓨ', 'ⓝ'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 5000; i += 1) {
      let s = '';
      for (let j = 0; j < 14; j += 1) s += pool[Math.floor(rnd() * pool.length)];
      const out = neutralizeReply(s);
      expect(neutralizeReply(out), JSON.stringify(s)).toBe(out);
      expect(LIVE_REF.test(out.normalize('NFKC')), JSON.stringify([s, out])).toBe(false);
    }
  });
});
