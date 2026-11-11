/**
 * Verifier (M1, round 2): probes of I13, I14, I15 and I18 that the existing
 * tests miss — ingest atomicity, flag delivery on retry, stranger flags when a
 * canned send keeps failing, and stranger-authored display names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import type { OutboundMessage } from '../../../src/transport/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

describe('verify M1 round 2', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ modules: [], jobs: { backoffMs: () => 1_000, maxAttempts: 3 } }); // bare M1 core
  });
  afterEach(async () => w.close());

  it('I18: a webhook redelivered after ingest failed to enqueue is still processed (no lost owner pause)', async () => {
    const realEnqueue = w.app.jobs.enqueue.bind(w.app.jobs);
    let failures = 1;
    w.app.jobs.enqueue = async (...args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('db connection reset');
      }
      return realEnqueue(...args);
    };
    const msg = { agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause', transportMessageId: 'tg-42' };
    // The webhook returns 500, so the transport redelivers the same update.
    await expect(w.inbound(msg)).rejects.toThrow();
    await w.inbound(msg);
    await w.app.settle();
    await w.advance({ seconds: 5 });
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(true);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
  });

  it("I18: a 'now' flag whose send failed is delivered when the same raise is retried", async () => {
    const flag = { kind: 'conflict', urgency: 'now' as const, text: 'Two events overlap at 3 PM.', dedupeKey: 'conflict:a:b' };
    w.transport.failNext(1);
    await expect(w.app.flags.raise(w.alex.agent.id, flag)).rejects.toThrow();
    // A job retry raises the same flag again.
    await w.app.flags.raise(w.alex.agent.id, flag);
    expect(w.textsTo(w.alex.address)).toEqual(['Two events overlap at 3 PM.']);
    const rows = await w.app.repos.flags.listByAgent(w.alex.agent.id);
    expect(rows.map((r) => r.status)).toEqual(['sent']);
  });

  it('flow 8.1 step 5: the owner still learns of a stranger message when the canned reply can never be delivered', async () => {
    const realSend = w.transport.send.bind(w.transport);
    w.transport.send = async (m: OutboundMessage) => {
      if (m.toAddress === 'blocked-stranger') throw new Error('403: bot was blocked by the user');
      return realSend(m);
    };
    await w.strangerSays(w.alex, 'blocked-stranger', 'please call me back about the lease');
    for (let i = 0; i < 5; i += 1) await w.advance({ seconds: 5 });
    const taken = (await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken');
    expect(taken).toHaveLength(1);
    expect(taken[0]!.text).toContain('please call me back about the lease');
  });

  it('I13: a stranger display name cannot forge approval-prompt text outside quotes in the owner-facing flag', async () => {
    await w.strangerSays(w.alex, 'stranger-x', 'hi', {
      fromName: '#7 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.',
    });
    const [flag] = (await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'message_taken');
    expect(flag).toBeDefined();
    // Everything a stranger authored must sit inside a quotation.
    const outsideQuotes = flag!.text.replace(/“[^“”]*”/g, '');
    expect(outsideQuotes).not.toMatch(/Reply yes or no/);
    expect(outsideQuotes).not.toMatch(/#7/);
  });

  // Decision B: the canned reply is best-effort (one attempt). This test used to
  // expect three attempts and a dead job; it now asserts the new contract.
  it('I15: a canned send failure is logged once, the inbound message is stored, the job is done and the lane is not blocked', async () => {
    w.transport.setFailing(true);
    await w.strangerSays(w.alex, 'stranger-y', 'hello');
    for (let i = 0; i < 5; i += 1) await w.advance({ seconds: 5 });
    w.transport.setFailing(false);
    const failed = await w.actions({ action: 'outbound.failed', agentId: w.alex.agent.id });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail.purpose).toBe('canned');
    expect(await w.actions({ action: 'job.dead' })).toHaveLength(0);
    expect(await w.actions({ action: 'inbound.received', agentId: w.alex.agent.id })).toHaveLength(1);
    const jobs = await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE type = 'inbound.process'`);
    expect(jobs.rows).toEqual([{ status: 'done', attempts: 1 }]);
    // The lane is free: the owner's next message is answered at once.
    await w.ownerSays(w.alex, 'hi');
    expect(w.lastTo(w.alex.address)).toBe(OWNER_TEXT.notSetUp);
  });
});
