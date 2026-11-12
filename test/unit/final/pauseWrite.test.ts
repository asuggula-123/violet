/**
 * F2: the pause is checked again right before each calendar write (CalendarWriter), for a solo
 * `calendar_event` and for each side of a joint booking. A write refused this way while nothing
 * of the booking is written is held (booked on the resume), never written while paused. One
 * refused after a write fails closed and undoes what was written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, contextOf, dinnerEvent, FRI, honestDinnerEnvoys, peerProposalSeq, scriptEnvoy, toolUse } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const creates = () => w.calendar.writes.filter((x) => x.op === 'create');
const isPaused = async (agentId: string) => (await w.app.repos.agents.get(agentId))!.paused;
const pause = (p: typeof w.alex) => w.inbound({ agentAddress: p.agentAddress, fromAddress: p.address, text: 'pause' });

/** Records every create made while its owner's agent is paused. */
function watchWrites(): string[] {
  const whilePaused: string[] = [];
  const orig = w.calendar.createEvent.bind(w.calendar);
  w.calendar.createEvent = async (ownerId, ev, key) => {
    const agent = ownerId === w.alex.owner.id ? w.alex.agent.id : w.sam.agent.id;
    if (await isPaused(agent)) whilePaused.push(`${ownerId}:${ev.title}`);
    return orig(ownerId, ev, key);
  };
  return whilePaused;
}

describe('F2: a pause that commits just before the calendar write', () => {
  it('solo calendar_event: the pause lands between the yes and the write: held, nothing written; booked once on resume', async () => {
    w = await createTestWorld();
    const whilePaused = watchWrites();
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
    const svc = w.app.approvals! as unknown as { kindContext: (x: unknown) => Promise<unknown> };
    const kindContext = svc.kindContext.bind(svc);
    let armed = true;
    svc.kindContext = async (x) => {
      if (armed) {
        armed = false;
        await pause(w.alex); // ingested (and committed) right before the write
      }
      return kindContext(x);
    };
    await w.ownerSays(w.alex, 'yes');
    expect(creates()).toEqual([]);
    expect((await w.app.approvals!.get(a.id))!.status).toBe('approved');
    await w.advance({ hours: 2 });
    expect(creates()).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.ownerSays(w.alex, 'resume'); // a second resume (no change) books nothing more
    expect(creates()).toHaveLength(1);
    expect(whilePaused).toEqual([]);
    expect((await w.app.approvals!.get(a.id))!.status).toBe('executed');
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Booked: Dinner'))).toEqual(['Booked: Dinner — Fri Nov 13, 7:00–8:30 PM.']);
  });

  it('joint booking: the booker is paused inside its guard read: held (not failed); booked once on both after the resume', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    const whilePaused = watchWrites();
    const freeBusy = w.calendar.freeBusy.bind(w.calendar);
    let armed = true;
    w.calendar.freeBusy = async (ownerId, from, to) => {
      if (armed && ownerId === w.sam.owner.id) {
        armed = false;
        await pause(w.sam);
      }
      return freeBusy(ownerId, from, to);
    };
    await w.ownerSays(w.sam, 'yes'); // Sam's yes books: Sam's guard reads Sam's free/busy
    expect(creates()).toEqual([]);
    expect(w.textsTo(w.alex.address).filter((t) => /^Couldn't book|^Booked/.test(t))).toEqual([]);
    const statuses = (await w.db.query<{ status: string }>("SELECT status FROM approvals WHERE kind = 'a2a_outcome' ORDER BY seq")).rows.map((r) => r.status);
    expect(statuses).toEqual(['approved', 'approved']);
    await w.ownerSays(w.sam, 'resume');
    await w.app.a2a!.sweep();
    await w.app.settle();
    expect(creates().map((x) => x.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    expect(whilePaused).toEqual([]);
    expect(w.textsTo(w.alex.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
    expect(w.textsTo(w.sam.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
  });

  it("joint booking, two events on Sam's calendar: Sam pauses during the first write: the second is never written, nothing is left on any calendar", async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    // Sam's Envoy proposes two events: dinner on both calendars, then drinks on Sam's only.
    const drinks = { title: 'Drinks', start: '2026-11-13T21:00:00-05:00', end: '2026-11-13T22:00:00-05:00', calendars: 'mine' };
    scriptEnvoy(w, w.sam, (req) =>
      peerProposalSeq(req) === null && !/You proposed/.test(contextOf(req))
        ? [[toolUse('s2', 'propose', { summary: 'Dinner and drinks on Friday', events: [dinnerEvent(), drinks] })], 'done']
        : ['nothing to add'],
    );
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    const whilePaused = watchWrites();
    const createEvent = w.calendar.createEvent.bind(w.calendar);
    let armed = true;
    w.calendar.createEvent = async (ownerId, ev, key) => {
      if (armed && ownerId === w.sam.owner.id) {
        armed = false;
        const out = await createEvent(ownerId, ev, key);
        await pause(w.sam); // lands right after Sam's first write, before the second
        return out;
      }
      return createEvent(ownerId, ev, key);
    };
    await w.ownerSays(w.sam, 'yes');
    expect(whilePaused).toEqual([]);
    expect(creates().map((x) => (x.op === 'create' ? x.event.title : ''))).toEqual(['Dinner']); // the drinks were never written
    expect(w.calendar.eventsOf(w.sam.owner.id)).toEqual([]); // the dinner was undone
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([]);
    expect(w.textsTo(w.alex.address).at(-1)).toMatch(/^Couldn't book .*: a calendar didn't accept it\. Nothing was booked\.$/);
  });
});
