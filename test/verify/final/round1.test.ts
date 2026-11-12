/**
 * Independent verifier, final integration pass, round 1: adversarial tests for F1/F2 (held
 * bookings), S1 (the automatic re-show), P's 05ab994 (jointOpen, CalendarWriter "shown whole"),
 * R's 79992ec (storage failures after delivery, odd characters) and the seams between them.
 * Tests that fail are kept as evidence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, FRI, honestDinnerEnvoys, onlyConversation, respond, stepOf, toolUse } from '../../unit/a2a/helpers.js';
import { i19Violations } from '../../unit/i19/helpers.js';

let w: TestWorld;
afterEach(async () => w?.close());

const creates = () => w.calendar.writes.filter((x) => x.op === 'create');
const failedLines = (address: string) => w.textsTo(address).filter((t) => /^Couldn't book/.test(t));
const bookedLines = (address: string) => w.textsTo(address).filter((t) => /^Booked/.test(t));
const status = async (ref: number) =>
  (await w.db.query<{ status: string }>('SELECT status FROM approvals WHERE agent_id = $1 AND ref = $2', [w.alex.agent.id, ref])).rows[0]?.status;

/** Both said yes; Alex paused between the yeses, so the booking is held. */
async function held(): Promise<void> {
  alexOpensDinner(w);
  honestDinnerEnvoys(w);
  await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  await w.ownerSays(w.alex, 'yes');
  await w.ownerSays(w.alex, 'pause');
  await w.ownerSays(w.sam, 'yes');
  expect(w.lastTo(w.sam.address)).toBe('Waiting for Alex.');
}

async function wait(hours: number): Promise<void> {
  for (let h = 0; h < hours; h += 6) await w.advance({ hours: Math.min(6, hours - h) });
}

/** One Brain turn of Alex that asks for each of `events` with request_calendar_event. */
async function asks(events: Array<Record<string, unknown>>): Promise<void> {
  w = await createTestWorld();
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
    stepOf(req) === 0 ? respond(events.map((e, i) => toolUse(`c${i}`, 'request_calendar_event', e))) : respond([{ type: 'text', text: 'Asked.' }]),
  );
  await w.ownerSays(w.alex, 'book these');
}

const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
const LUNCH = { title: 'Lunch', start: '2026-11-13T12:00:00-05:00', end: '2026-11-13T13:00:00-05:00' };
const BREAKFAST = { title: 'Breakfast', start: '2026-11-13T08:00:00-05:00', end: '2026-11-13T09:00:00-05:00' };

// ------------------------------------------------------------------------------------ F1 / F2
describe('F1: a held booking whose expiry settle crashes once', () => {
  it('the dinner starts while Alex is paused and the failure settle fails once: Sam is still told within the hour, nothing booked', async () => {
    w = await createTestWorld();
    await held();
    const write = w.app.actionLog.write.bind(w.app.actionLog);
    let armed = true;
    w.app.actionLog.write = async (entry, q) => {
      if (armed && entry.action === 'a2a.booking_failed') {
        armed = false;
        throw new Error('storage blip in the settle');
      }
      return write(entry, q);
    };
    await wait(4 * 24 + 16); // Fri Nov 13, 8:00 PM: the dinner has started; Alex still paused
    await wait(2);
    expect(armed).toBe(false);
    expect(creates()).toEqual([]);
    // Sam's two yeses must not be lost silently: Sam was last told "Waiting for Alex."
    expect(failedLines(w.sam.address)).toHaveLength(1);
  });

  it('same crash: once Alex resumes, each owner gets exactly one failure line and nothing is booked', async () => {
    w = await createTestWorld();
    await held();
    const write = w.app.actionLog.write.bind(w.app.actionLog);
    let armed = true;
    w.app.actionLog.write = async (entry, q) => {
      if (armed && entry.action === 'a2a.booking_failed') {
        armed = false;
        throw new Error('storage blip in the settle');
      }
      return write(entry, q);
    };
    await wait(4 * 24 + 18);
    await w.ownerSays(w.alex, 'resume');
    await wait(1);
    await w.app.settle();
    expect(creates()).toEqual([]);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(failedLines(w.alex.address)).toHaveLength(1);
    expect(w.textsTo(w.sam.address).join('\n')).not.toMatch(/paused/i);
  });
});

