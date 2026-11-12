import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHousehold, createOwnerWithAgent } from '../../../src/core/setup.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { respond, scriptEnvoy, stepOf, toolUse } from '../../unit/a2a/helpers.js';

/**
 * Audit (gap): how a peer is chosen when a household has more than two members, or two
 * members who share a first name; and one owner address preset on two agents.
 */

async function member(w: TestWorld, name: string, address: string, agentAddress: string): Promise<Persona> {
  const { owner, agent } = await createOwnerWithAgent(w.setup, {
    householdId: w.household.id,
    name,
    timezone: 'America/New_York',
    transport: 'fake',
    agentAddress,
    ownerAddress: address,
  });
  return { owner, agent, address, agentAddress };
}

async function conversations(w: TestWorld) {
  return (await w.db.query<{ responder_agent_id: string }>('SELECT responder_agent_id FROM a2a_conversations ORDER BY created_at')).rows;
}

describe('peer resolution with two household members called Sam', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  // RULING (Q8): the ambiguity is removed at setup. owner:add / createOwnerWithAgent refuses an
  // owner whose first name (any case) is already used in the household, so "Sam" always names
  // one person and every code-written line ("Talking to Sam's Violet", the release prompt, the
  // outcome prompt) names the recipient unambiguously. The three FINDING tests that expected
  // talk_to_agent to tell two Sams apart now expect the refusal at setup instead.
  async function owners(): Promise<number> {
    return (await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM owners')).rows[0]!.n;
  }

  it('FIXED: a second owner whose first name is already used in the household is refused at setup, nothing is created', async () => {
    w = await createTestWorld();
    const before = await owners();
    await expect(member(w, 'Sam Two', 'sam2-phone', 'violet-sam2')).rejects.toThrow(/first name "Sam" is already used in this household/);
    expect(await owners()).toBe(before);
    expect((await w.db.query('SELECT id FROM agents WHERE agent_address = $1', ['violet-sam2'])).rows).toEqual([]);
  });

  it('FIXED: the first name is compared in any case and spacing', async () => {
    w = await createTestWorld();
    for (const name of ['sam', 'SAM', '  Sam   Two ', 'sAm Robinson']) {
      await expect(member(w, name, `${name.trim()}-phone`, `violet-${name.trim()}`)).rejects.toThrow(/already used in this household/);
    }
  });

  it('FIXED: "Sam" therefore always reaches the one Sam, and the line Alex sees names that agent', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['noted']);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Dinner', brief: 'Alex would like dinner on Friday.' })])
        : respond([{ type: 'text', text: 'done' }]),
    );
    await w.ownerSays(w.alex, 'Ask Sam about dinner on Friday');
    expect((await conversations(w)).map((c) => c.responder_agent_id)).toEqual([w.sam.agent.id]);
    expect(w.textsTo(w.alex.address)).toContain('Talking to Sam\'s Violet about “Dinner”: “Alex would like dinner on Friday.”');
  });

  it('holds: a peer whose first name is unique in a three-member household is chosen correctly', async () => {
    w = await createTestWorld();
    const robin = await member(w, 'Robin Lee', 'robin-phone', 'violet-robin');
    scriptEnvoy(w, robin, () => ['noted']);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('b', 'talk_to_agent', { with: 'robin', topic: 'Dinner', brief: 'Dinner Friday?' })]) : respond([{ type: 'text', text: 'done' }]),
    );
    await w.ownerSays(w.alex, 'Ask Robin about dinner Friday');
    expect((await conversations(w)).map((c) => c.responder_agent_id)).toEqual([robin.agent.id]);
    expect(w.textsTo(w.alex.address)).toContain('Talking to Robin\'s Violet about “Dinner”: “Dinner Friday?”');
  });

  it('holds: an agent in another household with the same first name is never chosen (I12)', async () => {
    w = await createTestWorld();
    const other = await createHousehold(w.setup, 'Other household');
    const { agent } = await createOwnerWithAgent(w.setup, { householdId: other.id, name: 'Robin', timezone: 'America/New_York', transport: 'fake', agentAddress: 'violet-robin-x', ownerAddress: 'robin-x' });
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('b', 'talk_to_agent', { with: 'Robin', topic: 'Dinner', brief: 'Dinner Friday?' })]) : respond([{ type: 'text', text: 'done' }]),
    );
    await w.ownerSays(w.alex, 'Ask Robin about dinner Friday');
    expect(await conversations(w)).toEqual([]);
    expect((await w.actions({ action: 'a2a.limit' })).map((a) => a.detail.limit)).toEqual(['not_household']);
    void agent;
  });
});

describe('one owner address preset on two agents', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('holds: pause and yes act only on the agent whose chat they were sent in', async () => {
    w = await createTestWorld();
    const { agent } = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      // Q8: a different first name (one per household); the address is what this test is about.
      name: 'Robin Work',
      timezone: 'America/New_York',
      transport: 'fake',
      agentAddress: 'violet-alex-work',
      ownerAddress: w.alex.address,
    });
    const work: Persona = { owner: (await w.app.repos.owners.get(agent.owner_id))!, agent, address: w.alex.address, agentAddress: 'violet-alex-work' };
    w.app.approvals!.registerKind('note_test', { schema: z.object({ text: z.string() }), render: (p) => `Note ${p.text}?` });
    const a1 = await w.app.approvals!.request(w.alex.agent.id, { kind: 'note_test', payload: { text: 'home' } });
    const a2 = await w.app.approvals!.request(work.agent.id, { kind: 'note_test', payload: { text: 'work' } });

    // A yes in the work chat answers only the work agent's prompt (same #1 ref in both chats).
    await w.ownerSays(work, 'yes');
    expect((await w.app.approvals!.get(a2.id))!.status).toBe('approved');
    expect((await w.app.approvals!.get(a1.id))!.status).toBe('pending');

    // pause in the home chat pauses only the home agent.
    await w.ownerSays(w.alex, 'pause');
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(true);
    expect((await w.app.repos.agents.get(work.agent.id))!.paused).toBe(false);

    // A yes in the home chat while paused is held, not applied.
    await w.ownerSays(w.alex, 'yes');
    expect((await w.app.approvals!.get(a1.id))!.status).toBe('pending');
  });

});

describe('households.findByName', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('exact, case-sensitive match; with duplicate names the oldest wins', async () => {
    w = await createTestWorld();
    w.clock.advance({ minutes: 1 });
    const dup = await createHousehold(w.setup, 'Test household');
    expect((await w.app.repos.households.findByName('Test household'))!.id).toBe(w.household.id);
    expect((await w.app.repos.households.findByName('test household'))).toBeNull();
    void dup;
  });
});
