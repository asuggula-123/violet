import { afterEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../../src/core/canned.js';
import { hashPairingCode } from '../../../src/core/pairing.js';
import { AlreadyPairedError, reissuePairingCode, UnknownAgentError } from '../../../src/core/pairingReissue.js';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { brainCalls, scriptBrain } from '../brain/script.js';

describe('pairing code re-issue', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  const ctx = () => ({ db: w.db, clock: w.clock, actionLog: w.app.actionLog });
  const say = async (agentAddress: string, from: string, text: string) => {
    await w.inbound({ agentAddress, fromAddress: from, text });
    await w.app.settle();
  };
  const agentRow = (id: string) => w.app.repos.agents.get(id);

  async function unpaired() {
    const created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Alex',
      timezone: 'Europe/London',
      transport: 'fake',
      agentAddress: 'violet-new',
    });
    return { agent: created.agent, code: created.pairingCode! };
  }

  it('issues a fresh code that pairs; the old one stops working at once; only the hash is stored', async () => {
    w = await createTestWorld({ modules: [] });
    const { agent, code: old } = await unpaired();
    const out = await reissuePairingCode(ctx(), agent.id);
    expect(out.code).toMatch(/^[A-Z2-9]{10}$/);
    expect(out.code).not.toBe(old);
    expect(out.unpaired).toBe(false);
    expect(out.agent.pairing_code_hash).toBe(hashPairingCode(out.code));
    expect(out.agent.pairing_expires_at!.getTime() - w.clock.now().getTime()).toBe(24 * 3_600_000);

    await say('violet-new', 'phone-a', `/start ${old}`);
    expect((await agentRow(agent.id))!.owner_address).toBeNull();
    expect(w.textsTo('phone-a')).toEqual([CANNED.stranger_reply]);
    expect((await w.actions({ action: 'pairing.failed' })).map((a) => a.detail.reason)).toEqual(['wrong_code']);

    await say('violet-new', 'phone-a', `/start ${out.code}`);
    expect((await agentRow(agent.id))!.owner_address).toBe('phone-a');
    expect(w.lastTo('phone-a')).toBe(OWNER_TEXT.paired);

    const issued = await w.actions({ action: 'pairing.code_issued', agentId: agent.id });
    expect(issued.map((a) => a.detail)).toEqual([
      { expiresAt: expect.any(String) },
      { expiresAt: out.agent.pairing_expires_at!.toISOString(), reissued: true, replaced: 'active' },
    ]);
    expect(issued[1]!.actor).toBe('cli');
    const log = JSON.stringify(await w.actions());
    for (const secret of [old, out.code, hashPairingCode(old), hashPairingCode(out.code)]) expect(log).not.toContain(secret);
  });

  it('replaces an expired code', async () => {
    w = await createTestWorld({ modules: [] });
    const { agent, code: old } = await unpaired();
    w.clock.advance({ hours: 25 });
    await say('violet-new', 'phone-a', `/start ${old}`);
    expect((await w.actions({ action: 'pairing.failed' })).map((a) => a.detail.reason)).toEqual(['expired']);
    const out = await reissuePairingCode(ctx(), agent.id);
    expect((await w.actions({ action: 'pairing.code_issued', agentId: agent.id }))[1]!.detail.replaced).toBe('expired');
    await say('violet-new', 'phone-a', `/start ${old}`);
    expect((await agentRow(agent.id))!.owner_address).toBeNull();
    await say('violet-new', 'phone-a', `/start ${out.code}`);
    expect((await agentRow(agent.id))!.owner_address).toBe('phone-a');
  });

  it('refuses an already-paired agent without reset and changes nothing', async () => {
    w = await createTestWorld({ modules: [] });
    const before = await agentRow(w.alex.agent.id);
    await expect(reissuePairingCode(ctx(), w.alex.agent.id)).rejects.toBeInstanceOf(AlreadyPairedError);
    await expect(reissuePairingCode(ctx(), w.alex.agent.id, { reset: false })).rejects.toThrow(/--reset/);
    expect(await agentRow(w.alex.agent.id)).toEqual(before);
    expect(await w.actions({ action: 'pairing.code_issued', agentId: w.alex.agent.id })).toEqual([]);
    expect(await w.actions({ action: 'pairing.reset' })).toEqual([]);
  });

  it('an unknown agent is a clear error', async () => {
    w = await createTestWorld({ modules: [] });
    await expect(reissuePairingCode(ctx(), 'no-such-agent')).rejects.toBeInstanceOf(UnknownAgentError);
    await expect(reissuePairingCode(ctx(), 'no-such-agent')).rejects.toThrow('Unknown agent no-such-agent');
  });

  it('--reset unpairs first: the old chat is a stranger at once (no model call, no pause), and the new code pairs', async () => {
    w = await createTestWorld(); // the full app: a model is wired
    const { alex } = w;
    // A hostile model scripted to answer anything: it must never be called for the old chat.
    scriptBrain(w, alex, ['I am still your assistant.']);
    const out = await reissuePairingCode(ctx(), alex.agent.id, { reset: true });
    expect(out.unpaired).toBe(true);
    expect((await agentRow(alex.agent.id))!.owner_address).toBeNull();
    expect((await w.actions({ action: 'pairing.reset', agentId: alex.agent.id })).map((a) => a.actor)).toEqual(['cli']);

    await w.ownerSays(alex, 'what is on my calendar?');
    await w.ownerSays(alex, 'pause');
    expect(w.llm.calls).toEqual([]);
    expect(w.textsTo(alex.address)).toEqual([CANNED.stranger_reply]);
    expect((await agentRow(alex.agent.id))!.paused).toBe(false);
    expect(await w.actions({ action: 'agent.paused' })).toEqual([]);
    const received = await w.actions({ action: 'inbound.received', agentId: alex.agent.id });
    expect(received.map((a) => a.detail.from)).toEqual(['stranger', 'stranger']);
    const contacts = await w.app.repos.contacts.listByAgent(alex.agent.id);
    expect(contacts.map((c) => [c.address, c.kind])).toEqual([[alex.address, 'stranger']]);

    await say(alex.agentAddress, 'alex-new-phone', `/start ${out.code}`);
    expect((await agentRow(alex.agent.id))!.owner_address).toBe('alex-new-phone');
    expect(w.lastTo('alex-new-phone')).toBe(OWNER_TEXT.paired);
  });
  it('a --reset that commits after an owner message was routed (before a retry): the Brain never runs on it', async () => {
    w = await createTestWorld({ jobs: { maxAttempts: 3, backoffMs: () => 1_000 } });
    const { alex } = w;
    scriptBrain(w, alex, ['Here is your private answer.']);
    let failOnce = true;
    w.app.router.hooks.ownerInterceptors.unshift(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient failure after routing');
      }
      return false;
    });
    await w.ownerSays(alex, 'what is my schedule?');
    const routed = await w.db.query<{ progress: Record<string, unknown> | null }>('SELECT progress FROM inbound_events');
    expect(routed.rows[0]!.progress?.route).toBe('owner');
    await reissuePairingCode(ctx(), alex.agent.id, { reset: true });
    await w.advance({ seconds: 5 });
    await w.app.settle();
    expect(brainCalls(w, alex)).toEqual([]);
    expect(w.textsTo(alex.address)).toEqual([]);
    expect((await w.actions({ action: 'inbound.dropped', agentId: alex.agent.id })).map((a) => a.detail.reason)).toEqual(['owner_reset']);
    expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
  });
});
