import { afterEach, describe, expect, it } from 'vitest';
import { outcomePrompt, outcomePromptFits } from '../../../src/a2a/render.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import {
  a2aMessages,
  alexOpensDinner,
  contextOf,
  dinnerEvent,
  envoyCalls,
  honestDinnerEnvoys,
  lastResults,
  onlyConversation,
  peerProposalSeq,
  respond,
  scriptEnvoy,
  stepOf,
  toolUse,
} from './helpers.js';

const BOOKED = 'Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.';
const FAILED = "Couldn't book “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”: a calendar didn't accept it. Nothing was booked.";
const dinners = (w: TestWorld, ownerId: string) => w.calendar.eventsOf(ownerId).filter((e) => e.title === 'Dinner');

describe('a2a booking is resumable (I7)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  async function prompted(opts: Parameters<typeof createTestWorld>[0] = {}): Promise<void> {
    w = await createTestWorld(opts);
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  }

  it('a crash between the two writes whose job never retries: the sweep finishes the booking and tells both owners', async () => {
    await prompted({ jobs: { maxAttempts: 1 } });
    await w.ownerSays(w.alex, 'yes');
    const writer = w.app.approvals!.calendar;
    const original = writer.executeApproved.bind(writer);
    let calls = 0;
    writer.executeApproved = async (id: string) => {
      calls += 1;
      if (calls === 2) throw new Error('crash: worker died between the two writes');
      return original(id);
    };
    await w.ownerSays(w.sam, 'yes');
    // Half-way for now: Sam's event is written, Alex's is not, and the group is still 'booking'.
    expect(dinners(w, w.sam.owner.id)).toHaveLength(1);
    expect(dinners(w, w.alex.owner.id)).toHaveLength(0);
    await w.advance({ minutes: 11 }); // past the claim lease and one sweep
    expect(dinners(w, w.sam.owner.id)).toHaveLength(1);
    expect(dinners(w, w.alex.owner.id)).toHaveLength(1);
    expect(w.lastTo(w.sam.address)).toBe(BOOKED);
    expect(w.lastTo(w.alex.address)).toBe(BOOKED);
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'booked' });
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(2);
  });

  it('a crash between the two writes: the retried hook takes its own claim over and finishes at once', async () => {
    await prompted({ jobs: { backoffMs: () => 0 } });
    await w.ownerSays(w.alex, 'yes');
    const writer = w.app.approvals!.calendar;
    const original = writer.executeApproved.bind(writer);
    let calls = 0;
    writer.executeApproved = async (id: string) => {
      calls += 1;
      if (calls === 2) throw new Error('crash');
      return original(id);
    };
    await w.ownerSays(w.sam, 'yes');
    expect(dinners(w, w.sam.owner.id)).toHaveLength(1);
    expect(dinners(w, w.alex.owner.id)).toHaveLength(1);
    expect(w.lastTo(w.sam.address)).toBe(BOOKED);
    expect(w.lastTo(w.alex.address)).toBe(BOOKED);
    expect(w.textsTo(w.sam.address).filter((t) => t.startsWith('Okay, approved'))).toEqual([]);
  });

  it('an undo that keeps failing: both owners are told the event is still there; once it is removed they hear nothing was booked', async () => {
    await prompted();
    await w.ownerSays(w.sam, 'yes');
    const create = w.calendar.createEvent.bind(w.calendar);
    w.calendar.createEvent = async (ownerId, ev, key) => {
      if (ownerId === w.sam.owner.id) throw new Error('calendar down');
      return create(ownerId, ev, key);
    };
    const del = w.calendar.deleteEvent.bind(w.calendar);
    let deleteWorks = false;
    w.calendar.deleteEvent = async (ownerId, eventId) => {
      if (!deleteWorks) throw new Error('delete failed');
      return del(ownerId, eventId);
    };
    await w.ownerSays(w.alex, 'yes');
    expect(dinners(w, w.alex.owner.id)).toHaveLength(1);
    expect(w.lastTo(w.alex.address)).toMatch(/^Couldn't book “Dinner”.*It is still on your calendar for now; I'm removing it/);
    expect(w.lastTo(w.sam.address)).toMatch(/^Couldn't book “Dinner”.*It is still on Alex's calendar for now; I'm removing it/);
    for (const t of [w.lastTo(w.alex.address), w.lastTo(w.sam.address)]) expect(t).not.toContain('Nothing was booked');
    // Sweeps keep trying; the idle sweep never closes a booking in progress.
    await w.advance({ minutes: 11 });
    await w.advance({ hours: 25 });
    expect(dinners(w, w.alex.owner.id)).toHaveLength(1);
    expect((await onlyConversation(w)).status).toBe('awaiting_approval');
    deleteWorks = true;
    await w.advance({ minutes: 11 });
    expect(dinners(w, w.alex.owner.id)).toHaveLength(0);
    expect(w.lastTo(w.alex.address)).toBe(FAILED);
    expect(w.lastTo(w.sam.address)).toBe(FAILED);
    expect((await onlyConversation(w)).status).toBe('open');
  });
});

