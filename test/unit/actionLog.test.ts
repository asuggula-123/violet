import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwnerWithAgent } from '../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

/** I15: every step of flow 8.1 leaves the expected action_log rows. */
describe('action log coverage of flow 8.1 (I15)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ modules: [] }); // bare M1 core
  });
  afterEach(async () => w.close());

  async function actionsSince(mark: number): Promise<string[]> {
    return (await w.actions()).slice(mark).map((a) => a.action);
  }

  async function mark(): Promise<number> {
    return (await w.actions()).length;
  }

  it('owner message → inbound.received + outbound.sent', async () => {
    const m = await mark();
    await w.ownerSays(w.alex, 'hi');
    expect(await actionsSince(m)).toEqual(['inbound.received', 'outbound.sent']);
  });

  it('duplicate inbound → inbound.duplicate', async () => {
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'x', transportMessageId: 'd' });
    await w.app.settle();
    const m = await mark();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'x', transportMessageId: 'd' });
    await w.app.settle();
    expect(await actionsSince(m)).toEqual(['inbound.duplicate']);
  });

  it('unknown agent → inbound.dropped', async () => {
    const m = await mark();
    await w.inbound({ agentAddress: 'nobody', fromAddress: 'x', text: 'x' });
    await w.app.settle();
    expect(await actionsSince(m)).toEqual(['inbound.dropped']);
  });

  it('pairing success and failure', async () => {
    const created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Sam',
      timezone: 'UTC',
      transport: 'fake',
      agentAddress: 'v-new',
    });
    const m = await mark();
    await w.inbound({ agentAddress: 'v-new', fromAddress: 'p', text: '/start WRONGWRONG' });
    await w.app.settle();
    expect(await actionsSince(m)).toEqual(['pairing.failed', 'inbound.received', 'flag.raised', 'outbound.sent']);
    const m2 = await mark();
    await w.inbound({ agentAddress: 'v-new', fromAddress: 'p', text: `/start ${created.pairingCode}` });
    await w.app.settle();
    expect(await actionsSince(m2)).toEqual(['pairing.bound', 'outbound.sent']);
  });

  it('pause, held inbound, suppressed send, resume', async () => {
    const m = await mark();
    await w.ownerSays(w.alex, 'pause');
    // Pause is immediate: the state flips (and is logged) at ingest, before the job runs.
    expect(await actionsSince(m)).toEqual(['agent.paused', 'inbound.received', 'outbound.sent']);
    const m2 = await mark();
    await w.ownerSays(w.alex, 'hello');
    await w.strangerSays(w.alex, 's1', 'hello');
    await w.app.gateway.sendToOwner(w.alex.agent.id, 'x', { purpose: 'reply' });
    expect(await actionsSince(m2)).toEqual([
      'inbound.received',
      'inbound.held',
      'inbound.received',
      'inbound.held',
      'outbound.suppressed',
    ]);
    const m3 = await mark();
    await w.ownerSays(w.alex, 'resume');
    expect(await actionsSince(m3)).toEqual(['agent.resumed', 'inbound.received', 'outbound.sent']);
  });

  it('stranger: canned reply + flag, then rate-limited + flag', async () => {
    const m = await mark();
    await w.strangerSays(w.alex, 's1', 'one');
    expect(await actionsSince(m)).toEqual(['inbound.received', 'flag.raised', 'outbound.sent']);
    const m2 = await mark();
    await w.strangerSays(w.alex, 's1', 'two');
    expect(await actionsSince(m2)).toEqual(['inbound.received', 'flag.raised', 'canned.rate_limited']);
  });

  it('unsupported media from the owner', async () => {
    const m = await mark();
    await w.ownerSays(w.alex, '', { kind: 'unsupported' });
    expect(await actionsSince(m)).toEqual(['inbound.received', 'outbound.sent']);
  });

  it('failed send → outbound.failed', async () => {
    w.transport.failNext();
    const m = await mark();
    await w.ownerSays(w.alex, 'hi');
    expect(await actionsSince(m)).toEqual(['inbound.received', 'outbound.failed']);
  });

  it('rows carry agent, actor and time', async () => {
    await w.strangerSays(w.alex, 's1', 'one');
    const [received] = await w.actions({ action: 'inbound.received' });
    expect(received).toMatchObject({ agent_id: w.alex.agent.id, actor: 'stranger', at: w.clock.now() });
    expect(typeof received?.id).toBe('string');
  });
});
