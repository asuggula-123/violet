import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, honestDinnerEnvoys, onlyConversation, respond, scriptEnvoy, stepOf, toolUse } from './helpers.js';

const limits = async (w: TestWorld) => (await w.actions({ action: 'a2a.limit' })).map((a) => a.detail.limit);

describe('a2a limits (I12)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('at most 3 open conversations per pair', async () => {
    w = await createTestWorld();
    const opens = [1, 2, 3, 4].map((n) => toolUse(`t${n}`, 'talk_to_agent', { with: 'Sam', topic: `Topic ${n}`, brief: `Question ${n}` }));
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond(opens) : respond([{ type: 'text', text: 'ok' }])));
    scriptEnvoy(w, w.sam, () => ['thinking']);
    await w.ownerSays(w.alex, 'open four');
    expect((await w.db.query('SELECT id FROM a2a_conversations')).rows).toHaveLength(3);
    expect(await limits(w)).toEqual(['open_per_pair']);
  });

  it('at most 10 new conversations per pair per 24 hours (closed ones count)', async () => {
    w = await createTestWorld();
    for (let i = 0; i < 9; i += 1) {
      await w.db.query(
        `INSERT INTO a2a_conversations (id, household_id, initiator_agent_id, responder_agent_id, topic, status, open_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'old', 'closed', $1, $5, $5)`,
        [`old-${i}`, w.household.id, w.sam.agent.id, w.alex.agent.id, w.clock.now()],
      );
    }
    const opens = [1, 2].map((n) => toolUse(`t${n}`, 'talk_to_agent', { with: 'Sam', topic: `Topic ${n}`, brief: `Question ${n}` }));
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond(opens) : respond([{ type: 'text', text: 'ok' }])));
    scriptEnvoy(w, w.sam, () => ['thinking']);
    await w.ownerSays(w.alex, 'open two');
    expect(await limits(w)).toEqual(['new_per_day']);
    await w.advance({ hours: 25 });
    await w.ownerSays(w.alex, 'open two again');
    expect(await limits(w)).toEqual(['new_per_day']);
    // A day later the window has moved on: both open (the first one expired as idle meanwhile).
    expect((await w.db.query(`SELECT id FROM a2a_conversations WHERE topic LIKE 'Topic%'`)).rows).toHaveLength(3);
  });

  it('idle 24 h → expired by the sweep; both owners get a digest flag', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, () => ['thinking']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.advance({ hours: 23 });
    expect((await onlyConversation(w)).status).toBe('open');
    await w.advance({ hours: 2 });
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'expired' });
    for (const p of [w.alex, w.sam]) {
      expect((await w.app.repos.flags.listByAgent(p.agent.id)).filter((f) => f.kind === 'a2a_closed').map((f) => f.urgency)).toEqual(['digest']);
    }
  });

  it('an owner ending a conversation that awaits approval cancels both pending prompts', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const conv = await onlyConversation(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('e', 'end_agent_conversation', { conversation: conv.id })]) : respond([{ type: 'text', text: 'Ended.' }]),
    );
    await w.ownerSays(w.sam, 'stop that conversation please');
    const statuses = (await w.db.query<{ status: string }>(`SELECT status FROM approvals WHERE kind = 'a2a_outcome'`)).rows.map((r) => r.status);
    expect(statuses).toEqual(['cancelled', 'cancelled']);
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.writes).toEqual([]);
    expect((await a2aMessages(w)).at(-1)).toMatchObject({ kind: 'close', body: 'Sam ended the conversation.' });
  });
});
