import { afterEach, describe, expect, it } from 'vitest';
import { TURN_JOB } from '../../../src/a2a/repo.js';
import { buildApp, type App } from '../../../src/app.js';
import type { OwnerMessageCtx } from '../../../src/core/router.js';
import { LlmError } from '../../../src/llm/errors.js';
import { defaultModules } from '../../../src/modules.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, envoyCalls, honestDinnerEnvoys, respond, stepOf, toolUse } from './helpers.js';

const BOOKED = 'Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.';

async function lastInbound(w: TestWorld, p: Persona): Promise<OwnerMessageCtx> {
  const row = (await w.db.query<{ id: string; body: string }>(`SELECT id, body FROM messages WHERE agent_id = $1 AND direction = 'in' ORDER BY seq DESC LIMIT 1`, [p.agent.id])).rows[0]!;
  return {
    agent: (await w.app.repos.agents.get(p.agent.id))!,
    owner: p.owner,
    messageId: row.id,
    msg: { transport: 'fake', agentAddress: p.agentAddress, fromAddress: p.address, kind: 'text', text: row.body, transportMessageId: `x-${row.id}`, receivedAt: w.clock.now() },
  };
}

describe('a2a idempotency: retries, crashes, duplicate deliveries, two workers', () => {
  let w: TestWorld;
  let app2: App | null = null;
  afterEach(async () => {
    await app2?.stop();
    app2 = null;
    await w.close();
  });

  it('a crash after the outward act (the model fails on the next step) never repeats it', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    alexOpensDinner(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, (req, n) => {
      if (stepOf(req) === 0) return respond([toolUse('s', 'say', { text: 'Sam is free at 7.' })]);
      if (n === 1) throw new LlmError('overloaded', true, 'overloaded', 529);
      return respond([{ type: 'text', text: 'ok' }]);
    });
    w.llm.on({ agentId: w.alex.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'ok' }]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'text']);
    // The retried turn found its act and did not call the model again.
    expect(envoyCalls(w, w.sam)).toHaveLength(2);
    expect(envoyCalls(w, w.alex)).toHaveLength(1);
  });

  it('a duplicate delivery job and a failed send of a notice repeat nothing', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    w.transport.failNext(2); // the Brain reply goes first (fails, retried), then the notice
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const conv = (await w.db.query<{ id: string }>('SELECT id FROM a2a_conversations')).rows[0]!;
    for (const p of [w.sam, w.alex]) {
      for (const seq of [1, 2, 3]) await w.app.jobs.enqueue(TURN_JOB, { conversationId: conv.id, agentId: p.agent.id, seq }, { lane: p.agent.id });
    }
    await w.app.settle();
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'proposal', 'accept']);
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Talking to'))).toHaveLength(1);
    expect(w.transport.sent.filter((m) => m.purpose === 'approval')).toHaveLength(2);
  });

  it('a retried approval hook after booking repeats no write and no notice', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    const resolver = w.app.router.hooks.ownerInterceptors[0]!;
    await resolver(await lastInbound(w, w.sam));
    await resolver(await lastInbound(w, w.alex));
    await w.app.settle();
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(2);
    expect(w.textsTo(w.alex.address).filter((t) => t === BOOKED).length).toBeGreaterThanOrEqual(1);
    expect(w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.text === BOOKED && m.purpose === 'reply')).toHaveLength(2); // the notice + the replayed hook's reply
    expect((await w.actions({ action: 'a2a.booked' })).length).toBe(1);
  });

  it('two apps (workers) on one database run the whole simulation exactly once', async () => {
    w = await createTestWorld();
    app2 = await buildApp({ ...w.app.deps }, defaultModules);
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    const both = async () => {
      for (let i = 0; i < 50; i += 1) {
        const ran = await Promise.all([w.app.jobs.pump(), app2!.jobs.pump()]);
        if (ran[0] + ran[1] === 0) return;
      }
    };
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'Set up dinner with Sam on Friday evening' });
    await both();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes' });
    await w.inbound({ agentAddress: w.sam.agentAddress, fromAddress: w.sam.address, text: 'yes' });
    await both();
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'proposal', 'accept', 'close']);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    expect(w.calendar.eventsOf(w.sam.owner.id)).toHaveLength(1);
    expect(w.textsTo(w.sam.address).filter((t) => t === BOOKED)).toHaveLength(1);
    expect(w.textsTo(w.alex.address).filter((t) => t === BOOKED)).toHaveLength(1);
    expect((await w.db.query(`SELECT id FROM approvals WHERE kind = 'a2a_outcome'`)).rows).toHaveLength(2);
  });
});
