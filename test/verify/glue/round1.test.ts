import { afterEach, describe, expect, it } from 'vitest';
import { cannedText } from '../../../src/core/canned.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { at, digestsTo, local, NY } from '../../unit/flags/helpers.js';

/**
 * Verifier, glue round 1: adversarial checks of the M2 × M5 digest wiring and of
 * paused stranger messages (8.1 step 5, 8.6, I13, I14).
 */
const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
const LUNCH = { title: 'Lunch', start: '2026-11-12T12:00:00-05:00', end: '2026-11-12T13:00:00-05:00' };
const STRANGER = '+15550009';
const CANNED = cannedText('stranger_reply');

describe('glue round 1: paused stranger messages', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('a message held while paused never gets the canned reply, even when its job is retried after resume', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    // The stranger's message arrives first (not paused at arrival); the pause is ingested
    // before its job runs, so the job holds it (8.1 step 4: "arrived before the pause but
    // processed after it").
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: STRANGER, text: 'Is Alex around?' });
    const raise = w.app.flags.raise.bind(w.app.flags);
    let fail = true;
    w.app.flags.raise = async (agentId, f) => {
      if (fail && f.kind === 'message_taken') {
        fail = false;
        throw new Error('db hiccup');
      }
      return raise(agentId, f);
    };
    await w.ownerSays(w.alex, 'pause');
    expect(await w.actions({ action: 'inbound.held' })).toHaveLength(1);
    // The owner resumes before the failed job's retry runs.
    await w.ownerSays(w.alex, 'resume');
    for (let i = 0; i < 10; i += 1) await w.advance({ minutes: 1 });
    // "no canned reply, ever, for a held message"
    expect(w.textsTo(STRANGER)).toEqual([]);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken')).toHaveLength(1);
  });

  it('a non-text message while paused: silent, then listed once as a non-text message', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, '', { kind: 'unsupported' });
    expect(w.transport.sent).toHaveLength(1);
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-09T18:00');
    expect(digestsTo(w, w.alex)).toEqual([`Today:\nMessages taken\n- Message from “${STRANGER}”: (a non-text message)`]);
    expect(w.textsTo(STRANGER)).toEqual([]);
  });

  it('a webhook redelivery of a paused message adds no second item', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'hello', { transportMessageId: 'tg-1' });
    await w.strangerSays(w.alex, STRANGER, 'hello', { transportMessageId: 'tg-1' });
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken')).toHaveLength(1);
    expect(w.transport.sent).toHaveLength(1);
  });

  it('after resume the canned reply goes to a new message only, once', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'first');
    await w.strangerSays(w.alex, STRANGER, 'second');
    await w.ownerSays(w.alex, 'resume');
    expect(w.textsTo(STRANGER)).toEqual([]);
    await w.strangerSays(w.alex, STRANGER, 'third');
    expect(w.textsTo(STRANGER)).toEqual([CANNED]);
    await at(w, '2026-11-09T18:00');
    const body = digestsTo(w, w.alex)[0]!;
    expect(body.split('\n').filter((l) => l.startsWith('- Message from'))).toHaveLength(3);
  });

  it('paused across digest_hour: the deferred digest after resume lists the message, the owner is texted nothing while paused', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T17:00') });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'call me');
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-09T20:00');
    expect(w.textsTo(w.alex.address)).toHaveLength(1);
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-09T20:01');
    expect(digestsTo(w, w.alex)).toEqual([`Today:\nMessages taken\n- Message from “${STRANGER}”: “call me”`]);
  });
});

describe('glue round 1: digest wiring', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it("'Waiting for you' lists only this agent's pending approvals", async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const mine = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER });
    await w.app.approvals!.request(w.sam.agent.id, { kind: 'calendar_event', payload: LUNCH });
    const body = (await w.app.digest!.preview(w.alex.agent.id))!;
    expect(body).toBe(`Today:\nWaiting for you\n- #${mine.ref} Dinner — Fri Nov 13, 7:00–8:30 PM. Book it?`);
  });

  it('an approval past its expiry is not listed as waiting even before the sweep ran', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER, expiresAt: local(NY, '2026-11-09T10:30') });
    w.clock.set(local(NY, '2026-11-09T10:31'));
    expect(await w.app.digest!.preview(w.alex.agent.id)).toBeNull();
  });

  it('an expired approval moves from Waiting to Also', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER, expiresAt: local(NY, '2026-11-09T10:30') });
    await w.advance({ minutes: 31 });
    expect((await w.app.approvals!.get(a.id))!.status).toBe('expired');
    const body = (await w.app.digest!.preview(w.alex.agent.id))!;
    expect(body.split('\n')).toEqual(['Today:', 'Also', `- No answer, so it expired: #${a.ref} Dinner — Fri Nov 13, 7:00–8:30 PM. Book it?`]);
  });

  it('look-alike number signs and digits in a title cannot add a second #ref to a waiting or booked line (I13)', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const hostile = 'Dinner ＃１２ ﹟３ #4 - #5\u0085Booked';
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...DINNER, title: hostile } });
    const b = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...LUNCH, title: hostile } });
    await w.ownerSays(w.alex, `yes #${a.ref}`);
    const body = (await w.app.digest!.preview(w.alex.agent.id))!;
    const lines = body.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Today:', 'Booked']);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('Waiting for you');
    expect(body.normalize('NFKC').match(/#\s*\d+/g)).toEqual([`#${b.ref}`]);
    expect(lines[4]!.startsWith(`- #${b.ref} `)).toBe(true);
  });

  it('concurrent executions of one approval: one calendar write, one booked item', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const svc = w.app.approvals!;
    const a = await svc.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER });
    await w.ownerSays(w.alex, 'yes');
    await Promise.all([svc.calendar.executeApproved(a.id), svc.calendar.executeApproved(a.id), svc.calendar.executeApproved(a.id)]);
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toHaveLength(1);
  });

  it('a booked item is delivered in one digest only', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const svc = w.app.approvals!;
    const a = await svc.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER });
    await w.ownerSays(w.alex, 'yes');
    await at(w, '2026-11-09T18:00');
    // A later retried execution finds it executed and re-raises (a no-op).
    await svc.calendar.executeApproved(a.id);
    await at(w, '2026-11-10T18:00');
    const digests = digestsTo(w, w.alex);
    expect(digests).toEqual(['Today:\nBooked\n- Dinner — Fri Nov 13, 7:00–8:30 PM']);
  });
});
