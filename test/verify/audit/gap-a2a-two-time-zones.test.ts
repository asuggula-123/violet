import { afterEach, describe, expect, it } from 'vitest';
import { effectiveWindow } from '../../../src/a2a/envoyTools.js';
import { bookedLine, outcomePrompt, outcomePromptFits } from '../../../src/a2a/render.js';
import type { ConversationRow, SideRow } from '../../../src/a2a/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { contextOf, envoyCalls, FRI, peerProposalSeq, scriptEnvoy, stepOf, toolUse, respond } from '../../unit/a2a/helpers.js';

/**
 * Audit: two owners in different time zones (Alex in America/New_York, Sam in Asia/Kolkata or
 * Pacific/Kiritimati) through the whole agent-to-agent flow.
 */

async function setZone(w: TestWorld, p: Persona, tz: string): Promise<void> {
  await w.db.query('UPDATE owners SET timezone = $2 WHERE id = $1', [p.owner.id, tz]);
}

// Fri Nov 13 7:00 PM in New York = 2026-11-14T00:00Z = Sat Nov 14 5:30 AM in Kolkata.
const DINNER_IST = { start: '2026-11-14T05:30:00+05:30', end: '2026-11-14T07:00:00+05:30' };

function alexOpens(w: TestWorld): void {
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
    stepOf(req) === 0
      ? respond([toolUse('b1', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Alex would like dinner with Sam on Friday evening.', window_start: FRI.windowStart, window_end: FRI.windowEnd })])
      : respond([{ type: 'text', text: "I've asked Sam's Violet." }]),
  );
}

/** Sam's Envoy (in its own zone's offset) proposes; Alex's Envoy accepts. */
function envoys(w: TestWorld, event: { start: string; end: string }, summary = 'Dinner on Friday at 7'): void {
  scriptEnvoy(w, w.sam, (req) =>
    peerProposalSeq(req) === null && !/You proposed/.test(contextOf(req))
      ? [
          [toolUse('s1', 'check_availability', { start: FRI.windowStart, end: FRI.windowEnd })],
          [toolUse('s2', 'propose', { summary, events: [{ title: 'Dinner', ...event, location: "Luigi's", calendars: 'both' }] })],
          'done',
        ]
      : ['nothing to add'],
  );
  scriptEnvoy(w, w.alex, (req) => {
    const seq = peerProposalSeq(req);
    return seq === null ? ['waiting'] : [[toolUse('a2', 'accept', { proposal_seq: seq })], 'done'];
  });
}

describe('audit: a2a with owners in two time zones', () => {
  let w: TestWorld;
  afterEach(async () => {
    if (w) await w.close();
    w = undefined as unknown as TestWorld;
  });

  it('NY x Kolkata dinner: each owner sees the same instants in their own zone; same instants booked on both calendars', async () => {
    w = await createTestWorld();
    await setZone(w, w.sam, 'Asia/Kolkata');
    w.calendar.seed(w.sam.owner.id, { title: 'Yoga', start: new Date('2026-11-13T12:00:00+05:30'), end: new Date('2026-11-13T13:00:00+05:30') });
    alexOpens(w);
    envoys(w, DINNER_IST);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');

    expect(w.lastTo(w.alex.address)).toBe('#1 With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi\'s”. Book it? Reply yes or no.');
    expect(w.textsTo(w.sam.address)).toEqual(['#1 With Alex: “Dinner” — Sat Nov 14, 5:30–7:00 AM at “Luigi\'s”. Book it? Reply yes or no.']);

    // Sam's Envoy works in Sam's zone: time, window and busy times written with +05:30.
    const samFirst = envoyCalls(w, w.sam)[0]!;
    expect(samFirst.systemDynamic).toContain('Asia/Kolkata');
    expect(samFirst.systemDynamic).toContain('Window you may check: 2026-11-13T10:30:00+05:30 → 2026-11-14T10:30:00+05:30.');
    const samSecond = envoyCalls(w, w.sam)[1]!;
    const seen = JSON.stringify(samSecond.messages);
    expect(seen).toContain("Sam's busy times from 2026-11-13T10:30:00+05:30 to 2026-11-14T10:30:00+05:30");
    expect(seen).toContain('- 2026-11-13T12:00:00+05:30 → 2026-11-13T13:00:00+05:30');

    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe('Booked: “Dinner” — Sat Nov 14, 5:30–7:00 AM.');
    expect(w.lastTo(w.alex.address)).toBe('Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.');
    for (const p of [w.alex, w.sam]) {
      const ev = w.calendar.eventsOf(p.owner.id).filter((e) => e.title === 'Dinner');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.start.toISOString()).toBe('2026-11-14T00:00:00.000Z');
      expect(ev[0]!.end.toISOString()).toBe('2026-11-14T01:30:00.000Z');
    }

    // Transcripts: the proposal is rendered in each reader's zone. The model's summary ("Friday")
    // is shown next to Sam's "Sat Nov 14" (model text, quoted as such).
    const conv = (await w.db.query<{ id: string }>('SELECT id FROM a2a_conversations')).rows[0]!;
    const samT = await w.app.a2a!.transcript(w.sam.agent.id, conv.id);
    const alexT = await w.app.a2a!.transcript(w.alex.agent.id, conv.id);
    // Q3/Q9: the transcript line format changed (proposal number, reader-relative calendars, summary whole).
    expect(samT).toMatch(/Violet proposed \(proposal \d+\): “Dinner” — Sat Nov 14, 5:30–7:00 AM at “Luigi's”, on both calendars\. Summary: “Dinner on Friday at 7”/);
    expect(alexT).toMatch(/Sam's Violet proposed \(proposal \d+\): “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”, on both calendars\. Summary: “Dinner on Friday at 7”/);
  });

  it('Kiritimati (UTC+14): the date differs by a day and the prompt still fits and books the same instant', async () => {
    w = await createTestWorld();
    await setZone(w, w.sam, 'Pacific/Kiritimati');
    alexOpens(w);
    envoys(w, { start: '2026-11-14T14:00:00+14:00', end: '2026-11-14T15:30:00+14:00' });
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(w.textsTo(w.sam.address)).toEqual(['#1 With Alex: “Dinner” — Sat Nov 14, 2:00–3:30 PM at “Luigi\'s”. Book it? Reply yes or no.']);
    await w.ownerSays(w.sam, 'yes');
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe('Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.');
    expect(w.calendar.eventsOf(w.sam.owner.id)[0]!.start.toISOString()).toBe('2026-11-14T00:00:00.000Z');
  });

  it('accept-time re-check is instant-based: a busy slot on Sam’s Kolkata calendar stops the accept', async () => {
    w = await createTestWorld();
    await setZone(w, w.sam, 'Asia/Kolkata');
    alexOpens(w);
    envoys(w, DINNER_IST);
    // Sam's Envoy checks first and sees free; the busy event appears before Alex's accept.
    const origOn = w.calendar.freeBusy.bind(w.calendar);
    let calls = 0;
    w.calendar.freeBusy = async (owner, from, to) => {
      calls += 1;
      if (owner === w.sam.owner.id && calls > 1) w.calendar.seed(w.sam.owner.id, { title: 'Late call', start: new Date('2026-11-14T06:00:00+05:30'), end: new Date('2026-11-14T06:30:00+05:30') });
      return origOn(owner, from, to);
    };
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const kinds = (await w.db.query<{ kind: string; body: string }>('SELECT kind, body FROM a2a_messages ORDER BY seq')).rows;
    expect(kinds.map((k) => k.kind)).toContain('system');
    expect(kinds.find((k) => k.kind === 'system')!.body).toBe('That time is no longer free, so nothing was booked.');
    expect(w.textsTo(w.sam.address)).toEqual([]);
  });

  it('responder 7-day clip is an absolute 168 h even when the initiator’s zone changes DST inside it', () => {
    const conv = { window_start: new Date('2026-10-29T00:00:00-04:00'), window_end: new Date('2026-11-28T00:00:00-05:00') } as ConversationRow;
    const responder = effectiveWindow(conv, { role: 'responder' } as SideRow)!;
    const initiator = effectiveWindow(conv, { role: 'initiator' } as SideRow)!;
    expect(responder.end.getTime() - responder.start.getTime()).toBe(7 * 86_400_000);
    expect(initiator.end.toISOString()).toBe(conv.window_end!.toISOString());
  });

  const NOW = new Date('2026-11-12T12:00:00Z');
  it('cross-midnight event in one zone only: compact and full forms keep both dates; fit is checked per zone', () => {
    // 23:30-01:00 in Kolkata = 13:00-14:30 in New York.
    const ev = { title: 'Call', start: '2026-11-13T23:30:00+05:30', end: '2026-11-14T01:00:00+05:30' };
    expect(outcomePrompt({ peer: 'Alex', summary: 's', events: [ev] }, 'Asia/Kolkata', NOW)).toBe('With Alex: “Call” — Fri Nov 13, 11:30 PM – Sat Nov 14, 1:00 AM. Book it?');
    expect(outcomePrompt({ peer: 'Sam', summary: 's', events: [ev] }, 'America/New_York', NOW)).toBe('With Sam: “Call” — Fri Nov 13, 1:00–2:30 PM. Book it?');
    const five = Array.from({ length: 5 }, (_, i) => ({ title: `Event number ${i} with a long title`, start: `2026-11-1${3 + i}T23:30:00+05:30`, end: `2026-11-1${4 + i}T00:45:00+05:30` }));
    for (const tz of ['Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati']) {
      const p = outcomePrompt({ peer: 'Sam', summary: 's', events: five }, tz, NOW);
      if (outcomePromptFits({ peer: 'Sam', summary: 's', events: five }, tz, NOW)) {
        for (let i = 0; i < 5; i += 1) expect(p).toContain(`Event`);
      }
    }
  });

  // EVIDENCE (expected to FAIL): at the fall-back hour two different instants render identically,
  // so the owner's prompt and Booked line cannot say which one a yes books.
  it('DST fall-back in one zone: two different instants must not give the same prompt', () => {
    const edt = { title: 'Call', start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T01:50:00-04:00' }; // 05:30Z
    const est = { title: 'Call', start: '2026-11-01T01:30:00-05:00', end: '2026-11-01T01:50:00-05:00' }; // 06:30Z
    expect(Date.parse(edt.start)).not.toBe(Date.parse(est.start));
    // Corrected by fix group P (RULING P3/P3b): the two lines asserted equal before now differ,
    // because the shared time text shows the UTC offset in the repeated hour.
    const before = new Date('2026-10-30T12:00:00Z');
    const a = outcomePrompt({ peer: 'Sam', summary: 's', events: [edt] }, 'America/New_York', before);
    const b = outcomePrompt({ peer: 'Sam', summary: 's', events: [est] }, 'America/New_York', before);
    expect(a).toBe('With Sam: “Call” — Sun Nov 1, 1:30 AM (UTC-04:00) – Sun Nov 1, 1:50 AM (UTC-04:00). Book it?');
    expect(bookedLine({ summary: 's', events: [edt] }, 'America/New_York', before)).not.toBe(bookedLine({ summary: 's', events: [est] }, 'America/New_York', before));
    expect(b).not.toBe(a);
  });
});
