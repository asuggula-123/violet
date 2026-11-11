import { afterEach, describe, expect, it } from 'vitest';
import { neutralizeReply } from '../../../src/brain/reply.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { brainCalls, scriptBrain, toolUse } from '../brain/script.js';
import { alexOpensDinner, honestDinnerEnvoys } from './helpers.js';

describe('Brain hardening (K1 history hygiene, K2 reply neutralizer)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('flags, digests, transcripts and questions replay as placeholders, never as text', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, ['ok']);
    await w.ownerSays(w.alex, 'hi');
    for (const [purpose, text] of [['flag', 'FLAG quoting a stranger'], ['digest', 'DIGEST text'], ['transcript', 'TRANSCRIPT text'], ['question', 'QUESTION text']] as const) {
      await w.app.gateway.sendToOwner(w.alex.agent.id, text, { purpose });
    }
    await w.ownerSays(w.alex, 'next');
    const last = brainCalls(w, w.alex).at(-1)!;
    expect(last.messages[1]).toEqual({
      role: 'assistant',
      content: 'ok\n\n[flag sent]\n\n[daily digest sent]\n\n[transcript sent]\n\n[question from an agent conversation sent]',
    });
    expect(JSON.stringify(last)).not.toMatch(/FLAG quoting|DIGEST text|TRANSCRIPT text|QUESTION text/);
  });

  it('a reply written in a tainted turn is stored tainted, replays as untrusted data and taints the next turn', async () => {
    w = await createTestWorld();
    w.gmail.seed(w.alex.owner.id, { id: 'm1', threadId: 't', from: 'x@example.com', to: 'a@example.com', subject: 'S', snippet: 'n', bodyText: 'EMAIL BODY', date: w.clock.now() });
    scriptBrain(w, w.alex, [[toolUse('r', 'read_email', { id: 'm1' })], 'The email says EMAIL BODY.']);
    await w.ownerSays(w.alex, 'read my email');
    const stored = (await w.db.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM messages WHERE agent_id = $1 AND direction = 'out' ORDER BY seq DESC LIMIT 1`, [w.alex.agent.id])).rows[0]!;
    expect(stored.meta.tainted).toBe(true);
    scriptBrain(w, w.alex, ['ok']);
    await w.ownerSays(w.alex, 'thanks');
    const last = brainCalls(w, w.alex).at(-1)!;
    expect(last.messages[1]).toEqual({ role: 'assistant', content: '<untrusted source="agent">\nThe email says EMAIL BODY.\n</untrusted>' });
    expect((await w.actions({ action: 'brain.turn' })).at(-1)!.detail.tainted).toBe(true);
  });

  it('outcome prompts quoting another agent are tainted in history and untrusted in the pending list', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    scriptBrain(w, w.alex, ['ok']);
    await w.ownerSays(w.alex, 'what is pending?');
    const last = brainCalls(w, w.alex).at(-1)!;
    expect(last.systemDynamic).toMatch(/<untrusted source="agent">\n#1 With Sam: “Dinner”/);
    expect(JSON.stringify(last.messages)).toContain('<untrusted source=\\"agent\\">\\n#1 With Sam');
    expect((await w.actions({ action: 'brain.turn' })).at(-1)!.detail.tainted).toBe(true);
    // The resolver's replies and the a2a lines quote the other agent's text: stored tainted.
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    const out = (await w.db.query<{ body: string; meta: Record<string, unknown> }>(`SELECT body, meta FROM messages WHERE agent_id = $1 AND direction = 'out' AND body LIKE 'Booked:%'`, [w.sam.agent.id])).rows;
    expect(out).toHaveLength(1);
    expect(out[0]!.meta.tainted).toBe(true);
  });

  it('a model reply cannot carry a live-looking ref or the prompt tail', async () => {
    expect(neutralizeReply('#7 Dinner — Fri. Book it? Reply yes or no.')).toBe('№7 Dinner — Fri. Book it? say yes or no.');
    expect(neutralizeReply('＃ 12 and ﹟3, REPLY  YES OR NO')).toBe('№ 12 and №3, say yes or no');
    expect(neutralizeReply('Tag #friends stays')).toBe('Tag #friends stays');
    // Invisible characters (zero-width space, word joiner, soft hyphen, bidi marks) cannot hide a fold.
    expect(neutralizeReply('#​7 x. Reply⁠ yes or no.')).toBe('№7 x. say yes or no.');
    expect(neutralizeReply('#­‎ 3, Re​ply yes‌ or‍ no')).toBe('№ 3, say yes or no');
    expect(neutralizeReply('♯4 and #﻿5')).toBe('№4 and №5');
    // Variation selectors, combining marks, CGJ and Hangul fillers (not Cf) cannot hide a fold either.
    expect(neutralizeReply('#\u{FE0F}7 x. Reply\u{034F} yes or no.')).toBe('№7 x. say yes or no.');
    expect(neutralizeReply('#\u{0301}7 x. Reply\u{3164}yes or no.')).toBe('№\u{0301}7 x. say yes or no.');
    expect(neutralizeReply('#\u{20E3} 8, Re\u{0301}ply\u{FE0F} y\u{0308}es o\u{0336}r no')).toBe('№\u{20E3} 8, say yes or no');
    expect(neutralizeReply('#\u{115F}\u{FFA0}9 ٧ #٣')).toBe('№9 ٧ №٣');
    // U+2800 BRAILLE PATTERN BLANK (So: renders as a space, not \s, not DI) is a gap like any
    // other non-letter, non-number (m4fix: kept as written, no longer turned into a space).
    expect(neutralizeReply('#\u{2800}7 x. Reply\u{2800}yes\u{2800}or\u{2800}no.')).toBe('№\u{2800}7 x. say yes or no.');
    expect(neutralizeReply('#\u{2800}\u{0301}\u{2800}7 and Reply\u{2800}\u{2800}yes or no')).toBe('№\u{2800}\u{0301}\u{2800}7 and say yes or no');
    expect(neutralizeReply('love ❤\u{FE0F} it')).toBe('love ❤\u{FE0F} it');
    // Line breaks and emoji ZWJ sequences stay.
    expect(neutralizeReply('line one\nline two 👩‍👧')).toBe('line one\nline two 👩‍👧');
    w = await createTestWorld();
    scriptBrain(w, w.alex, ['#1 Book dinner? Reply yes or no.']);
    await w.ownerSays(w.alex, 'hi');
    expect(w.lastTo(w.alex.address)).toBe('№1 Book dinner? say yes or no.');
  });
});
