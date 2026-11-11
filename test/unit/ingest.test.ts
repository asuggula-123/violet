import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('ingest (flow 8.1 steps 1–2)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ modules: [] }); // bare M1 core
  });
  afterEach(async () => w.close());

  it('is idempotent on transportMessageId (I18)', async () => {
    const msg = { agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'hello', transportMessageId: 'dup-1' };
    await w.inbound(msg);
    await w.inbound(msg);
    await w.app.settle();
    await w.inbound(msg);
    await w.app.settle();

    const events = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_events');
    expect(events.rows[0]?.n).toBe(1);
    const stored = await w.app.repos.messages.recent(w.alex.agent.id, 'owner', 10);
    expect(stored.filter((m) => m.direction === 'in')).toHaveLength(1);
    expect(w.textsTo(w.alex.address)).toEqual(["I'm not fully set up yet."]);
    expect(await w.actions({ action: 'inbound.duplicate' })).toHaveLength(2);
  });

  it('enqueues processing on the agent lane', async () => {
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'hi' });
    const jobs = await w.db.query<{ type: string; lane: string; status: string }>('SELECT type, lane, status FROM jobs');
    expect(jobs.rows).toEqual([{ type: 'inbound.process', lane: w.alex.agent.id, status: 'queued' }]);
  });

  it('drops and logs a message to an unknown agent address', async () => {
    await w.inbound({ agentAddress: 'violet-nobody', fromAddress: 'someone', text: 'hi' });
    await w.app.settle();

    expect(w.transport.sent).toEqual([]);
    const dropped = await w.actions({ action: 'inbound.dropped' });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.detail).toMatchObject({ reason: 'unknown_agent', agentAddress: 'violet-nobody' });
    const contacts = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts');
    expect(contacts.rows[0]?.n).toBe(0);
    const processed = await w.db.query<{ processed: boolean }>('SELECT processed_at IS NOT NULL AS processed FROM inbound_events');
    expect(processed.rows).toEqual([{ processed: true }]);
  });

  it('routes to the right agent by address', async () => {
    await w.ownerSays(w.sam, 'hi');
    expect(w.textsTo(w.sam.address)).toHaveLength(1);
    expect(w.textsTo(w.alex.address)).toHaveLength(0);
    expect(w.transport.sent[0]?.agentAddress).toBe(w.sam.agentAddress);
  });
});
