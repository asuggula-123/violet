/**
 * Final round 1: a joint booking already part done when an owner pauses (a crash between the
 * two calendar writes, or an expiry whose settle did not finish) is failed closed during the
 * pause, without reading or writing the paused owner's calendar (8.6). A booking whose only
 * written half is on the paused owner's own calendar waits for the resume instead. And a
 * delivered approval prompt whose record fails twice is never sent again (I15).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, FRI, honestDinnerEnvoys, onlyConversation } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w?.close());

const failedLines = (address: string) => w.textsTo(address).filter((t) => /^Couldn't book/.test(t));
const bookedLines = (address: string) => w.textsTo(address).filter((t) => /^Booked/.test(t));
const isPaused = async (agentId: string) => (await w.app.repos.agents.get(agentId))!.paused;

/** Every calendar call (read or write) made for an owner while that owner's agent is paused. */
function watchPausedCalendar(): string[] {
  const seen: string[] = [];
  const cal = w.calendar as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ['freeBusy', 'createEvent', 'eventIdForKey', 'deleteEvent']) {
    const orig = cal[name]!.bind(w.calendar);
    cal[name] = async (...args: unknown[]) => {
      const ownerId = args[0] as string;
      const agent = ownerId === w.alex.owner.id ? w.alex.agent.id : w.sam.agent.id;
      if (await isPaused(agent)) seen.push(`${name}:${ownerId === w.alex.owner.id ? 'alex' : 'sam'}`);
      return orig(...args);
    };
  }
  return seen;
}

async function wait(hours: number): Promise<void> {
  for (let h = 0; h < hours; h += 6) await w.advance({ hours: Math.min(6, hours - h) });
}

/** The second yes's booking writes its owner's half, then the worker dies before the other write. */
async function crashAfterFirstWrite(first: 'alex' | 'sam'): Promise<void> {
  w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
  alexOpensDinner(w);
  honestDinnerEnvoys(w);
  await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  const firstYes = first === 'sam' ? w.alex : w.sam; // the earlier yes; the later one books first
  const laterYes = first === 'sam' ? w.sam : w.alex;
  const victim = first === 'sam' ? w.alex : w.sam;
  await w.ownerSays(firstYes, 'yes');
  const victimApproval = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'", [victim.agent.id])).rows[0]!.id;
  const writer = w.app.approvals!.calendar;
  const exec = writer.executeApproved.bind(writer);
  let crashed = false;
  writer.executeApproved = async (id) => {
    if (!crashed && id === victimApproval) {
      crashed = true;
      throw new Error('worker died between the two writes');
    }
    return exec(id);
  };
  await w.ownerSays(laterYes, 'yes');
  expect(crashed).toBe(true);
  expect(w.calendar.eventsOf((first === 'sam' ? w.sam : w.alex).owner.id)).toHaveLength(1);
  expect(w.calendar.eventsOf(victim.owner.id)).toHaveLength(0);
}

describe('final F1: a booking part done when an owner pauses', () => {
  it("Sam's half written, Alex pauses before the retry: Sam's half is undone during the pause, Sam told once, Alex's calendar untouched", async () => {
    await crashAfterFirstWrite('sam');
    const touched = watchPausedCalendar();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await w.advance({ seconds: 10 }); // the hook retry (backoff 1 s), well inside the 2 min claim
    await w.advance({ minutes: 30 }); // the booking sweep runs too
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(failedLines(w.sam.address)[0]).toMatch(/: a calendar didn't accept it\. Nothing was booked\.$/);
    expect(w.textsTo(w.sam.address).join('\n')).not.toMatch(/paused/i);
    expect(failedLines(w.alex.address)).toEqual([]); // Alex's line waits for the resume
    expect(touched).toEqual([]);
    const conv = await onlyConversation(w);
    expect(conv.status).toBe('open');
    await wait(12);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect(failedLines(w.alex.address)).toHaveLength(1);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(0);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(touched).toEqual([]);
  });

  it("Alex's own half written, then Alex pauses: it waits (Alex's calendar is not touched while paused); the resume books it on both", async () => {
    await crashAfterFirstWrite('alex');
    const touched = watchPausedCalendar();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await wait(12);
    expect(touched).toEqual([]);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    expect(failedLines(w.sam.address)).toEqual([]);
    expect(bookedLines(w.sam.address)).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await wait(1);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(1);
    expect(bookedLines(w.sam.address)).toHaveLength(1);
    expect(bookedLines(w.alex.address)).toHaveLength(1);
    expect(touched).toEqual([]);
  });
});

describe('final F1: an expired held booking whose settle failed once, while the owner stays paused', () => {
  it('the booking sweep finishes it during the pause: Sam gets one failure line, nothing read or written', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe('Waiting for Alex.');
    const touched = watchPausedCalendar();
    const write = w.app.actionLog.write.bind(w.app.actionLog);
    let armed = true;
    w.app.actionLog.write = async (entry, q) => {
      if (armed && entry.action === 'a2a.booking_failed') {
        armed = false;
        throw new Error('storage blip in the settle');
      }
      return write(entry, q);
    };
    await wait(4 * 24 + 18); // the dinner has started: the sweep settles it failed, and that settle fails
    await w.advance({ minutes: 30 }); // the next booking sweeps
    expect(armed).toBe(false);
    expect(w.calendar.writes).toEqual([]);
    expect(touched).toEqual([]);
    expect(failedLines(w.sam.address)).toEqual([expect.stringMatching(/the time came before it could be booked\. Nothing was booked\.$/)]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect(failedLines(w.alex.address)).toHaveLength(1);
    expect(failedLines(w.sam.address)).toHaveLength(1);
  });
});

describe('final R: a delivered prompt whose record fails twice', () => {
  it('is never sent again; a later pass records it, and a typed yes directly under it then books it', async () => {
    w = await createTestWorld();
    const tx = w.db.tx.bind(w.db);
    let fails = 0;
    (w.db as { tx: typeof w.db.tx }).tx = (fn) =>
      tx((q) =>
        fn(
          new Proxy(q, {
            get(target, prop, recv) {
              if (prop === 'query') {
                return (sql: string, args?: unknown[]) => {
                  if (fails < 2 && /SET prompt_transport_message_id/.test(sql)) {
                    fails += 1;
                    throw new Error('storage blip');
                  }
                  return (target as { query: (s: string, a?: unknown[]) => unknown }).query(sql, args);
                };
              }
              return Reflect.get(target, prop, recv);
            },
          }) as typeof q,
        ),
      );
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
    expect(fails).toBe(2);
    expect((await w.app.approvals!.get(a.id))!.prompt_transport_message_id).toBeNull();
    await w.advance({ minutes: 30 }); // several sweeps
    expect(w.transport.sent.filter((m) => m.text === a.prompt)).toHaveLength(1);
    const sent = w.transport.sent.find((m) => m.text === a.prompt)!;
    expect((await w.app.approvals!.get(a.id))!.prompt_transport_message_id).toBe(sent.transportMessageId);
    await w.ownerSays(w.alex, 'yes');
    expect((await w.app.approvals!.get(a.id))!.status).toBe('executed');
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
  });
});
