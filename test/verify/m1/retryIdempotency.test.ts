/**
 * Verifier (M1): a retried inbound.process job must not re-do side effects that
 * already happened (I15/I18: one inbound event = one stored message, one
 * inbound.received row, one flag; one pause ack).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

describe('verify M1: retrying an inbound event is idempotent', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
  });
  afterEach(async () => w.close());

  // Decision B (canned reply is best-effort): a failed canned send is not retried, so
  // this checks idempotency with exactly one canned attempt instead of a resend.
  it('stranger: a failed canned send leaves one stored message, one inbound.received, one flag, and is not resent', async () => {
    w.transport.failNext(1);
    await w.strangerSays(w.alex, 'stranger-1', 'hello there');
    await w.advance({ seconds: 2 });
    const contacts = await w.app.repos.contacts.listByAgent(w.alex.agent.id);
    const stranger = contacts.find((c) => c.address === 'stranger-1')!;
    const inbound = (await w.app.repos.messages.listByContact(stranger.id)).filter((m) => m.direction === 'in');
    expect(inbound).toHaveLength(1);
    expect(await w.actions({ action: 'inbound.received', agentId: w.alex.agent.id })).toHaveLength(1);
    const flags = (await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken');
    expect(flags).toHaveLength(1);
    expect(w.textsTo('stranger-1')).toHaveLength(0);
    expect(await w.actions({ action: 'outbound.failed', agentId: w.alex.agent.id })).toHaveLength(1);
  });

  it('owner: a hook that fails once does not store the owner message twice', async () => {
    let calls = 0;
    w.app.router.hooks.onOwnerMessage = async (ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      await w.app.gateway.sendToOwner(ctx.agent.id, 'ok', { purpose: 'reply' });
    };
    await w.ownerSays(w.alex, 'remind me');
    await w.advance({ seconds: 2 });
    const owner = await w.app.repos.messages.recent(w.alex.agent.id, 'owner', 10);
    expect(owner.filter((m) => m.direction === 'in')).toHaveLength(1);
    expect(await w.actions({ action: 'inbound.received', agentId: w.alex.agent.id })).toHaveLength(1);
  });

  it('pause: if the ack send fails and is retried, the owner gets the pause ack, not "Already paused"', async () => {
    w.transport.failNext(1);
    await w.ownerSays(w.alex, 'pause');
    await w.advance({ seconds: 2 });
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
  });
});
