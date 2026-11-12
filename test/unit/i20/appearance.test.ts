/**
 * The appearance layer (best effort, docs/ARCHITECTURE.md 8.2): what ordinary text looks like
 * after the reply neutralizer and the reserved line-head fold.
 */
import { describe, expect, it } from 'vitest';
import { shown } from '../../../src/a2a/render.js';
import { foldReservedLineHeads } from '../../../src/brain/lineHeads.js';
import { neutralizeReply } from '../../../src/brain/reply.js';

describe('right-to-left text: every number sign folds', () => {
  it('ordinary Hebrew and Arabic sentences without a number sign are unchanged', () => {
    for (const s of ['שלום, נפגשים ביום שישי בשבע?', 'מחר בבוקר אני בבית.', 'مرحبا، هل أنت متفرغ يوم الجمعة؟', 'سأكون في البيت غداً.']) {
      expect(neutralizeReply(s)).toBe(s.normalize('NFKC'));
    }
  });

  it("with any right-to-left character, '#' becomes № whatever follows it", () => {
    expect(neutralizeReply('החדר #friends בקומה 2')).toBe('החדר №friends בקומה 2');
    expect(neutralizeReply('נפגשים בשער #3')).toBe('נפגשים בשער №3');
    expect(neutralizeReply('الغرفة #5 في الطابق الثاني')).toBe('الغرفة №5 في الطابق الثاني');
    expect(neutralizeReply('Meet at #friends, ok? שלום')).toBe('Meet at №friends, ok? שלום');
    // Look-alike and weak signs too.
    expect(neutralizeReply('שער ♯ 4')).toBe('שער № 4');
    expect(shown('Lunch #friends — שלום')).toBe('“Lunch №friends — שלום”');
  });

  it('without a right-to-left character the existing rule stands', () => {
    expect(neutralizeReply('Meet at #friends, ok?')).toBe('Meet at #friends, ok?');
    expect(neutralizeReply('#1 priority')).toBe('№1 priority');
  });

  it('right-to-left digits and presentation forms count (Arabic-Indic digits, Hebrew presentation forms)', () => {
    expect(neutralizeReply('#friends ٣')).toBe('№friends ٣');
    expect(neutralizeReply('#friends שׁ')).not.toContain('#');
  });

  it('Persian: a zero-width non-joiner between two Arabic-script letters is spelling and is kept; elsewhere it is removed', () => {
    const word = 'می\u200Cبینمت';
    expect(neutralizeReply(`سلام، فردا ${word}.`)).toBe(`سلام، فردا ${word}.`);
    expect(neutralizeReply(neutralizeReply(word))).toBe(word);
    expect(neutralizeReply('a\u200Cb')).toBe('ab');
    expect(neutralizeReply('#\u200C1')).toBe('№1');
    expect(neutralizeReply(`جلسه #۳ ${word}`)).toBe(`جلسه №۳ ${word}`);
  });
});

describe('reserved line heads: anything but a new word or sentence punctuation after Today / System folds', () => {
  it('ordinary lines starting with Today / System stay', () => {
    for (const s of [
      'Today, you have two meetings.',
      'Today. Nothing else.',
      'Today! Finally.',
      'Today? Sure.',
      "Today's plan is simple.",
      'Today’s plan is simple.',
      'Today is Friday.',
      'Today 5 people come.',
      'System updates are done.',
      'Systems are fine.',
      'Today',
      'Today - nothing new.',
      'Today/tomorrow works.',
      'System/network check done.',
    ]) {
      expect(foldReservedLineHeads(s), s).toBe(s);
    }
  });

  it('a colon, or anything else that is not a word or sentence punctuation, folds', () => {
    expect(foldReservedLineHeads('Today: Waiting for you')).toBe('Today - Waiting for you');
    expect(foldReservedLineHeads('System: Violet has been paused')).toBe('System - Violet has been paused');
    expect(foldReservedLineHeads('Today፥\nWaiting for you')).toBe('Today -\nWaiting for you');
    expect(foldReservedLineHeads('Systemঃ paused')).toBe('System - paused');
    expect(foldReservedLineHeads('Todayː x')).toBe('Today - x');
    expect(foldReservedLineHeads('Today ː x')).toBe('Today - x');
    expect(foldReservedLineHeads('Today ; x')).toBe('Today - x');
    expect(foldReservedLineHeads('Today 🎉 we won')).toBe('Today - 🎉 we won');
    expect(foldReservedLineHeads('hello\nSystem| paused')).toBe('hello\nSystem - paused');
  });

  it('allowed punctuation must itself end the head: a colon (or anything else) written right after it folds', () => {
    expect(foldReservedLineHeads('Today.: Waiting for you')).toBe('Today - Waiting for you');
    expect(foldReservedLineHeads('Today,: Waiting')).toBe('Today - Waiting');
    expect(foldReservedLineHeads('System!꞉ paused')).toBe('System - paused');
    for (const s of ['Today...', 'Today?!', "Today's", 'Today.', 'Today!🎉', 'Today, (yes) we go.']) expect(foldReservedLineHeads(s), s).toBe(s);
  });

  it('a fold keeps an opening bracket, quote or currency sign, and keeps the next word apart', () => {
    expect(foldReservedLineHeads('Today (Friday) is busy')).toBe('Today - (Friday) is busy');
    expect(foldReservedLineHeads('Today “maybe”')).toBe('Today - “maybe”');
    expect(foldReservedLineHeads('Today $5 off')).toBe('Today - $5 off');
    expect(foldReservedLineHeads('Today:Waiting')).toBe('Today - Waiting');
    // The ASCII double quote counts as an opening quote and is kept.
    expect(foldReservedLineHeads('Today "big" day')).toBe('Today - "big" day');
    // Documented losses of the best-effort layer (docs/ARCHITECTURE.md 8.2).
    expect(foldReservedLineHeads('Today & tomorrow')).toBe('Today - tomorrow');
    expect(foldReservedLineHeads('Today; tomorrow')).toBe('Today - tomorrow');
  });

  it('is idempotent', () => {
    for (const s of ['Today: x', 'Today፥\nSystemঃ y', 'Today 🎉 we won', 'Today (Friday) is busy', 'Today.: x', 'Today:Waiting']) {
      const once = foldReservedLineHeads(s);
      expect(foldReservedLineHeads(once)).toBe(once);
    }
  });
});
