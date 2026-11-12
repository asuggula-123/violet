/**
 * Independent verifier, final integration pass, round 2: adversarial tests for the round 1
 * fixes (b4c4eee): a part-done joint booking failed closed during a pause (claim `closing`,
 * closePaused), and a delivered prompt whose record fails twice (unrecorded map, holdSend).
 * Tests that fail are kept as evidence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, FRI, honestDinnerEnvoys, onlyConversation, respond, stepOf, toolUse } from '../../unit/a2a/helpers.js';
import { i19Violations } from '../../unit/i19/helpers.js';

let w: TestWorld;
afterEach(async () => w?.close());

const failedLines = (address: string) => w.textsTo(address).filter((t) => /^Couldn't book/.test(t));
const bookedLines = (address: string) => w.textsTo(address).filter((t) => /^Booked/.test(t));
const isPaused = async (agentId: string) => (await w.app.repos.agents.get(agentId))!.paused;

async function wait(hours: number): Promise<void> {
  for (let h = 0; h < hours; h += 6) await w.advance({ hours: Math.min(6, hours - h) });
}

/** Every calendar call made for an owner while that owner's agent is paused. */
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

/**
 * `booker` says yes second (its half is written first), then the worker dies before the other
 * owner's write. Returns nothing; asserts the half-booking.
 */
async function crashBetweenWrites(booker: 'alex' | 'sam', opts: { backoffMs?: number } = {}): Promise<void> {
  w = await createTestWorld(opts.backoffMs ? { jobs: { backoffMs: () => opts.backoffMs! } } : {});
  alexOpensDinner(w);
  honestDinnerEnvoys(w);
  await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  const first = booker === 'sam' ? w.alex : w.sam;
  const later = booker === 'sam' ? w.sam : w.alex;
  await w.ownerSays(first, 'yes');
  const victimId = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'", [first.agent.id])).rows[0]!.id;
  const writer = w.app.approvals!.calendar;
  const exec = writer.executeApproved.bind(writer);
  let crashed = false;
  writer.executeApproved = async (id) => {
    if (!crashed && id === victimId) {
      crashed = true;
      throw new Error('worker died between the two writes');
    }
    return exec(id);
  };
  await w.ownerSays(later, 'yes');
  expect(crashed).toBe(true);
  expect(w.calendar.eventsOf(later.owner.id)).toHaveLength(1);
  expect(w.calendar.eventsOf(first.owner.id)).toHaveLength(0);
}