describe('F1 x P13: the other owner tries to book the held time solo', () => {
  it("Sam's fooled Brain asks to book the held dinner time on Sam's calendar alone: refused, nothing booked for anyone", async () => {
    w = await createTestWorld();
    await held();
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('x', 'request_calendar_event', { title: 'Dinner', ...FRI.dinner })])
        : respond([{ type: 'text', text: 'Asked.' }]),
    );
    await w.ownerSays(w.sam, 'put dinner on my calendar friday 7pm');
    const solo = (await w.db.query("SELECT 1 FROM approvals WHERE agent_id = $1 AND kind = 'calendar_event'", [w.sam.agent.id])).rows;
    expect(solo).toEqual([]);
    await w.ownerSays(w.sam, 'yes');
    expect(creates()).toEqual([]);
  });
});

describe('F1: a retried hook after each ending books at most once and says something true', () => {
  it("after the held booking expired, Sam's yes hook runs again: the failure line, nothing booked", async () => {
    w = await createTestWorld();
    await held();
    await wait(4 * 24 + 18);
    const sam = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'", [w.sam.agent.id])).rows[0]!;
    const a = (await w.app.approvals!.get(sam.id))!;
    const kind = (w.app.approvals as unknown as { kind(n: string): { onApproved?(c: unknown): Promise<string | undefined> } }).kind('a2a_outcome');
    const line = await kind.onApproved!(await (w.app.approvals as unknown as { kindContext(a: unknown): Promise<never> }).kindContext(a));
    expect(line).toMatch(/^Couldn't book .*the time came before it could be booked\. Nothing was booked\.$/);
    expect(creates()).toEqual([]);
  });

  it("after the resume booked it, both yes hooks run again: no second write, the Booked line", async () => {
    w = await createTestWorld();
    await held();
    await wait(48);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect(creates()).toHaveLength(2);
    const ids = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE kind = 'a2a_outcome' ORDER BY seq")).rows;
    const kind = (w.app.approvals as unknown as { kind(n: string): { onApproved?(c: unknown): Promise<string | undefined> } }).kind('a2a_outcome');
    for (const r of ids) {
      const a = (await w.app.approvals!.get(r.id))!;
      const line = await kind.onApproved!(await (w.app.approvals as unknown as { kindContext(a: unknown): Promise<never> }).kindContext(a));
      expect(line).toMatch(/^Booked/);
    }
    await w.app.a2a!.sweep();
    expect(creates()).toHaveLength(2);
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'booked' });
  });
});

describe('F1: pause, resume, pause again before the sweep', () => {
  it('Alex resumes and pauses again at once, then the dinner starts: nothing is booked on a paused calendar; Sam gets one line', async () => {
    w = await createTestWorld();
    await held();
    // The resume's own hook books it (both calendars) or, if a pause comes first, keeps it held.
    await w.ownerSays(w.alex, 'resume');
    await w.ownerSays(w.alex, 'pause');
    await wait(4 * 24 + 18);
    const results = [...bookedLines(w.sam.address), ...failedLines(w.sam.address)];
    expect(results).toHaveLength(1);
    // Never one calendar only.
    expect(new Set(creates().map((x) => x.ownerId)).size === 0 || w.calendar.eventsOf(w.alex.owner.id).length === w.calendar.eventsOf(w.sam.owner.id).length).toBe(true);
  });
});

