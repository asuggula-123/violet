import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANNED } from '../../src/core/canned.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('OutboundGateway (I4)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ modules: [] }); // bare M1 core
  });
  afterEach(async () => w.close());

  it('exposes exactly two send methods and cannot be extended', () => {
    const g = w.app.gateway as unknown as Record<string, unknown>;
    expect(Object.keys(g).sort()).toEqual(['sendCanned', 'sendToOwner']);
    const allNames = new Set<string>();
    for (let o: object | null = g; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) allNames.add(n);
    }
    expect([...allNames].sort()).toEqual(['sendCanned', 'sendToOwner']);
    expect(Object.isFrozen(g)).toBe(true);
    expect(g).not.toHaveProperty('sendPauseAck');
  });

  it('sendToOwner sends only to the owner address, stores and logs it', async () => {
    const res = await w.app.gateway.sendToOwner(w.alex.agent.id, 'hello', { purpose: 'reply', buttons: [{ id: 'a', label: 'A' }] });
    expect(res).not.toBeNull();
    expect(w.transport.sent).toEqual([
      expect.objectContaining({ toAddress: w.alex.address, agentAddress: w.alex.agentAddress, text: 'hello', purpose: 'reply' }),
    ]);
    const [row] = await w.app.repos.messages.recent(w.alex.agent.id, 'owner', 1);
    expect(row).toMatchObject({ id: res!.messageId, direction: 'out', purpose: 'reply', transport_message_id: res!.transportMessageId });
    const sent = await w.actions({ action: 'outbound.sent' });
    expect(sent[0]?.detail).toMatchObject({ to: 'owner', purpose: 'reply', messageId: res!.messageId });
    expect(JSON.stringify(sent[0]?.detail)).not.toContain('hello');
  });

  it('rejects purpose canned on sendToOwner', async () => {
    await expect(w.app.gateway.sendToOwner(w.alex.agent.id, 'x', { purpose: 'canned' as never })).rejects.toThrow();
    expect(w.transport.sent).toEqual([]);
  });

  it('sendCanned only sends fixed text to a contact of that agent', async () => {
    const mine = await w.app.repos.contacts.upsert({ agentId: w.alex.agent.id, transport: 'fake', address: 'p1', kind: 'stranger' });
    const theirs = await w.app.repos.contacts.upsert({ agentId: w.sam.agent.id, transport: 'fake', address: 'p2', kind: 'stranger' });
    await w.app.gateway.sendCanned(w.alex.agent.id, mine.id, 'stranger_reply');
    await expect(w.app.gateway.sendCanned(w.alex.agent.id, theirs.id, 'stranger_reply')).rejects.toThrow();
    expect(w.transport.sent.map((m) => [m.toAddress, m.text])).toEqual([['p1', CANNED.stranger_reply]]);
  });

  it('logs outbound.failed and rethrows when the transport fails', async () => {
    w.transport.failNext();
    await expect(w.app.gateway.sendToOwner(w.alex.agent.id, 'hello', { purpose: 'reply' })).rejects.toThrow();
    expect(await w.actions({ action: 'outbound.failed' })).toHaveLength(1);
    expect(await w.app.repos.messages.recent(w.alex.agent.id, 'owner', 5)).toEqual([]);
  });

  it('a failed inbound reply is retried by the job queue', async () => {
    w.transport.failNext();
    await w.ownerSays(w.alex, 'hi');
    expect(w.textsTo(w.alex.address)).toEqual([]);
    await w.advance({ seconds: 5 });
    expect(w.textsTo(w.alex.address)).toEqual(["I'm not fully set up yet."]);
  });

  it('suppresses sends for an agent with no owner yet', async () => {
    const { createOwnerWithAgent } = await import('../../src/core/setup.js');
    const { agent } = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Sam',
      timezone: 'UTC',
      transport: 'fake',
      agentAddress: 'violet-unpaired',
    });
    expect(await w.app.gateway.sendToOwner(agent.id, 'hello', { purpose: 'reply' })).toBeNull();
    const suppressed = await w.actions({ action: 'outbound.suppressed', agentId: agent.id });
    expect(suppressed[0]?.detail).toMatchObject({ reason: 'no_owner' });
  });
});