describe('round 2 F1: part-done booking, the other side pauses', () => {
  it("Alex's half written (Alex booked), Sam pauses: Alex's half is undone during Sam's pause, Alex told once, Sam's calendar untouched", async () => {
    await crashBetweenWrites('alex', { backoffMs: 1_000 });
    const touched = watchPausedCalendar();
    await w.inbound({ agentAddress: w.sam.agentAddress, fromAddress: w.sam.address, text: 'pause' });
    await w.advance({ seconds: 10 });
    await w.advance({ minutes: 30 });
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(0);
    expect(failedLines(w.alex.address)).toHaveLength(1);
    expect(w.textsTo(w.alex.address).join('\n')).not.toMatch(/paused/i);
    expect(failedLines(w.sam.address)).toEqual([]);
    expect(touched).toEqual([]);
    await w.ownerSays(w.sam, 'resume');
    await w.app.settle();
    await wait(1);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(failedLines(w.alex.address)).toHaveLength(1);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(0);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(touched).toEqual([]);
  });

  it("Sam's half written, both owners pause (Alex, then Sam): it waits; Sam resumes first: Sam's half undone, Sam told once; Alex resumes: told once, nothing booked", async () => {
    await crashBetweenWrites('sam', { backoffMs: 1_000 });
    const touched = watchPausedCalendar();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await w.inbound({ agentAddress: w.sam.agentAddress, fromAddress: w.sam.address, text: 'pause' });
    await w.advance({ seconds: 10 });
    await wait(6);
    expect(touched).toEqual([]);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(1); // Sam's own half, Sam paused: untouched
    await w.ownerSays(w.sam, 'resume');
    await w.app.settle();
    await w.advance({ minutes: 30 });
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(failedLines(w.sam.address).join('\n')).not.toMatch(/paused|Alex/i);
    expect(failedLines(w.alex.address)).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await wait(1);
    expect(failedLines(w.alex.address)).toHaveLength(1);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(0);
    expect(touched).toEqual([]);
  });

  it("Sam's half written, Alex pauses, and the undo of Sam's half fails once: the sweep finishes it during the pause; never left on Sam's calendar, Alex untouched", async () => {
    await crashBetweenWrites('sam', { backoffMs: 1_000 });
    const touched = watchPausedCalendar();
    const cal = w.calendar as unknown as { deleteEvent: (...a: unknown[]) => Promise<unknown> };
    const del = cal.deleteEvent.bind(w.calendar);
    let blips = 1;
    cal.deleteEvent = async (...a: unknown[]) => {
      if (blips > 0) {
        blips -= 1;
        throw new Error('calendar blip on delete');
      }
      return del(...a);
    };
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await w.advance({ seconds: 10 });
    await w.advance({ minutes: 30 });
    await w.advance({ minutes: 30 });
    expect(blips).toBe(0);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(failedLines(w.sam.address).length).toBeGreaterThanOrEqual(1);
    const last = w.lastTo(w.sam.address);
    expect(last).toMatch(/^Couldn't book .*Nothing was booked\.$/);
    expect(w.textsTo(w.sam.address).join('\n')).not.toMatch(/paused|Alex's calendar/i);
    expect(touched).toEqual([]);
    expect((await onlyConversation(w)).status).toBe('open');
  });

  it("Sam's half written, Alex pauses, then Sam ends the conversation: Sam's half is undone, nothing booked, Alex untouched, nobody booked on resume", async () => {
    await crashBetweenWrites('sam', { backoffMs: 60_000 });
    const touched = watchPausedCalendar();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    const conv = await onlyConversation(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('e', 'end_agent_conversation', { conversation: conv.id })]) : respond([{ type: 'text', text: 'Ended.' }]),
    );
    await w.ownerSays(w.sam, 'forget the dinner, end that conversation');
    await w.advance({ minutes: 5 });
    await w.advance({ minutes: 30 });
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(touched).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await wait(12);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(0);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(bookedLines(w.alex.address)).toEqual([]);
    expect(bookedLines(w.sam.address)).toEqual([]);
  });

  it("Sam's half written, Alex pauses and resumes inside the claim: the hook retry books Alex's half; both get one Booked line", async () => {
    await crashBetweenWrites('sam', { backoffMs: 30_000 });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await w.ownerSays(w.alex, 'resume');
    await w.advance({ minutes: 1 });
    await w.advance({ minutes: 30 });
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(1);
    expect(bookedLines(w.alex.address)).toHaveLength(1);
    expect(bookedLines(w.sam.address)).toHaveLength(1);
    expect(failedLines(w.sam.address)).toEqual([]);
  });

  it("Sam's half written, Alex pauses; the hook keeps failing past the 2 min claim, so the sweep closes it first: Sam is told the failure once, not twice", async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 50_000 } });
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    const alexId = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'", [w.alex.agent.id])).rows[0]!.id;
    const writer = w.app.approvals!.calendar;
    const exec = writer.executeApproved.bind(writer);
    let crashes = 0;
    writer.executeApproved = async (id) => {
      if (id === alexId && crashes < 1) {
        crashes += 1;
        throw new Error('worker died between the two writes');
      }
      return exec(id);
    };
    await w.ownerSays(w.sam, 'yes');
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    // The retry (50 s, then 100 s ...) only comes back after the claim has lapsed and a sweep ran.
    for (let i = 0; i < 12; i += 1) await w.advance({ seconds: 30 });
    await w.advance({ minutes: 30 });
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(0);
    expect(failedLines(w.sam.address)).toHaveLength(1);
  });
});

