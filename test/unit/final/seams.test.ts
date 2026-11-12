/**
 * M.2: where the fix groups meet. Q's held booking with P's year-relative prompt text; R's
 * unrecorded owner texts with P's taint; R's unrecorded prompt with I19's delivery rows; Q's
 * `transcript` command with I19 and taint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { contextOf, dinnerEvent, peerProposalSeq, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';
import { i19Violations } from '../i19/helpers.js';
import { a2aBodies, cleanOpen, DINNER, DINNER_PROMPT, REPLY, SECRET, statusByRef, taintedTurn, talk } from '../seam/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const JAN = { windowStart: '2027-01-01T00:00:00-05:00', windowEnd: '2027-01-03T00:00:00-05:00', dinner: { start: '2027-01-02T19:00:00-05:00', end: '2027-01-02T20:30:00-05:00' } };

describe('Q held booking x P year-relative text', () => {
  it('asked in December for a January dinner, held over New Year, resumed in January: booked on both, the lines true in the new year', async () => {
    w = await createTestWorld();
    w.clock.advance({ days: 50 }); // Tue Dec 29, 2026
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('b1', 'talk_to_agent', { with: 'Sam', topic: 'Dinner', brief: 'Dinner on Saturday?', window_start: JAN.windowStart, window_end: JAN.windowEnd })])
        : respond([{ type: 'text', text: 'Asked.' }]),
    );
    const event = dinnerEvent(JAN.dinner);
    scriptEnvoy(w, w.sam, (req) => (peerProposalSeq(req) === null && !/You proposed/.test(contextOf(req)) ? [[toolUse('s', 'propose', { summary: 'Dinner Saturday', events: [event] })], 'done'] : ['ok']));
    scriptEnvoy(w, w.alex, (req) => {
      const seq = peerProposalSeq(req);
      return seq === null ? ['waiting'] : [[toolUse('a', 'accept', { proposal_seq: seq })], 'done'];
    });
    await w.ownerSays(w.alex, 'Dinner with Sam on Saturday');
    expect(w.lastTo(w.alex.address)).toBe("#1 With Sam: “Dinner” — Sat Jan 2 2027, 7:00 PM – Sat Jan 2 2027, 8:30 PM at “Luigi's”. Book it? Reply yes or no.");
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.sam, 'yes');
    for (let h = 0; h < 72; h += 6) await w.advance({ hours: 6 }); // Fri Jan 1, 2027
    expect(w.calendar.writes).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect(w.calendar.writes.filter((x) => x.op === 'create').map((x) => x.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    const line = 'Booked: “Dinner” — Sat Jan 2, 7:00–8:30 PM.';
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Booked'))).toEqual([line]);
    expect(w.textsTo(w.sam.address).filter((t) => t.startsWith('Booked'))).toEqual([line]);
  });
});

/** Every outbound `messages` insert fails while `on()` is true (the texts are still delivered). */
function storageDown(t: TestWorld): { set(v: boolean): void } {
  const add = t.app.repos.messages.add.bind(t.app.repos.messages);
  let down = false;
  t.app.repos.messages.add = async (m) => {
    if (down && m.direction === 'out') throw new Error('storage unavailable');
    return add(m);
  };
  return { set: (v) => (down = v) };
}

describe('R unrecorded texts x P taint', () => {
  it('a tainted turn whose reply, prompt and resolver line were all delivered but not stored: the next turn still starts tainted, so a fooled release is held', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    const storage = storageDown(w);
    const conv = await cleanOpen(w);
    storage.set(true);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', 'See you Saturday!')]);
    await w.ownerSays(w.alex, 'Tell Sam see you Saturday');
    await w.ownerSays(w.alex, 'yes'); // directly under the prompt: its delivery row was recorded (I19)
    expect(await statusByRef(w, w.alex, 1)).toBe('executed');
    storage.set(false);
    expect((await w.actions({ action: 'outbound.sent', agentId: w.alex.agent.id })).filter((r) => r.detail.recorded === false && r.detail.tainted === true).length).toBeGreaterThan(0);
    // The next turn reads no tool and has no tainted row in its history; a fooled model releases the secret.
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('g', 'tell_envoy', { conversation: conv, guidance: SECRET })]) : respond([{ type: 'text', text: REPLY }]),
    );
    await w.ownerSays(w.alex, 'thanks');
    expect((await a2aBodies(w)).map((m) => m.body)).not.toContain(SECRET);
    expect(w.lastTo(w.alex.address)).toMatch(/^#2 Tell Sam's Violet: /);
  });

  it('a prompt delivered but not stored can still be answered: directly under it, by its button, and by its number (shown again)', async () => {
    w = await createTestWorld();
    const storage = storageDown(w);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond([toolUse('c', 'request_calendar_event', DINNER)]) : respond([{ type: 'text', text: 'Asked.' }])));
    storage.set(true);
    await w.ownerSays(w.alex, 'book dinner friday');
    storage.set(false);
    expect(w.lastTo(w.alex.address)).toBe(DINNER_PROMPT(1));
    await w.ownerSays(w.alex, 'hm');
    await w.ownerSays(w.alex, 'yes 1'); // not under it: shown again, as a recorded genuine delivery
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${DINNER_PROMPT(1)}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusByRef(w, w.alex, 1)).toBe('executed');
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('Q transcript command x I19 and taint', () => {
  it('`transcript` is not a decision and not a prompt: it resolves nothing, a bare yes under it resolves nothing; stored tainted, the Brain sees only a placeholder', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    await cleanOpen(w);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'Tell Sam about Saturday');
    await w.ownerSays(w.alex, 'transcript');
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    const row = (await w.db.query<{ body: string; meta: Record<string, unknown> }>("SELECT body, meta FROM messages WHERE purpose = 'transcript'")).rows[0]!;
    expect(row.meta.tainted).toBe(true);
    await w.ownerSays(w.alex, 'yes'); // directly under the transcript, not under the prompt
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    expect((await a2aBodies(w)).map((m) => m.body)).not.toContain(SECRET);
    const brain = w.llm.calls.filter((c) => c.meta.mind === 'brain');
    await w.ownerSays(w.alex, 'what did Sam say?');
    const last = JSON.stringify(w.llm.calls.filter((c) => c.meta.mind === 'brain').slice(brain.length)[0]!.messages);
    expect(last).toContain('[transcript sent]');
    expect(last).not.toContain(row.body.split('\n')[0]!);
    expect(await i19Violations(w)).toEqual([]);
  });
});
