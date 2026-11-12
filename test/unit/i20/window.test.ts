/**
 * I20: the owner's yes covers everything that crosses. A release that opens a conversation
 * carries a time window too; the a2a_release prompt shows it (code-rendered, to the minute),
 * and the window is kept to the minute (start down, end up) in tainted and untainted turns,
 * so a fooled Brain cannot hide data in the seconds of the window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const START = '2026-11-13T18:48:17-05:00';
const END = '2026-11-13T22:10:01-05:00';
const talk = toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee on Friday?', window_start: START, window_end: END });

async function world(): Promise<void> {
  w = await createTestWorld();
  w.gmail.seed(w.alex.owner.id, { id: 'm1', threadId: 't', from: 'news@example.com', to: 'alex@example.com', subject: 'Hi', snippet: 'hello', bodyText: 'hello', date: w.clock.now() });
  scriptEnvoy(w, w.sam, () => ['ok']);
  scriptEnvoy(w, w.alex, () => ['ok']);
}

async function storedWindow(): Promise<[string, string]> {
  const r = (await w.db.query<{ window_start: Date; window_end: Date }>('SELECT window_start, window_end FROM a2a_conversations')).rows[0]!;
  return [r.window_start.toISOString(), r.window_end.toISOString()];
}

/** Everything Sam's side (its model requests, Sam's phone) received. */
const samSide = () => JSON.stringify([w.llm.calls.filter((c) => c.meta.agentId === w.sam.agent.id), w.textsTo(w.sam.address)]);

describe('I20: the release prompt shows the window, and the window crosses only to the minute', () => {
  it('tainted: the prompt shows the window; the payload and the conversation hold it to the minute; no seconds reach Sam', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [respond([toolUse('r', 'read_email', { id: 'm1' })]), respond([talk]), respond([{ type: 'text', text: "I'll check with you first." }])][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Ask Sam about coffee on Friday');
    expect(w.textsTo(w.alex.address)).toContain('#1 Tell Sam\'s Violet about “Coffee” (Fri Nov 13, 6:48–10:11 PM): “Coffee on Friday?” Send? Reply yes or no.');
    const held = (await w.db.query<{ payload: { windowStart: string; windowEnd: string } }>("SELECT payload FROM approvals WHERE kind = 'a2a_release'")).rows[0]!;
    expect([held.payload.windowStart, held.payload.windowEnd]).toEqual(['2026-11-13T23:48:00.000Z', '2026-11-14T03:11:00.000Z']);
    expect(await a2aMessages(w)).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ minutes: 5 });
    expect(await storedWindow()).toEqual(['2026-11-13T23:48:00.000Z', '2026-11-14T03:11:00.000Z']);
    expect(samSide()).not.toMatch(/48:17|10:01/);
  });

  it('untainted: released at once, with the same minute window', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond([talk]) : respond([{ type: 'text', text: 'Asked.' }])));
    await w.ownerSays(w.alex, 'Ask Sam about coffee on Friday, 6:48 to 10:10 pm');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);
    expect(await storedWindow()).toEqual(['2026-11-13T23:48:00.000Z', '2026-11-14T03:11:00.000Z']);
    await w.advance({ minutes: 5 });
    expect(samSide()).not.toMatch(/48:17|10:01/);
  });
});

describe('I20: the release prompt text determines the stored window exactly', () => {
  /** Holds one talk_to_agent with this window in a tainted turn; returns the prompt and the stored payload window. */
  async function held(start: string, end: string): Promise<{ prompt: string; stored: [string, string] }> {
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'read_email', { id: 'm1' })]),
        respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee?', window_start: start, window_end: end })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, `Ask Sam about coffee ${start}`);
    const row = (await w.db.query<{ prompt: string; payload: { windowStart: string; windowEnd: string } }>(
      "SELECT prompt, payload FROM approvals WHERE kind = 'a2a_release' ORDER BY ref DESC LIMIT 1",
    )).rows[0]!;
    return { prompt: row.prompt.replace(/^#\d+ /, ''), stored: [row.payload.windowStart, row.payload.windowEnd] };
  }

  it('a window in another year shows the year; one in this year does not', async () => {
    await world();
    const later = await held('2037-11-13T18:00:00-05:00', '2037-11-13T21:00:00-05:00');
    expect(later.prompt).toContain('(Fri Nov 13 2037, 6:00 PM – Fri Nov 13 2037, 9:00 PM)');
    const now = await held('2026-11-13T18:00:00-05:00', '2026-11-13T21:00:00-05:00');
    expect(now.prompt).toContain('(Fri Nov 13, 6:00–9:00 PM)');
    const newYear = await held('2026-12-31T20:00:00-05:00', '2027-01-01T02:00:00-05:00');
    expect(newYear.prompt).toContain('(Thu Dec 31 2026, 8:00 PM – Fri Jan 1 2027, 2:00 AM)');
  });

  it('a local time that occurs twice (DST fall-back) shows its UTC offset; the two readings differ', async () => {
    await world();
    const edt = await held('2026-11-01T01:30:00-04:00', '2026-11-10T00:00:00-05:00');
    const est = await held('2026-11-01T01:30:00-05:00', '2026-11-10T00:00:00-05:00');
    expect(edt.prompt).toContain('Sun Nov 1, 1:30 AM (UTC-04:00) – Tue Nov 10, 12:00 AM');
    expect(est.prompt).toContain('Sun Nov 1, 1:30 AM (UTC-05:00) – Tue Nov 10, 12:00 AM');
  });

  it('every stored window is recoverable from the prompt text (distinct windows, distinct prompts)', async () => {
    await world();
    const windows: Array<[string, string]> = [
      ['2026-11-13T18:00:00-05:00', '2026-11-13T21:00:00-05:00'],
      ['2037-11-13T18:00:00-05:00', '2037-11-13T21:00:00-05:00'],
      ['2043-11-13T18:00:00-05:00', '2043-11-13T21:00:00-05:00'],
      ['2026-11-01T01:30:00-04:00', '2026-11-10T00:00:00-05:00'],
      ['2026-11-01T01:30:00-05:00', '2026-11-10T00:00:00-05:00'],
      ['2027-11-07T01:30:00-04:00', '2027-11-07T04:00:00-05:00'],
      ['2027-11-07T01:30:00-05:00', '2027-11-07T04:00:00-05:00'],
      ['2027-11-07T01:00:00-04:00', '2027-11-07T01:45:00-05:00'],
      ['2027-11-07T01:00:00-04:00', '2027-11-07T01:45:00-04:00'],
    ];
    const seen = new Map<string, string>();
    for (const [s, e] of windows) {
      const h = await held(s, e);
      const shown = /\((.*)\): /.exec(h.prompt)![1]!;
      const key = h.stored.join('/');
      expect(seen.get(shown) ?? key, `two stored windows render as “${shown}”`).toBe(key);
      seen.set(shown, key);
    }
    expect(seen.size).toBe(windows.length);
  });
});