describe('round 2 R: a delivered prompt whose record fails twice, and I19', () => {
  /** Makes the next `n` markSent statements of any transaction fail. */
  function failMarkSent(n: number): () => number {
    const tx = w.db.tx.bind(w.db);
    let fails = 0;
    (w.db as { tx: typeof w.db.tx }).tx = (fn) =>
      tx((q) =>
        fn(
          new Proxy(q, {
            get(target, prop, recv) {
              if (prop === 'query') {
                return (sql: string, args?: unknown[]) => {
                  if (fails < n && /SET prompt_transport_message_id/.test(sql)) {
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
    return () => fails;
  }

  it('#1 recorded, #2 delivered but its record fails twice (and stays failing): a bare yes right under #2 resolves neither, and #1 is never booked by it', async () => {
    w = await createTestWorld();
    const one = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Lunch', start: '2026-11-13T12:00:00-05:00', end: '2026-11-13T13:00:00-05:00' } });
    expect((await w.app.approvals!.get(one.id))!.prompt_transport_message_id).not.toBeNull();
    const fails = failMarkSent(1000);
    const two = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
    expect(fails()).toBe(2);
    await w.ownerSays(w.alex, 'yes');
    expect((await w.app.approvals!.get(one.id))!.status).toBe('pending');
    expect(['pending']).toContain((await w.app.approvals!.get(two.id))!.status);
    expect(w.calendar.writes).toEqual([]);
    expect(await i19Violations(w)).toEqual([]);
    // The prompt of #2 itself went out once only, whatever the sweeps and the re-prompt did.
    await w.advance({ minutes: 30 });
    const twos = w.transport.sent.filter((m) => m.text === two.prompt);
    expect(twos.length).toBeGreaterThanOrEqual(1);
  });

  it('record fails twice, then the owner pauses and resumes: the resume does not send the prompt again', async () => {
    w = await createTestWorld();
    const fails = failMarkSent(2);
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
    expect(fails()).toBe(2);
    await w.ownerSays(w.alex, 'pause');
    await w.advance({ minutes: 10 });
    await w.ownerSays(w.alex, 'resume');
    await w.advance({ minutes: 30 });
    expect(w.transport.sent.filter((m) => m.text === a.prompt)).toHaveLength(1);
    expect((await w.app.approvals!.get(a.id))!.prompt_transport_message_id).not.toBeNull();
  });

  it('a model-written title with a lone surrogate (as with NUL, which is dropped): made storable, prompt sent, not an internal tool failure', async () => {
    w = await createTestWorld();
    let result = '';
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      if (stepOf(req) === 0) return respond([toolUse('c', 'request_calendar_event', { title: 'Din\u0000ner \uD800 x', ...FRI.dinner })]);
      result = JSON.stringify(req.messages.at(-1));
      return respond([{ type: 'text', text: 'Asked.' }]);
    });
    await w.ownerSays(w.alex, 'book dinner friday');
    // Every action leaves a log row, whatever happens to the tool.
    const tool = (await w.db.query("SELECT 1 FROM action_log WHERE agent_id = $1 AND action = 'tool.call'", [w.alex.agent.id])).rows;
    expect(tool).toHaveLength(1);
    // The approval INSERT stores the payload as jsonb, which rejects a lone surrogate:
    // canonicalEventText drops NUL and turns U+D800 into U+FFFD, so the tool does not fail.
    expect(result).not.toMatch(/That tool failed/);
    const rows = (await w.db.query("SELECT 1 FROM approvals WHERE agent_id = $1 AND kind = 'calendar_event'", [w.alex.agent.id])).rows;
    expect(rows).toHaveLength(1);
  });
});
