import { afterEach, describe, expect, it } from 'vitest';
import { cannedText } from '../../../src/core/canned.js';
import { SECTION_LINE_CAP } from '../../../src/flags/render.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { at, digestsTo, local, NY } from '../../unit/flags/helpers.js';

/**
 * Verifier, glue round 2: adversarial checks of the M2 × M5 digest wiring and of paused
 * stranger messages (8.1 step 5, 8.3 booked items, 8.5, 8.6, I13, I14, I18).
 */
const STRANGER = '+15550011';
const CANNED = cannedText('stranger_reply');

function event(day: number, hour: number, title = 'Dinner') {
  const d = String(day).padStart(2, '0');
  const h = String(hour).padStart(2, '0');
  const h2 = String(hour + 1).padStart(2, '0');
  return { title, start: `2026-11-${d}T${h}:00:00-05:00`, end: `2026-11-${d}T${h2}:00:00-05:00` };
}

async function messageTakenFlags(w: TestWorld) {
  return (await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken');
}

describe('glue round 2: paused stranger messages', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('arrived while paused, flag step fails, owner resumes before the retry: still no canned reply, one digest line', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.ownerSays(w.alex, 'pause');
    const raise = w.app.flags.raise.bind(w.app.flags);
    let fail = true;
    w.app.flags.raise = async (agentId, f) => {
      if (fail && f.kind === 'message_taken') {
        fail = false;
        throw new Error('db hiccup');
      }
      return raise(agentId, f);
    };
    await w.strangerSays(w.alex, STRANGER, 'Is Alex around?');
    await w.ownerSays(w.alex, 'resume');
    for (let i = 0; i < 10; i += 1) await w.advance({ minutes: 1 });
    expect(w.textsTo(STRANGER)).toEqual([]);
    expect(await messageTakenFlags(w)).toHaveLength(1);
    await at(w, '2026-11-09T18:00');
    const digests = digestsTo(w, w.alex);
    expect(digests).toHaveLength(1);
    expect(digests[0]!.split('\n').filter((l) => l.startsWith('- Message from'))).toEqual([`- Message from “${STRANGER}”: “Is Alex around?”`]);
  });

  it('flag step fails before any pause, the pause is ingested before the retry: the retry is silent (held) and the message is listed once', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const raise = w.app.flags.raise.bind(w.app.flags);
    let fail = true;
    w.app.flags.raise = async (agentId, f) => {
      if (fail && f.kind === 'message_taken') {
        fail = false;
        throw new Error('db hiccup');
      }
      return raise(agentId, f);
    };
    await w.strangerSays(w.alex, STRANGER, 'call me back');
    expect(w.textsTo(STRANGER)).toEqual([]);
    await w.ownerSays(w.alex, 'pause');
    for (let i = 0; i < 10; i += 1) await w.advance({ minutes: 1 });
    // Paused: the retry says nothing to the stranger and texts the owner nothing beyond the ack.
    expect(w.textsTo(STRANGER)).toEqual([]);
    expect(w.textsTo(w.alex.address)).toHaveLength(1);
    expect(await messageTakenFlags(w)).toHaveLength(1);
    await w.ownerSays(w.alex, 'resume');
    for (let i = 0; i < 5; i += 1) await w.advance({ minutes: 1 });
    expect(w.textsTo(STRANGER)).toEqual([]);
    await at(w, '2026-11-09T18:00');
    const body = digestsTo(w, w.alex)[0]!;
    expect(body.split('\n').filter((l) => l.startsWith('- Message from'))).toHaveLength(1);
  });

  it('pause, message, resume, pause again across digest_hour, resume: listed exactly once in the first digest after the final resume', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T17:00') });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'hello there');
    await w.ownerSays(w.alex, 'resume');
    await w.ownerSays(w.alex, 'pause');
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-09T19:00');
    expect(digestsTo(w, w.alex)).toEqual([]);
    expect(w.textsTo(STRANGER)).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-09T19:01');
    await at(w, '2026-11-10T18:00');
    const digests = digestsTo(w, w.alex);
    expect(digests).toEqual([`Today:\nMessages taken\n- Message from “${STRANGER}”: “hello there”`]);
  });

  it('a paused message comes before the waiting approvals in the digest after resume', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(13, 19) });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'ping');
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-09T18:00');
    expect(digestsTo(w, w.alex)).toEqual([
      `Today:\nMessages taken\n- Message from “${STRANGER}”: “ping”\nWaiting for you\n- #${a.ref} Dinner — Fri Nov 13, 7:00–8:00 PM. Book it?`,
    ]);
    expect(w.textsTo(STRANGER)).toEqual([]);
  });

  it('after resume, the stranger gets the canned reply to a new message (none was sent while paused)', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'one');
    await w.ownerSays(w.alex, 'resume');
    await w.strangerSays(w.alex, STRANGER, 'two');
    await w.strangerSays(w.alex, STRANGER, 'three');
    expect(w.textsTo(STRANGER)).toEqual([CANNED]);
  });
});

