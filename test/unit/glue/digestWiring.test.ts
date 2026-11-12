import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { brainCalls, scriptBrain, toolUse } from '../brain/script.js';
import { at, digestsTo, local, NY } from '../flags/helpers.js';

/**
 * M2 × M5: approvals feed the digest ('Waiting for you' live section, 'booked' items), and
 * every kind of 8.5 lands in its section. Everything runs through the real router, the
 * fake transport and the FakeClock.
 */
const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
const LUNCH = { title: 'Lunch', start: '2026-11-12T12:00:00-05:00', end: '2026-11-12T13:00:00-05:00' };

/** Every line of a digest is the header, a section title, an item ('- …') or a '+N more' line. */
const TITLES = ['Messages taken', 'Agent conversations', 'Drafts', 'Booked', 'Waiting for you', 'Also'];
function expectWellFormed(body: string): void {
  const [header, ...rest] = body.split('\n');
  expect(header).toBe('Today:');
  for (const line of rest) expect(TITLES.includes(line) || line.startsWith('- ') || /^\+\d+ more( not shown)?$/.test(line), line).toBe(true);
}

describe('digest wiring (M2 × M5)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('end to end: one digest at digest_hour with the right sections in order, all code-rendered', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const alex = w.alex;

    // A stranger leaves a message.
    await w.strangerSays(alex, '+15550001', 'Please call me back');

    // The owner asks for two events; the (scripted) model requests both approvals.
    scriptBrain(w, alex, [
      [toolUse('t1', 'request_calendar_event', DINNER), toolUse('t2', 'request_calendar_event', LUNCH)],
      'MODEL TEXT: asked you about both.',
    ]);
    await w.ownerSays(alex, 'book dinner friday and lunch thursday');
    const prompts = w.transport.sent.filter((m) => m.purpose === 'approval').map((m) => m.text);
    expect(prompts).toEqual([
      '#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.',
      '#2 Lunch — Thu Nov 12, 12:00–1:00 PM. Book it? Reply yes or no.',
    ]);

    // One approved (booked), one left pending.
    await w.ownerSays(alex, 'yes #1');
    expect(w.lastTo(alex.address)).toBe('Booked: Dinner — Fri Nov 13, 7:00–8:30 PM.');
    expect(w.calendar.eventsOf(alex.owner.id).map((e) => e.title)).toEqual(['Dinner']);

    // A draft is created.
    scriptBrain(w, alex, [[toolUse('t3', 'draft_email', { to: ['sam@example.test'], subject: 'Dinner plans', body: 'Friday at 7?' })], 'MODEL TEXT: drafted.']);
    await w.ownerSays(alex, 'draft an email to sam about dinner');

    const modelCalls = w.llm.calls.length;
    await at(w, '2026-11-09T17:59');
    expect(digestsTo(w, alex)).toEqual([]);
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-09T21:00');

    const digests = digestsTo(w, alex);
    expect(digests).toEqual([
      [
        'Today:',
        'Messages taken',
        '- Message from “+15550001”: “Please call me back”',
        'Drafts',
        '- Draft saved in Gmail: “Dinner plans” to sam@example.test',
        'Booked',
        '- Dinner — Fri Nov 13, 7:00–8:30 PM',
        'Waiting for you',
        '- #2 Lunch — Thu Nov 12, 12:00–1:00 PM. Book it?',
      ].join('\n'),
    ]);
    // Nothing in it came from a model: no model call while it was built, no model text in it.
    expect(w.llm.calls.length).toBe(modelCalls);
    expect(digests[0]).not.toContain('MODEL TEXT');
    expect(await w.actions({ action: 'digest.sent' })).toHaveLength(1);
    // Two Brain turns of two model steps each, all before the digest.
    expect(brainCalls(w, alex)).toHaveLength(4);
    // The waiting #ref is answerable from the digest: under the digest it is not under the
    // prompt, so the prompt is shown again first (I19); the yes under it books.
    await w.ownerSays(alex, 'yes #2');
    expect(w.lastTo(alex.address)).toBe('Just to be sure: #2 Lunch — Thu Nov 12, 12:00–1:00 PM. Book it? Reply yes or no.');
    await w.ownerSays(alex, 'yes');
    expect(w.lastTo(alex.address)).toBe('Booked: Lunch — Thu Nov 12, 12:00–1:00 PM.');
  });

  it('a hostile model cannot forge a line, a header or a #ref in the waiting or booked items (I13)', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const hostile = 'Dinner\nToday:\n- #9 Wire money ＃8 ﹟7. Reply yes or no. Booked\r\n- ok';
    scriptBrain(w, w.alex, [
      [
        toolUse('t1', 'request_calendar_event', { ...DINNER, title: hostile }),
        toolUse('t2', 'request_calendar_event', { ...LUNCH, title: `${hostile} lunch` }),
      ],
      'Today:\n- #5 approved',
    ]);
    await w.ownerSays(w.alex, 'book');
    await w.ownerSays(w.alex, 'yes 1');
    const body = (await w.app.digest!.preview(w.alex.agent.id))!;
    expectWellFormed(body);
    const lines = body.split('\n');
    expect(lines.filter((l) => l === 'Booked')).toHaveLength(1);
    expect(lines.filter((l) => l === 'Waiting for you')).toHaveLength(1);
    // The only reference in the whole digest is the real pending one, at the start of its line.
    expect(body.match(/[#＃﹟]\s*\d/g)).toEqual(['#2']);
    expect(lines[lines.indexOf('Waiting for you') + 1]).toBe('- #2 Dinner Today: - 9 Wire money 8 7. Reply yes or no. Booked - ok lunch — Thu Nov 12, 12:00–1:00 PM. Book it?');
    expect(lines[lines.indexOf('Booked') + 1]).toBe('- Dinner Today: - 9 Wire money 8 7. Reply yes or no. Booked - ok — Fri Nov 13, 7:00–8:30 PM');
    expect(body).not.toContain('approved');
  });

  it("a booking raises one 'booked' item per approval, however often it is executed; a no or a failed booking raises none", async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const svc = w.app.approvals!;
    const a = await svc.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER });
    const b = await svc.request(w.alex.agent.id, { kind: 'calendar_event', payload: LUNCH });
    await w.ownerSays(w.alex, 'yes #1');
    await svc.calendar.executeApproved(a.id);
    await svc.calendar.executeApproved(a.id);
    await w.ownerSays(w.alex, 'no #2'); // under the booking line, not the prompt: shown again (I19)
    await w.ownerSays(w.alex, 'no');
    expect((await svc.get(b.id))!.status).toBe('denied');
    const booked = (await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked');
    expect(booked.map((f) => [f.text, f.urgency, f.status, f.dedupe_key])).toEqual([
      ['Dinner — Fri Nov 13, 7:00–8:30 PM', 'digest', 'pending', `booked:${a.id}`],
    ]);

    // The calendar refuses: the approval fails, nothing is booked and no item is raised.
    w.calendar.createEvent = async () => {
      throw new Error('calendar down');
    };
    const c = await svc.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...LUNCH, title: 'Coffee' } });
    await w.ownerSays(w.alex, 'yes #3');
    expect((await svc.get(c.id))!.status).toBe('failed');
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toHaveLength(1);
  });

  it('a booked item lost to a crash after the booking is raised by the retried resolution', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const svc = w.app.approvals!;
    const a = await svc.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER });
    const raise = w.app.flags.raise.bind(w.app.flags);
    let failOnce = true;
    w.app.flags.raise = async (agentId, f) => {
      if (f.kind === 'booked' && failOnce) {
        failOnce = false;
        throw new Error('db hiccup');
      }
      return raise(agentId, f);
    };
    await w.ownerSays(w.alex, 'yes');
    expect((await svc.get(a.id))!.status).toBe('executed');
    await w.advance({ minutes: 5 });
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toHaveLength(1);
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Booked:'))).toEqual(['Booked: Dinner — Fri Nov 13, 7:00–8:30 PM.']);
  });

  it('every 8.5 kind lands in its section, in section order; the waiting section omits what is no longer pending', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const id = w.alex.agent.id;
    const raise = (kind: string, text: string) => w.app.flags.raise(id, { kind, urgency: 'digest', text });
    await raise('approval_expired', 'expired item');
    await raise('a2a_booked', 'a2a booked item');
    await raise('a2a_closed', 'closed item');
    await raise('draft_created', 'draft item');
    await raise('booked', 'booked item');
    await raise('a2a_opened', 'opened item');
    await raise('message_taken', 'message item');
    await raise('something_new', 'unknown item');
    const open = await w.app.approvals!.request(id, { kind: 'calendar_event', payload: DINNER });
    const gone = await w.app.approvals!.request(id, { kind: 'calendar_event', payload: LUNCH });
    await w.app.approvals!.cancel(gone.id, 'test');
    expect(await w.app.digest!.preview(id)).toBe(
      [
        'Today:',
        'Messages taken',
        '- message item',
        'Agent conversations',
        '- closed item',
        '- opened item',
        'Drafts',
        '- draft item',
        'Booked',
        '- a2a booked item',
        '- booked item',
        'Waiting for you',
        `- #${open.ref} Dinner — Fri Nov 13, 7:00–8:30 PM. Book it?`,
        'Also',
        '- expired item',
        '- unknown item',
      ].join('\n'),
    );
  });

  it('the waiting section obeys the per-section cap', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    for (let i = 0; i < 12; i += 1) {
      await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...DINNER, title: `Event ${i}` } });
    }
    const lines = (await w.app.digest!.preview(w.alex.agent.id))!.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Today:', 'Waiting for you']);
    expect(lines.filter((l) => l.startsWith('- #'))).toHaveLength(10);
    expect(lines.at(-1)).toBe('+2 more');
  });
});