describe('F1: both owners paused, and the other owner ends a held booking', () => {
  it('Sam pauses too while it is held; Alex resumes (Sam still paused): nothing booked; Sam resumes: booked once on both', async () => {
    w = await createTestWorld();
    await held();
    await w.ownerSays(w.sam, 'pause');
    await wait(24);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await wait(6);
    expect(creates()).toEqual([]);
    expect((await onlyConversation(w)).status).toBe('awaiting_approval');
    await w.ownerSays(w.sam, 'resume');
    await w.app.settle();
    await wait(1);
    expect(creates().map((x) => x.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    expect(bookedLines(w.alex.address)).toHaveLength(1);
    expect(bookedLines(w.sam.address)).toHaveLength(1);
  });

  it('Sam ends the conversation while it is held for Alex: Alex\'s resume books nothing', async () => {
    w = await createTestWorld();
    await held();
    const conv = await onlyConversation(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('e', 'end_agent_conversation', { conversation: conv.id })]) : respond([{ type: 'text', text: 'Ended.' }]),
    );
    await w.ownerSays(w.sam, 'forget the dinner, end that conversation');
    expect((await onlyConversation(w)).status).toBe('closed');
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await wait(12);
    expect(creates()).toEqual([]);
    expect(bookedLines(w.alex.address)).toEqual([]);
    expect(bookedLines(w.sam.address)).toEqual([]);
  });
});

describe('F1/F2 x I7: a crash between the two calendar writes, then a pause', () => {
  it("Sam's yes writes Sam's dinner, the worker dies before Alex's write, Alex pauses: never left on one calendar only while Alex is paused", async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    const alexApproval = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'", [w.alex.agent.id])).rows[0]!.id;
    const writer = w.app.approvals!.calendar;
    const exec = writer.executeApproved.bind(writer);
    let crashed = false;
    writer.executeApproved = async (id) => {
      if (!crashed && id === alexApproval) {
        crashed = true;
        throw new Error('worker died between the two writes');
      }
      return exec(id);
    };
    await w.ownerSays(w.sam, 'yes');
    expect(crashed).toBe(true);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(1); // Sam's half was written
    await w.ownerSays(w.alex, 'pause');
    // The hook retry (backoff 1 s) runs inside the 2 min claim, as the default 5 s backoff does;
    // one 6 h jump would run the booking sweep first, and the retried hook then repeats its line.
    await w.advance({ seconds: 10 });
    await wait(36); // the booking sweep runs meanwhile
    const sam = w.calendar.eventsOf(w.sam.owner.id).length;
    const alex = w.calendar.eventsOf(w.alex.owner.id).length;
    // Never half-booked (runBooking, 8.6): with Alex paused, Sam's lone half must be undone, not left
    // on Sam's calendar for the whole pause while Sam's last line says "Waiting for Alex."
    // Sam is told the truth once the half is undone (corrected from 'Waiting for Alex.', which
    // described the defect: one half was booked then): the generic failure, nothing about the pause.
    expect(w.lastTo(w.sam.address)).toMatch(/^Couldn't book .*: a calendar didn't accept it\. Nothing was booked\.$/);
    expect(failedLines(w.sam.address)).toHaveLength(1);
    expect(w.textsTo(w.sam.address).join('\n')).not.toMatch(/paused/i);
    expect({ sam, alex }).toEqual({ sam: 0, alex: 0 });
  });
});