describe('glue round 2: digest wiring', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it("'Waiting for you' is capped at the section cap with '+N more', each shown line starts with its own #ref, in ref order", async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const refs: number[] = [];
    for (let i = 0; i < SECTION_LINE_CAP + 2; i += 1) {
      const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(20 + (i % 8), 8 + i, `Event ${i}`) });
      refs.push(a.ref);
    }
    await at(w, '2026-11-09T18:00');
    const [body] = digestsTo(w, w.alex);
    const lines = body!.split('\n');
    expect(lines[1]).toBe('Waiting for you');
    const items = lines.filter((l) => l.startsWith('- '));
    expect(items).toHaveLength(SECTION_LINE_CAP);
    items.forEach((l, i) => expect(l.startsWith(`- #${refs[i]} Event ${i} — `)).toBe(true));
    expect(lines.at(-1)).toBe('+2 more');
  });

  it('a waiting approval is listed again in the next day digest (live, not consumed), and gone once answered', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await w.app.approvals!.request(w.alex.agent.id, {
      kind: 'calendar_event',
      payload: event(20, 19),
      expiresAt: local(NY, '2026-11-12T10:00'),
    });
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-10T18:00');
    const line = `- #${a.ref} Dinner — Fri Nov 20, 7:00–8:00 PM. Book it?`;
    expect(digestsTo(w, w.alex)).toEqual([`Today:\nWaiting for you\n${line}`, `Today:\nWaiting for you\n${line}`]);
    await w.ownerSays(w.alex, `no #${a.ref}`); // I19: under the digest, so the prompt is shown again first
    await w.ownerSays(w.alex, 'no');
    expect(await w.app.digest!.preview(w.alex.agent.id)).toBeNull();
  });

  it("'yes #ref' sent as a reply to the digest shows exactly that prompt again (I19); the yes under it books exactly that approval", async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(13, 19) });
    const b = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(14, 12, 'Lunch') });
    await at(w, '2026-11-09T18:00');
    const digest = w.transport.sent.find((m) => m.purpose === 'digest' && m.toAddress === w.alex.address)!;
    await w.ownerSays(w.alex, `yes #${b.ref}`, { replyToTransportMessageId: digest.transportMessageId });
    expect((await w.app.approvals!.get(b.id))!.status).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${b.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect((await w.app.approvals!.get(b.id))!.status).toBe('executed');
    expect((await w.app.approvals!.get(a.id))!.status).toBe('pending');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
  });

  it('a bare "yes" replying to the digest never picks an approval on its own (8.3: reply-to names no prompt)', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(13, 19) });
    await at(w, '2026-11-09T18:00');
    const digest = w.transport.sent.find((m) => m.purpose === 'digest' && m.toAddress === w.alex.address)!;
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: digest.transportMessageId });
    expect((await w.app.approvals!.get(a.id))!.status).toBe('pending');
    expect(w.calendar.writes).toHaveLength(0);
  });

  it('the booked flag raise fails once after the booking: the retried job books nothing more, raises one booked item, replies once', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(13, 19) });
    const raise = w.app.flags.raise.bind(w.app.flags);
    let fail = true;
    w.app.flags.raise = async (agentId, f) => {
      if (fail && f.kind === 'booked') {
        fail = false;
        throw new Error('db hiccup');
      }
      return raise(agentId, f);
    };
    const before = w.textsTo(w.alex.address).length;
    await w.ownerSays(w.alex, 'yes');
    for (let i = 0; i < 10; i += 1) await w.advance({ minutes: 1 });
    expect((await w.app.approvals!.get(a.id))!.status).toBe('executed');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
    const booked = (await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked');
    expect(booked.map((f) => f.text)).toEqual(['Dinner — Fri Nov 13, 7:00–8:00 PM']);
    const replies = w.textsTo(w.alex.address).slice(before);
    expect(replies.filter((t) => t.startsWith('Booked:'))).toHaveLength(1);
    await at(w, '2026-11-09T18:00');
    expect(digestsTo(w, w.alex)).toEqual(['Today:\nBooked\n- Dinner — Fri Nov 13, 7:00–8:00 PM']);
  });

  it('a denied approval raises no booked item and leaves Waiting', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: event(13, 19) });
    await w.ownerSays(w.alex, 'no');
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toHaveLength(0);
    expect(await w.app.digest!.preview(w.alex.agent.id)).toBeNull();
  });

  it("Sam's booked item and waiting approvals never reach Alex's digest", async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    await w.app.approvals!.request(w.sam.agent.id, { kind: 'calendar_event', payload: event(13, 19) });
    await w.ownerSays(w.sam, 'yes');
    await w.app.approvals!.request(w.sam.agent.id, { kind: 'calendar_event', payload: event(14, 12, 'Lunch') });
    await at(w, '2026-11-09T18:00');
    expect(digestsTo(w, w.alex)).toEqual([]);
    const sam = digestsTo(w, w.sam);
    expect(sam).toHaveLength(1);
    expect(sam[0]!.split('\n').slice(0, 2)).toEqual(['Today:', 'Booked']);
  });

  it('a2a kinds land in their sections in contract order', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const id = w.alex.agent.id;
    const raise = (kind: string, text: string) => w.app.flags.raise(id, { kind, urgency: 'digest', text });
    await raise('approval_expired', 'E');
    await raise('a2a_booked', 'AB');
    await raise('booked', 'B');
    await raise('draft_created', 'D');
    await raise('a2a_closed', 'AC');
    await raise('a2a_opened', 'AO');
    await raise('message_taken', 'M');
    await raise('mystery_kind', 'X');
    const body = (await w.app.digest!.preview(id))!;
    expect(body.split('\n')).toEqual([
      'Today:',
      'Messages taken',
      '- M',
      'Agent conversations',
      '- AC',
      '- AO',
      'Drafts',
      '- D',
      'Booked',
      '- AB',
      '- B',
      'Also',
      '- E',
      '- X',
    ]);
  });
});
