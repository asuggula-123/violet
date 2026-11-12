import { afterEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../../src/core/canned.js';
import { AlreadyPairedError, reissuePairingCode } from '../../../src/core/pairingReissue.js';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { brainCalls, scriptBrain, toolUse } from '../../unit/brain/script.js';

// Verify gfix round 2: adversarial tests. Tests that fail are evidence, not bugs in the test.

const fri = (h: number, m = 0) => `2026-11-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`;

describe('verify gfix r2: pairing re-issue and --reset', () => {
  let w: TestWorld;
  afterEach(async () => w.close());
  const ctx = () => ({ db: w.db, clock: w.clock, actionLog: w.app.actionLog });

  async function routes(agentAddress: string): Promise<Array<{ id: string; route: unknown }>> {
    const res = await w.db.query<{ id: string; progress: Record<string, unknown> | null }>(
      `SELECT id, progress FROM inbound_events WHERE payload->>'agentAddress' = $1 ORDER BY id`,
      [agentAddress],
    );
    return res.rows.map((r) => ({ id: r.id, route: r.progress?.route }));
  }

  it('a reset that commits while a routed owner turn is running: the reply never reaches the old chat', async () => {
    w = await createTestWorld();
    const { alex } = w;
    scriptBrain(w, alex, ['Here is your private answer.']);
    let fired = false;
    w.app.router.hooks.ownerInterceptors.unshift(async () => {
      if (!fired) {
        fired = true;
        await reissuePairingCode(ctx(), alex.agent.id, { reset: true });
      }
      return false;
    });
    await w.ownerSays(alex, 'what is my schedule?');
    expect(fired).toBe(true);
    expect(w.textsTo(alex.address)).not.toContain('Here is your private answer.');
    expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
  });

  it('after --reset the old chat cannot approve a pending approval ("yes" is a stranger message)', async () => {
    w = await createTestWorld();
    const { alex } = w;
    scriptBrain(w, alex, [[toolUse('t1', 'request_calendar_event', { title: 'Dinner', start: fri(19), end: fri(20) })], 'Asked.']);
    await w.ownerSays(alex, 'book dinner friday');
    const pending = await w.db.query<{ status: string }>('SELECT status FROM approvals');
    expect(pending.rows.map((r) => r.status)).toEqual(['pending']);
    const before = w.llm.calls.length;
    await reissuePairingCode(ctx(), alex.agent.id, { reset: true });
    await w.ownerSays(alex, 'yes');
    await w.ownerSays(alex, 'yes 1');
    const after = await w.db.query<{ status: string }>('SELECT status FROM approvals');
    expect(after.rows.map((r) => r.status)).toEqual(['pending']);
    expect((await w.db.query('SELECT 1 FROM calendar_writes')).rowCount).toBe(0);
    expect(w.llm.calls.length).toBe(before);
    expect(w.lastTo(alex.address)).toBe(CANNED.stranger_reply);
  });

  it('concurrent queued owner messages and --reset: no message is routed as owner after the reset committed', async () => {
    for (let i = 0; i < 6; i += 1) {
      w = await createTestWorld();
      const { alex } = w;
      scriptBrain(w, alex, ['ok']);
      for (let k = 0; k < 4; k += 1) await w.inbound({ agentAddress: alex.agentAddress, fromAddress: alex.address, text: `note ${k}` });
      const settling = w.app.settle();
      await reissuePairingCode(ctx(), alex.agent.id, { reset: true });
      const atReset = (await routes(alex.agentAddress)).filter((r) => r.route === 'owner').map((r) => r.id);
      await settling;
      await w.app.settle();
      const final = (await routes(alex.agentAddress)).filter((r) => r.route === 'owner').map((r) => r.id);
      expect(final).toEqual(atReset);
      expect(brainCalls(w, alex).length).toBeLessThanOrEqual(atReset.length);
      expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
      await w.close();
    }
    w = await createTestWorld({ modules: [] });
  }, 120_000);

  it('concurrent "pause" from the old chat and --reset: the agent is paused only if the pause was ordered before the reset', async () => {
    for (let i = 0; i < 8; i += 1) {
      w = await createTestWorld();
      const { alex } = w;
      const [ing, re] = await Promise.allSettled([
        w.inbound({ agentAddress: alex.agentAddress, fromAddress: alex.address, text: 'pause' }),
        reissuePairingCode(ctx(), alex.agent.id, { reset: true }),
      ]);
      expect(ing.status).toBe('fulfilled');
      expect(re.status).toBe('fulfilled');
      await w.app.settle();
      const row = (await w.app.repos.agents.get(alex.agent.id))!;
      const log = await w.db.query<{ action: string }>(
        `SELECT action FROM action_log WHERE action IN ('agent.paused', 'pairing.reset') ORDER BY id`,
      );
      const order = log.rows.map((r) => r.action);
      if (row.paused) expect(order).toEqual(['agent.paused', 'pairing.reset']);
      else expect(order).toEqual(['pairing.reset']);
      await w.close();
    }
    w = await createTestWorld({ modules: [] });
  }, 120_000);

  it('two chats race to /start with the same fresh code: exactly one owner, the other is a stranger', async () => {
    for (let i = 0; i < 6; i += 1) {
      w = await createTestWorld({ modules: [] });
      const created = await createOwnerWithAgent(w.setup, {
        householdId: w.household.id,
        name: 'Robin', // Q8: one first name per household
        timezone: 'Europe/London',
        transport: 'fake',
        agentAddress: `violet-r${i}`,
      });
      const { code } = await reissuePairingCode(ctx(), created.agent.id);
      await Promise.all([
        w.inbound({ agentAddress: `violet-r${i}`, fromAddress: 'alex-a', text: `/start ${code}` }),
        w.inbound({ agentAddress: `violet-r${i}`, fromAddress: 'alex-b', text: `/start ${code}` }),
      ]);
      await Promise.all([w.app.settle(), w.app.settle()]);
      const row = (await w.app.repos.agents.get(created.agent.id))!;
      expect(['alex-a', 'alex-b']).toContain(row.owner_address);
      const other = row.owner_address === 'alex-a' ? 'alex-b' : 'alex-a';
      expect(w.lastTo(row.owner_address!)).toBe(OWNER_TEXT.paired);
      expect(w.textsTo(other)).toEqual([CANNED.stranger_reply]);
      expect((await w.actions({ action: 'pairing.bound' })).length).toBe(1);
      await w.close();
    }
    w = await createTestWorld({ modules: [] });
  }, 120_000);

  it('re-issue racing a /start with the NEW code of an earlier re-issue: never both re-issued and bound', async () => {
    for (let i = 0; i < 6; i += 1) {
      w = await createTestWorld({ modules: [] });
      const created = await createOwnerWithAgent(w.setup, {
        householdId: w.household.id,
        name: 'Robin', // Q8: one first name per household
        timezone: 'Europe/London',
        transport: 'fake',
        agentAddress: `violet-n${i}`,
      });
      const first = await reissuePairingCode(ctx(), created.agent.id);
      await w.inbound({ agentAddress: `violet-n${i}`, fromAddress: 'p', text: `/start ${first.code}` });
      const [, re] = await Promise.allSettled([w.app.settle(), reissuePairingCode(ctx(), created.agent.id)]);
      const row = (await w.app.repos.agents.get(created.agent.id))!;
      if (re.status === 'fulfilled') {
        expect(row.owner_address).toBeNull();
        expect(row.pairing_code_hash).not.toBeNull();
        expect(w.textsTo('p')).toEqual([CANNED.stranger_reply]);
      } else {
        expect(re.reason).toBeInstanceOf(AlreadyPairedError);
        expect(row.owner_address).toBe('p');
      }
      const issued = await w.db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM action_log WHERE action = 'pairing.code_issued'`);
      for (const r of issued.rows) expect(JSON.stringify(r.detail)).not.toMatch(/[0-9a-f]{40,}|[A-Z2-9]{10}/);
      await w.close();
    }
    w = await createTestWorld({ modules: [] });
  }, 120_000);
});
