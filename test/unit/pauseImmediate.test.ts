/**
 * Pause is immediate (I14, flow 8.6): the owner's pause/resume flips state in the
 * ingest transaction, never behind the lane's backlog. The queued job only stores
 * the message, sends the single ack and runs the hooks, in lane order.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../src/core/canned.js';
import type { OutboundMessage } from '../../src/transport/types.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('pause is immediate', () => {
  let w: TestWorld;
  let hookCalls: string[];
  /** Every send the transport was asked to make, delivered or not. */
  let attempts: OutboundMessage[];

  beforeEach(async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000, maxAttempts: 5 } });
    hookCalls = [];
    w.app.router.hooks.onPause.push(async () => void hookCalls.push('pause'));
    w.app.router.hooks.onResume.push(async () => void hookCalls.push('resume'));
    attempts = [];
    const realSend = w.transport.send.bind(w.transport);
    w.transport.send = async (m) => {
      attempts.push(m);
      return realSend(m);
    };
  });
  afterEach(async () => w.close());

  const paused = async () => (await w.app.repos.agents.get(w.alex.agent.id))!.paused;

  it('takes effect while an older job of the lane is failing and retrying; nothing but the ack goes out afterwards', async () => {
    // The Brain's reply keeps failing, so the owner's first job retries.
    const realSend = w.transport.send.bind(w.transport);
    w.transport.send = async (m) => {
      if (m.purpose === 'reply') {
        attempts.push(m);
        throw new Error('transport down for replies');
      }
      return realSend(m);
    };
    await w.ownerSays(w.alex, 'what is on today?');
    const failing = await w.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'inbound.process'`);
    expect(failing.rows).toEqual([{ status: 'failed' }]);
    // A stranger message is backlogged behind it, then the owner pauses.
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: 'stranger-1', text: 'call me' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    // Paused before any job of the lane ran.
    expect(await paused()).toBe(true);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);

    const sentBefore = attempts.length;
    for (let i = 0; i < 6; i += 1) await w.advance({ seconds: 2 });
    const after = attempts.slice(sentBefore);
    expect(after.map((m) => [m.purpose, m.text])).toEqual([['ack', OWNER_TEXT.paused]]);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
    expect(w.textsTo('stranger-1')).toEqual([]);

    // The backlog is stored silently, like any message to a paused agent.
    const contact = (await w.app.repos.contacts.listByAgent(w.alex.agent.id)).find((c) => c.address === 'stranger-1')!;
    expect((await w.app.repos.messages.listByContact(contact.id)).map((m) => m.body)).toEqual(['call me']);
    expect(await w.actions({ action: 'inbound.held' })).toHaveLength(2);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken')).toHaveLength(0);
    const jobs = await w.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'inbound.process' ORDER BY seq`);
    expect(jobs.rows.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(hookCalls).toEqual(['pause']);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
  });

  it('a hook of an older job that sends on retry is suppressed once the pause is ingested', async () => {
    let calls = 0;
    w.app.router.hooks.onOwnerMessage = async (ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      await w.app.gateway.sendToOwner(ctx.agent.id, '#1 Book it? Reply yes or no.', { purpose: 'approval' });
      await w.app.flags.raise(ctx.agent.id, { kind: 'conflict', urgency: 'now', text: 'Overlap at noon.' });
    };
    await w.ownerSays(w.alex, 'book dinner');
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    const sentBefore = attempts.length;
    for (let i = 0; i < 4; i += 1) await w.advance({ seconds: 2 });
    expect(attempts.slice(sentBefore).map((m) => m.purpose)).toEqual(['ack']);
    // The retried job saw the pause and held the message instead of re-running the hook.
    expect(calls).toBe(1);
  });

  it('pause → resume → pause in quick succession ends paused, with one ack each, in order', async () => {
    for (const text of ['pause', 'resume', 'pause']) {
      await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text });
      expect(await paused()).toBe(text === 'pause');
    }
    await w.app.settle();
    expect(await paused()).toBe(true);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.resumed, OWNER_TEXT.paused]);
    expect(hookCalls).toEqual(['pause', 'resume', 'pause']);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(2);
    expect(await w.actions({ action: 'agent.resumed' })).toHaveLength(1);
    expect(attempts.map((m) => m.purpose)).toEqual(['ack', 'ack', 'ack']);
  });

  it('a stranger texting "pause" changes nothing', async () => {
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: 'stranger-2', text: 'pause' });
    expect(await paused()).toBe(false);
    await w.app.settle();
    expect(await paused()).toBe(false);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(0);
    expect(w.textsTo('stranger-2')).toHaveLength(1);
    expect(w.textsTo(w.alex.address)).toEqual([]);
  });

  it('the owner address of one agent cannot pause another agent', async () => {
    await w.inbound({ agentAddress: w.sam.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await w.app.settle();
    expect((await w.app.repos.agents.get(w.sam.agent.id))!.paused).toBe(false);
    expect(await paused()).toBe(false);
  });

  it('is idempotent on redelivery, even after a later resume', async () => {
    const pause = { agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause', transportMessageId: 'tg-p1' };
    await Promise.all([w.inbound(pause), w.inbound(pause)]);
    await w.app.settle();
    await w.inbound(pause);
    await w.app.settle();
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);

    await w.ownerSays(w.alex, 'resume', { transportMessageId: 'tg-r1' });
    await w.inbound(pause); // a late redelivery of the old pause
    await w.app.settle();
    expect(await paused()).toBe(false);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.resumed]);
  });

  it('a failed enqueue rolls the state flip back too', async () => {
    const realEnqueue = w.app.jobs.enqueue.bind(w.app.jobs);
    w.app.jobs.enqueue = async () => {
      throw new Error('db blip');
    };
    await expect(w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause', transportMessageId: 'tg-x' })).rejects.toThrow();
    w.app.jobs.enqueue = realEnqueue;
    expect(await paused()).toBe(false);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(0);
  });

  it('a failed ack is retried as the same ack and the state is not flipped twice', async () => {
    w.transport.failNext(1);
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
    await w.app.settle();
    await w.advance({ seconds: 2 });
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
    expect(hookCalls).toEqual(['pause']);
  });
});
