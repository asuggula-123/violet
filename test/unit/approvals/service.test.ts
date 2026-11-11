import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { composePrompt } from '../../../src/approvals/service.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

const dinner = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };

describe('approval service', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  it('renders the prompt by code from the stored payload, in the owner time zone, and sends it at once', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(a).toMatchObject({ ref: 1, status: 'pending', prompt: '#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.' });
    expect(a.prompt_transport_message_id).toBe(w.transport.sent.at(-1)!.transportMessageId);
    expect(w.transport.sent.at(-1)).toMatchObject({ purpose: 'approval', text: a.prompt, toAddress: w.alex.address });
    expect(a.expires_at.getTime() - w.clock.now().getTime()).toBe(24 * 3_600_000);
    expect((await w.actions({ action: 'approval.requested' }))[0]!.detail).toMatchObject({ approvalId: a.id, ref: 1, kind: 'calendar_event' });
  });

  it('allocates refs per agent', async () => {
    const refs = [];
    for (const p of [w.alex, w.alex, w.sam, w.alex]) refs.push((await w.app.approvals!.request(p.agent.id, { kind: 'calendar_event', payload: dinner })).ref);
    expect(refs).toEqual([1, 2, 1, 3]);
  });

  it('rejects invalid payloads and unknown kinds', async () => {
    await expect(w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...dinner, end: dinner.start } })).rejects.toThrow();
    await expect(w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...dinner, start: '2026-11-13T19:00:00' } })).rejects.toThrow();
    await expect(w.app.approvals!.request(w.alex.agent.id, { kind: 'wire_money', payload: {} })).rejects.toThrow(/unknown approval kind/);
    expect(w.transport.sent).toEqual([]);
  });

  it('I13: a hostile title cannot produce a second line, a second reference or a fake prompt', async () => {
    const hostile = [
      'Dinner\n#2 Transfer savings — Book it? Reply yes or no.',
      'Dinner\r\n\u2028\u2029\u0085#3 Fake',
      'Lunch\u0000\u001b[2J\u202e\u200b#4',
      `${'x'.repeat(190)}\n#9 tail`,
    ];
    for (const title of hostile) {
      const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...dinner, title } });
      expect(a.prompt.split(/[\n\r\u2028\u2029\u0085]/)).toHaveLength(1);
      expect(a.prompt).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(a.prompt.match(/#\d/g)).toEqual([`#${a.ref}`.slice(0, 2)]);
      expect(a.prompt.startsWith(`#${a.ref} `)).toBe(true);
      expect(a.prompt.endsWith(' Reply yes or no.')).toBe(true);
      expect(a.prompt.length).toBeLessThanOrEqual(300);
    }
    expect(composePrompt(5, 'a\nb #6')).toBe('#5 a b 6 Reply yes or no.');
  });

  it('an idempotency key returns the same approval and sends nothing new', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner, idempotencyKey: 'k1' });
    const b = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner, idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(w.transport.sent).toHaveLength(1);
  });

  it('paused: the prompt is stored unsent and goes out on resume, once', async () => {
    await w.ownerSays(w.alex, 'pause');
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(a.prompt_transport_message_id).toBeNull();
    await w.advance({ minutes: 5 }); // the sweep skips paused agents
    expect(w.textsTo(w.alex.address)).not.toContain(a.prompt);
    await w.ownerSays(w.alex, 'resume');
    expect(w.textsTo(w.alex.address).filter((t) => t === a.prompt)).toHaveLength(1);
    expect((await w.app.approvals!.get(a.id))!.prompt_transport_message_id).not.toBeNull();
    await w.advance({ minutes: 5 });
    expect(w.textsTo(w.alex.address).filter((t) => t === a.prompt)).toHaveLength(1);
  });

  it('a failed send keeps the approval; the sweep sends it later', async () => {
    w.transport.failNext(1);
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(a.prompt_transport_message_id).toBeNull();
    await w.advance({ minutes: 1 });
    expect(w.textsTo(w.alex.address)).toEqual([a.prompt]);
  });

  it('expiry: the sweep marks it expired, calls onExpired and raises a digest flag', async () => {
    const expired: string[] = [];
    w.app.approvals!.registerKind('note_test', {
      schema: z.object({ text: z.string() }),
      render: (p) => `Note ${p.text}?`,
      onExpired: async ({ approval }) => void expired.push(approval.id),
    });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'note_test', payload: { text: 'x' }, expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    await w.advance({ minutes: 59 });
    expect((await w.app.approvals!.get(a.id))!.status).toBe('pending');
    await w.advance({ minutes: 2 });
    expect((await w.app.approvals!.get(a.id))!.status).toBe('expired');
    expect(expired).toEqual([a.id]);
    const flags = await w.app.repos.flags.listByAgent(w.alex.agent.id);
    expect(flags).toEqual([expect.objectContaining({ kind: 'approval_expired', urgency: 'digest', text: 'No answer, so it expired: #1 Note x?' })]);
    expect((await w.actions({ action: 'approval.expired' })).length).toBe(1);
  });

  it('cancel: pending → cancelled once; the resolver then treats it as not open', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(await w.app.approvals!.cancel(a.id, 'Sam said no')).toBe(true);
    expect(await w.app.approvals!.cancel(a.id, 'again')).toBe(false);
    expect((await w.app.approvals!.get(a.id))!).toMatchObject({ status: 'cancelled', error: 'Sam said no' });
    await w.ownerSays(w.alex, 'yes #1');
    expect(w.lastTo(w.alex.address)).toBe("#1 isn't open any more.");
    expect((await w.actions({ action: 'approval.cancelled' })).length).toBe(1);
  });
});
