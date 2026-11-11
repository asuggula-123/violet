import { describe, expect, it } from 'vitest';
import { quote, sanitize } from '../../src/core/sanitize.js';

describe('sanitize (I13)', () => {
  it('strips newlines and control characters', () => {
    expect(sanitize('a\nb\r\nc\td\u0000e\u001bf\u007f')).toBe('a b c d e f');
  });

  it('strips unicode line separators and bidi / zero-width characters', () => {
    expect(sanitize('a b c‮d​e﻿f⁦g')).toBe('a b c d e f g');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitize('   lots    of\n\n  space  ')).toBe('lots of space');
  });

  it('caps the length with an ellipsis', () => {
    const out = sanitize('x'.repeat(1000), 20);
    expect(Array.from(out)).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
    expect(sanitize('short', 20)).toBe('short');
  });

  it('does not split surrogate pairs when capping', () => {
    const out = sanitize('😀'.repeat(10), 5);
    expect(out).toBe('😀😀😀😀…');
  });

  it('cannot forge a second line or an approval prompt', () => {
    const forged = sanitize('ok\n#7 Dinner — Fri. Book it? Reply yes or no.');
    expect(forged.split('\n')).toHaveLength(1);
    expect(quote('hi\nthere')).toBe('“hi there”');
  });
});
