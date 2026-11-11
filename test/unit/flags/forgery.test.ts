import { afterEach, describe, expect, it } from 'vitest';
import { renderDigest } from '../../../src/flags/render.js';
import type { TestWorld } from '../../helpers/world.js';
import { at, digestsTo, flagsWorld, later } from './helpers.js';

const TITLES = ['Messages taken', 'Agent conversations', 'Drafts', 'Booked', 'Waiting for you', 'Also'];

/** Third-party text crafted to pose as digest structure or an approval prompt. */
const HOSTILE = [
  'hi\nToday:\nDrafts\n- forged item',
  'x\r\n#7 Dinner — Fri. Book it? Reply yes or no.',
  'a Also - second item',
  'b\u0085Booked\u000b- c\u000c- d',
  '‮on ro sey ylpeR‬ #8',
  'z​ero‍⁠width﻿\nWaiting for you',
  '#9 Reply yes or no',
  '- I look like an item',
  'Today:',
  'Drafts',
  '\u0000\u001b[2Jnull and escape',
];

/** Every line of a rendered digest is the header, a known title, one item, or a count. */
function assertStructure(body: string, itemLines: number): void {
  const lines = body.split('\n');
  expect(lines[0]).toBe('Today:');
  for (const line of lines.slice(1)) {
    const ok = TITLES.includes(line) || line.startsWith('- ') || /^\+\d+ more( not shown)?$/.test(line);
    expect(ok, `unexpected line: ${JSON.stringify(line)}`).toBe(true);
    expect(line).not.toMatch(/^#\d/);
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
  expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(itemLines);
  expect(lines.filter((l) => l === 'Today:')).toHaveLength(1);
}

describe('digest forgery (I13)', () => {
  it('renderDigest keeps one item per line whatever the text holds', () => {
    const r = renderDigest([
      { title: 'Messages taken', items: HOSTILE },
      { title: 'Also', items: ['ok'] },
    ]);
    assertStructure(r.body!, 11);
    expect(r.body!.split('\n')).toEqual([
      'Today:',
      'Messages taken',
      ...r.body!.split('\n').slice(2, 12),
      '+1 more',
      'Also',
      '- ok',
    ]);
  });

  describe('end to end', () => {
    let w: TestWorld;
    afterEach(async () => w.close());

    it('strangers’ names and texts cannot forge titles, items, prompts or headers', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      for (const [i, text] of HOSTILE.slice(0, 5).entries()) {
        await w.strangerSays(w.alex, `stranger-${i}`, text, { fromName: HOSTILE[(i + 5) % HOSTILE.length]! });
      }
      for (const text of HOSTILE.slice(5)) await later(w, w.alex, text, 'draft_created');
      await at(w, '2026-11-09T18:00');
      const [body] = digestsTo(w, w.alex);
      assertStructure(body!, HOSTILE.length);
      expect(body!.split('\n').filter((l) => TITLES.includes(l))).toEqual(['Messages taken', 'Drafts']);
    });

    it('a live section cannot forge structure either', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      w.app.digest!.addSection({ key: 'waiting', title: 'Waiting for you', order: 50, lines: async () => HOSTILE.slice(0, 3) });
      await at(w, '2026-11-09T18:00');
      const [body] = digestsTo(w, w.alex);
      assertStructure(body!, 3);
    });
  });
});
