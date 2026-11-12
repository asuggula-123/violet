/**
 * Resumable inbound processing (I18, I15): a retried inbound.process job redoes
 * only the step that failed and the ones after it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../src/core/canned.js';
import { createOwnerWithAgent } from '../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('retried inbound processing', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
  });
  afterEach(async () => w.close());

  it('pairing: a failed ack is resent once and the /start text never reaches the Brain', async () => {
    const created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Robin', // Q8: one first name per household
      timezone: 'Europe/London',
      transport: 'fake',
      agentAddress: 'violet-new',
    });
    let brainCalls = 0;
    w.app.router.hooks.onOwnerMessage = async () => {
      brainCalls += 1;
    };
    w.transport.failNext(1);
    await w.inbound({ agentAddress: 'violet-new', fromAddress: 'new-phone', text: `/start ${created.pairingCode!}` });
    await w.app.settle();
    await w.advance({ seconds: 2 });
    expect(w.textsTo('new-phone')).toEqual([OWNER_TEXT.paired]);
    expect(brainCalls).toBe(0);
    expect(await w.actions({ action: 'pairing.bound' })).toHaveLength(1);
    const owner = await w.app.repos.messages.recent(created.agent.id, 'owner', 10);
    expect(owner.filter((m) => m.direction === 'in')).toHaveLength(1);
  });

  it('resume: a failed ack is resent as the resume ack, and onResume runs once', async () => {
    let resumes = 0;
    w.app.router.hooks.onResume.push(async () => {
      resumes += 1;
    });
    await w.ownerSays(w.alex, 'pause');
    w.transport.failNext(1);
    await w.ownerSays(w.alex, 'resume');
    await w.advance({ seconds: 2 });
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.resumed]);
    expect(await w.actions({ action: 'agent.resumed' })).toHaveLength(1);
    expect(resumes).toBe(1);
  });

  it('a pause hook that fails once does not resend the ack', async () => {
    let calls = 0;
    w.app.router.hooks.onPause.push(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    await w.ownerSays(w.alex, 'pause');
    await w.advance({ seconds: 2 });
    expect(calls).toBe(2);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
  });

  it('stranger: a flag failure after the canned reply does not send the canned reply twice', async () => {
    const raise = w.app.flags.raise.bind(w.app.flags);
    let calls = 0;
    w.app.flags.raise = async (agentId, f) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      await raise(agentId, f);
    };
    await w.strangerSays(w.alex, 'stranger-9', 'hello');
    await w.advance({ seconds: 2 });
    expect(w.textsTo('stranger-9')).toEqual([CANNED.stranger_reply]);
    expect(await w.actions({ action: 'canned.rate_limited' })).toHaveLength(0);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken')).toHaveLength(1);
  });

  it('a later owner message waits for the retried one (lane order)', async () => {
    const seen: string[] = [];
    let failed = false;
    w.app.router.hooks.onOwnerMessage = async (ctx) => {
      if (ctx.msg.text === 'first' && !failed) {
        failed = true;
        throw new Error('transient');
      }
      seen.push(ctx.msg.text);
    };
    await w.ownerSays(w.alex, 'first');
    await w.ownerSays(w.alex, 'second');
    expect(seen).toEqual([]);
    await w.advance({ seconds: 2 });
    expect(seen).toEqual(['first', 'second']);
  });
});