describe('a2a outcome prompts show every event (I5, I13)', () => {
  const NOW = new Date('2026-11-12T12:00:00Z');
  let w: TestWorld | undefined;
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  const ev = (n: number, start: string, end: string) => ({
    title: `Planning session number ${n} for the school fair`,
    start,
    end,
    location: `Community hall room ${n}, second floor`,
  });

  it('a long multi-event prompt is never shortened: it shows every title and location whole, so it does not fit and is refused', () => {
    const events = [9, 11, 13, 15, 17].map((h, i) => ev(i + 1, `2026-11-13T${String(h).padStart(2, '0')}:00:00-05:00`, `2026-11-13T${String(h).padStart(2, '0')}:30:00-05:00`));
    const line = outcomePrompt({ peer: 'Sam', summary: 'Five sessions', events }, 'America/New_York', NOW);
    for (const e of events) expect(line).toContain(`“${e.title}” — `);
    for (const e of events) expect(line).toContain(`at “${e.location}”`);
    for (const t of ['9:00–9:30 AM', '11:00–11:30 AM', '1:00–1:30 PM', '3:00–3:30 PM', '5:00–5:30 PM']) expect(line).toContain(t);
    expect(outcomePromptFits({ peer: 'Sam', summary: 'Five sessions', events }, 'America/New_York', NOW)).toBe(false);
  });

  it('a short proposal keeps the full form', () => {
    const p = { peer: 'Sam', summary: 'x', events: [{ title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00', location: "Luigi's" }] };
    expect(outcomePrompt(p, 'America/New_York', NOW)).toBe("With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”. Book it?");
  });

  it('five overnight events cannot be shown whole: propose is refused by code and nobody is asked', async () => {
    const days = [13, 14, 15, 16, 17];
    const events = days.map((day, i) => ({
      ...ev(i + 1, `2026-11-${day}T22:00:00-05:00`, `2026-11-${day + 1}T01:00:00-05:00`),
      calendars: 'both',
    }));
    expect(outcomePromptFits({ peer: 'Sam', summary: 's', events }, 'America/New_York', NOW)).toBe(false);
    w = await createTestWorld();
    const world = w;
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Fair', brief: 'Plan the fair nights', window_start: '2026-11-12T00:00:00-05:00', window_end: '2026-11-19T00:00:00-05:00' })])
        : respond([{ type: 'text', text: 'ok' }]),
    );
    scriptEnvoy(world, world.sam, () => [[toolUse('p', 'propose', { summary: 'Five nights', events })], 'done']);
    scriptEnvoy(world, world.alex, () => ['ok']);
    await world.ownerSays(world.alex, 'plan the fair with Sam');
    expect((await a2aMessages(world)).map((m) => m.kind)).not.toContain('proposal');
    const results = envoyCalls(world, world.sam).flatMap((c) => lastResults(c));
    expect(results.some((r) => r.is_error && /fewer events, or shorter titles/.test(r.content))).toBe(true);
    expect(world.textsTo(world.sam.address).filter((t) => t.startsWith('#'))).toEqual([]);
  });
});

describe('a2a accept is not a free/busy oracle (I10)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it("outside the responder's 7 days the accept-time check is deferred to the booking guard: owners are asked, a busy slot is still never booked", async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Catch up', brief: 'Catch up sometime?', window_start: '2026-11-10T00:00:00-05:00', window_end: '2026-11-30T00:00:00-05:00' })])
        : respond([{ type: 'text', text: 'ok' }]),
    );
    w.calendar.seed(w.sam.owner.id, { title: 'Private', start: new Date('2026-11-25T18:00:00-05:00'), end: new Date('2026-11-25T22:00:00-05:00') });
    const probe = dinnerEvent({ start: '2026-11-25T19:00:00-05:00', end: '2026-11-25T20:00:00-05:00', location: undefined });
    scriptEnvoy(w, w.alex, (req) => (/You proposed/.test(contextOf(req)) ? ['done'] : [[toolUse('p', 'propose', { summary: 'probe', events: [probe] })], 'done']));
    scriptEnvoy(w, w.sam, (req) => {
      const seq = peerProposalSeq(req);
      return seq === null ? [[toolUse('h', 'say', { text: 'Hi, when suits?' })], 'done'] : [[toolUse('a', 'accept', { proposal_seq: seq })], 'done'];
    });
    await w.ownerSays(w.alex, 'catch up with Sam');
    expect((await a2aMessages(w)).map((m) => m.kind)).toContain('accept');
    // Alex's own calendar (inside Alex's 31 days) was checked and charged to Alex's budget; Sam's was not read.
    const sides = (await w.db.query<{ agent_id: string; availability_calls: number }>('SELECT agent_id, availability_calls FROM a2a_sides')).rows;
    expect(Object.fromEntries(sides.map((s) => [s.agent_id, s.availability_calls]))).toEqual({ [w.alex.agent.id]: 1, [w.sam.agent.id]: 0 });
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toEqual([]);
    expect(w.lastTo(w.alex.address)).toMatch(/that time is no longer free\. Nothing was booked\.$/);
  });
});
