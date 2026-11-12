import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESOLVER_TEXT } from '../../../src/approvals/resolver.js';
import { SEND_LEASE_MS } from '../../../src/approvals/service.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

const dinner = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };

describe('approvals: expiry at resolution, delivered-only implicit target, single delivery', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  const status = async (a: ApprovalRow) => (await w.app.approvals!.get(a.id))!.status;
  const prompts = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval');
  const soon = () => new Date(w.clock.now().getTime() + 3_600_000);

  it('an explicit "yes <ref>" after expires_at (no sweep yet) marks it expired, says not open, books nothing', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner, expiresAt: soon() });
    w.clock.advance({ hours: 2 });
    await w.ownerSays(w.alex, `yes ${a.ref}`);
    expect(await status(a)).toBe('expired');
    expect(w.calendar.writes).toEqual([]);
    expect(w.lastTo(w.alex.address)).toBe(RESOLVER_TEXT.notOpen(a.ref));
    expect(await w.actions({ action: 'approval.expired' })).toHaveLength(1);
  });

  it('a button pressed after expires_at resolves nothing', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner, expiresAt: soon() });
    w.clock.advance({ hours: 2 });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    expect(await status(a)).toBe('expired');
    expect(w.calendar.writes).toEqual([]);
  });

  it('listPending omits approvals past expires_at', async () => {
    await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner, expiresAt: soon() });
    w.clock.advance({ hours: 2 });
    expect(await w.app.approvals!.listPending(w.alex.agent.id)).toEqual([]);
  });

  it('an undelivered prompt named by its explicit ref is shown again (I19), and the yes under it approves it', async () => {
    w.transport.failNext(1);
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(a.prompt_transport_message_id).toBeNull();
    await w.ownerSays(w.alex, `yes #${a.ref}`);
    expect(await status(a)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${a.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).toBe('executed');
  });

  it('a failed send releases its claim, so the next sweep delivers it once', async () => {
    w.transport.failNext(1);
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(prompts()).toHaveLength(0);
    await w.app.approvals!.sendUnsent(w.alex.agent.id);
    await w.app.approvals!.sendUnsent(w.alex.agent.id);
    expect(prompts()).toHaveLength(1);
    expect((await w.app.approvals!.get(a.id))!.prompt_transport_message_id).not.toBeNull();
  });

  it('a claim left by a sender that died lapses after the lease', async () => {
    await w.ownerSays(w.alex, 'pause');
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    // Simulate a sender that claimed and crashed before sending.
    await w.db.query('UPDATE approvals SET prompt_sending_until = $2 WHERE id = $1', [a.id, new Date(w.clock.now().getTime() + SEND_LEASE_MS)]);
    await w.db.query('UPDATE agents SET paused = false WHERE id = $1', [w.alex.agent.id]);
    await w.app.approvals!.sendUnsent(w.alex.agent.id);
    expect(prompts()).toHaveLength(0);
    w.clock.advance({ ms: SEND_LEASE_MS });
    await w.app.approvals!.sendUnsent(w.alex.agent.id);
    expect(prompts()).toHaveLength(1);
  });
});
