import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, dinnerEvent, envoyCalls, FRI, honestDinnerEnvoys, onlyConversation } from './helpers.js';

const PROMPT = (ref: number, who: string) => `#${ref} With ${who}: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”. Book it? Reply yes or no.`;
const BOOKED = 'Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.';

describe('a2a dinner simulation', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  async function setUp(): Promise<void> {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  }

  it('Alex asks for dinner; the Envoys agree; both owners approve; one event on each calendar; both told Booked', async () => {
    await setUp();
    expect(w.textsTo(w.alex.address)).toEqual([
      "I've asked Sam's Violet.",
      'Talking to Sam\'s Violet about “Dinner Friday”: “Alex would like dinner with Sam on Friday evening.”',
      PROMPT(1, 'Sam'),
    ]);
    expect(w.textsTo(w.sam.address)).toEqual([PROMPT(1, 'Alex')]);
    // The Envoys ran on the internal channel only: nothing to either owner but the lines above.
    expect(envoyCalls(w, w.sam).every((c) => c.meta.conversationId)).toBe(true);
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'proposal', 'accept']);

    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe('Waiting for Sam.');
    expect(w.calendar.writes).toEqual([]);

    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe(BOOKED);
    expect(w.lastTo(w.alex.address)).toBe(BOOKED);
    for (const p of [w.alex, w.sam]) {
      const events = w.calendar.eventsOf(p.owner.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ title: 'Dinner', location: "Luigi's", start: new Date(FRI.dinner.start), end: new Date(FRI.dinner.end) });
      expect(events[0]!.attendees).toBeUndefined(); // separate events, no invites
    }
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(2);
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'booked' });
    // The other owner learns of the start and the booking through digest flags (I17).
    const samFlags = await w.app.repos.flags.listByAgent(w.sam.agent.id);
    expect(samFlags.map((f) => [f.kind, f.urgency])).toEqual(
      expect.arrayContaining([
        ['a2a_opened', 'digest'],
        ['a2a_closed', 'digest'],
        ['a2a_booked', 'digest'],
      ]),
    );
    for (const action of ['a2a.opened', 'a2a.message', 'a2a.envoy_turn', 'a2a.availability', 'a2a.release', 'a2a.outcome_requested', 'a2a.booked', 'a2a.closed']) {
      expect((await w.actions({ action })).length, action).toBeGreaterThan(0);
    }
  });

  it('Sam says no: Alex is told, nothing is booked, the conversation reopens and waits for Sam', async () => {
    await setUp();
    await w.ownerSays(w.sam, 'no');
    expect(w.lastTo(w.alex.address)).toBe('Sam said no to: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi\'s”. Nothing was booked.');
    const alexPrompt = (await w.db.query<{ status: string }>(`SELECT status FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'`, [w.alex.agent.id])).rows[0]!;
    expect(alexPrompt.status).toBe('cancelled');
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).not.toBe('Waiting for Sam.');
    expect(w.calendar.writes).toEqual([]);
    expect(await onlyConversation(w)).toMatchObject({ status: 'open' });
    const side = (await w.db.query<{ awaiting_owner: boolean }>('SELECT awaiting_owner FROM a2a_sides WHERE agent_id = $1', [w.sam.agent.id])).rows[0]!;
    expect(side.awaiting_owner).toBe(true);
  });

  it('an expired approval: the other prompt is cancelled, its owner told, nothing booked', async () => {
    await setUp();
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ hours: 25 });
    expect(w.textsTo(w.alex.address)).toContain('No answer from Sam, so nothing was booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi\'s”.');
    expect(w.calendar.writes).toEqual([]);
  });

  it('the slot is taken between accept and the second yes: nothing booked, both Envoys hear the slot is gone', async () => {
    await setUp();
    await w.ownerSays(w.alex, 'yes');
    w.calendar.seed(w.sam.owner.id, { title: 'Private thing', start: new Date('2026-11-13T19:30:00-05:00'), end: new Date('2026-11-13T21:00:00-05:00') });
    const before = envoyCalls(w).length;
    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe("Couldn't book “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”: that time is no longer free. Nothing was booked.");
    expect(w.lastTo(w.alex.address)).toBe("Couldn't book “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”: that time is no longer free. Nothing was booked.");
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toEqual([]);
    const system = (await a2aMessages(w)).filter((m) => m.kind === 'system').at(-1)!;
    expect(system.body).toBe('That time is no longer free, so nothing was booked.');
    // Both Envoys got the system message (one turn each); no detail of the other event leaked.
    const after = envoyCalls(w).slice(before);
    expect(new Set(after.map((c) => c.meta.agentId))).toEqual(new Set([w.alex.agent.id, w.sam.agent.id]));
    expect(JSON.stringify(after)).not.toContain('Private thing');
  });

  it('a time no longer free at accept: nothing is accepted, no prompts, both Envoys told', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    // Alex becomes busy right as the proposal arrives (after Sam's availability check).
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, () => ({ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }));
    w.calendar.seed(w.alex.owner.id, { title: 'Gym', start: new Date('2026-11-13T20:00:00-05:00'), end: new Date('2026-11-13T21:00:00-05:00') });
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(w.textsTo(w.sam.address)).toEqual([]);
    expect((await a2aMessages(w)).map((m) => m.kind)).toContain('system');
    expect((await a2aMessages(w)).map((m) => m.kind)).not.toContain('accept');
  });

  it("one calendar write fails after the other succeeded: the booked side is undone, both told, nothing half-booked", async () => {
    await setUp();
    await w.ownerSays(w.alex, 'yes');
    const original = w.calendar.createEvent.bind(w.calendar);
    w.calendar.createEvent = async (ownerId, ev, key) => {
      if (ownerId === w.alex.owner.id) throw new Error('calendar down');
      return original(ownerId, ev, key);
    };
    await w.ownerSays(w.sam, 'yes');
    expect(w.calendar.eventsOf(w.sam.owner.id)).toEqual([]);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([]);
    expect(w.calendar.writes.map((x) => x.op)).toEqual(['create', 'delete']);
    const failed = "Couldn't book “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”: a calendar didn't accept it. Nothing was booked.";
    expect(w.lastTo(w.sam.address)).toBe(failed);
    expect(w.lastTo(w.alex.address)).toBe(failed);
    expect((await w.actions({ action: 'a2a.booking_failed' })).length).toBe(1);
  });

  it('several events: one compact line', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    const second = dinnerEvent({ title: 'Drinks', start: '2026-11-13T21:00:00-05:00', end: '2026-11-13T22:00:00-05:00', location: undefined, calendars: 'mine' });
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, (_req, n) =>
      n === 0
        ? { content: [{ type: 'tool_use', id: 'p', name: 'propose', input: { summary: 'Dinner then drinks', events: [dinnerEvent(), second] } }], stopReason: 'tool_use' }
        : { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    );
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(w.lastTo(w.sam.address)).toBe('#1 With Alex: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi\'s”; “Drinks” — Fri Nov 13, 9:00–10:00 PM. Book them? Reply yes or no.');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    expect(w.calendar.eventsOf(w.sam.owner.id).map((e) => e.title)).toEqual(['Dinner', 'Drinks']);
    expect(w.calendar.eventsOf(w.alex.owner.id).map((e) => e.title)).toEqual(['Dinner']); // 'mine' = the proposer's (Sam's) calendar only
  });
});