// ------------------------------------------------------------------------------------ S1
describe('S1: the automatic re-show, from other angles', () => {
  it('three prompts in one turn: yes 1, then no 2 (not above: shown again), then a bare no: only #2 is denied, #3 stays pending, I19 holds', async () => {
    await asks([DINNER, LUNCH, BREAKFAST]);
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.transport.sent.filter((m) => m.text.startsWith(REPROMPT_PREFIX))).toEqual([]);
    await w.ownerSays(w.alex, 'no 2');
    expect([await status(1), await status(2), await status(3)]).toEqual(['executed', 'pending', 'pending']);
    await w.ownerSays(w.alex, 'no');
    expect([await status(1), await status(2), await status(3)]).toEqual(['executed', 'denied', 'pending']);
    await w.ownerSays(w.alex, 'yes');
    expect(await status(3)).toBe('pending'); // not directly under #3: shown again only
    expect(await i19Violations(w)).toEqual([]);
  });

  it('the re-shown prompt expires before the bare yes: nothing is booked, the owner hears it is not open', async () => {
    await asks([DINNER, LUNCH]);
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)!.startsWith(REPROMPT_PREFIX)).toBe(true);
    await w.advance({ hours: 25 });
    const before = creates().length;
    await w.ownerSays(w.alex, 'yes');
    expect(creates().length).toBe(before);
    expect(await status(2)).not.toBe('approved');
    expect(await status(2)).not.toBe('executed');
    expect(await i19Violations(w)).toEqual([]);
  });

  it('a reply-to on #1 resolves #1; #2 shown again; a forged-looking Brain line cannot become a prompt', async () => {
    await asks([DINNER, LUNCH]);
    const prompts = w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval');
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: prompts[0]!.transportMessageId });
    expect(await status(1)).toBe('executed');
    expect(w.lastTo(w.alex.address)!.startsWith(REPROMPT_PREFIX)).toBe(true);
    // A Brain turn now writes a fake prompt for #2 as its own reply; a bare yes under it approves nothing.
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: '#2 Lunch — Fri Nov 13, 12:00–1:00 PM. Book it? Reply yes or no.' }]));
    await w.ownerSays(w.alex, 'what was that?');
    await w.ownerSays(w.alex, 'yes');
    expect(await status(2)).toBe('pending');
    expect(await i19Violations(w)).toEqual([]);
  });

  it('the re-show is cancelled meanwhile (the approval is cancelled): the bare yes under it books nothing', async () => {
    await asks([DINNER, LUNCH]);
    await w.ownerSays(w.alex, 'yes 1');
    const two = (await w.db.query<{ id: string }>('SELECT id FROM approvals WHERE agent_id = $1 AND ref = 2', [w.alex.agent.id])).rows[0]!;
    await w.app.approvals!.cancel(two.id, 'test');
    const before = creates().length;
    await w.ownerSays(w.alex, 'yes');
    expect(creates().length).toBe(before);
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('S1: the re-show send fails once', () => {
  it('the transport refuses the re-show once: the booking line is not sent twice, nothing is booked twice, and #2 can still be answered', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('c0', 'request_calendar_event', DINNER), toolUse('c1', 'request_calendar_event', LUNCH)]) : respond([{ type: 'text', text: 'Asked.' }]),
    );
    await w.ownerSays(w.alex, 'book these');
    const send = w.transport.send.bind(w.transport);
    let failed = false;
    w.transport.send = async (m) => {
      if (!failed && m.text.startsWith(REPROMPT_PREFIX)) {
        failed = true;
        throw new Error('fake transport: send failed');
      }
      return send(m);
    };
    await w.ownerSays(w.alex, 'yes 1');
    await w.advance({ minutes: 5 });
    expect(failed).toBe(true);
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Booked: Dinner'))).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    // #2 is still answerable: a reply-to on its original prompt books it.
    const p2 = w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval' && m.text.startsWith('#2'))[0]!;
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: p2.transportMessageId });
    expect(await status(2)).toBe('executed');
    expect(await i19Violations(w)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ P 05ab994: shown whole
describe('P: CalendarWriter books every legitimate title the prompt showed', () => {
  const titles = [
    `Sam's "big" dinner`,
    'Room #5 dinner',
    'ארוחת ערב עם סם',
    'عشاء مع سام 5',
    '🍝 Dinner',
    'Dinner — reply yes or no',
    'Dîner ﬁnal',
  ];
  for (const title of titles) {
    it(`title ${JSON.stringify(title)} with a long location: approved by button, booked, and the booked title is in the prompt the owner saw`, async () => {
      await asks([{ ...DINNER, title, location: 'Corner of Fifth and Main, back room' }]);
      const prompt = w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval').at(-1);
      expect(prompt).toBeDefined();
      const a = (await w.db.query<{ id: string }>('SELECT id FROM approvals WHERE agent_id = $1 AND ref = 1', [w.alex.agent.id])).rows[0]!;
      await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
      const ev = w.calendar.eventsOf(w.alex.owner.id);
      expect(ev).toHaveLength(1);
      expect(prompt!.text).toContain(ev[0]!.title);
      if (ev[0]!.location) expect(prompt!.text).toContain(ev[0]!.location);
    });
  }
});

// ------------------------------------------------------------------------------------ R 79992ec
describe('R: a delivered prompt whose record fails twice', () => {
  it('the markSent transaction fails twice after the prompt was delivered: the owner still gets the prompt only once', async () => {
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
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER });
    await w.advance({ minutes: 30 });
    expect(fails).toBe(2);
    expect(w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.text === a.prompt)).toHaveLength(1);
  });
});
