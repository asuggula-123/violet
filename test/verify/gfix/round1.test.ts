import { afterEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../../src/core/canned.js';
import { AlreadyPairedError, reissuePairingCode } from '../../../src/core/pairingReissue.js';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { parseConfig } from '../../../src/config.js';
import { createDeps } from '../../../src/deps.js';
import { FakeCalendar, FakeGmail } from '../../../src/google/fake.js';
import { NOT_CONFIGURED_REASON } from '../../../src/google/unconfigured.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { scriptBrain, toolUse } from '../../unit/brain/script.js';
import { noGoogleWorld, type NoGoogleWorld } from '../../unit/gfix/helpers.js';

// Verify gfix round 1: adversarial tests. Tests that fail are evidence, not bugs in the test.

const fri = (h: number, m = 0) => `2026-11-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`;

describe('verify gfix r1: pairing re-issue races', () => {
  let w: TestWorld;
  afterEach(async () => w.close());
  const ctx = () => ({ db: w.db, clock: w.clock, actionLog: w.app.actionLog });

  async function unpaired(agentAddress = 'violet-new') {
    const created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Alex',
      timezone: 'Europe/London',
      transport: 'fake',
      agentAddress,
    });
    return { agent: created.agent, code: created.pairingCode! };
  }

  /**
   * Interleaving: the router reads the agent row, then the re-issue commits, then the
   * router runs its routing transaction. This is exactly what happens when the CLI runs
   * while an inbound job is in flight (router.process reads the agent outside the tx).
   */
  function reissueAfterRouterRead(agentId: string, opts: { reset?: boolean } = {}) {
    const agents = w.app.repos.agents;
    const original = agents.findByAddress.bind(agents);
    let fired = false;
    let issued: string | undefined;
    agents.findByAddress = async (t, a) => {
      const row = await original(t, a);
      if (!fired && row?.id === agentId) {
        fired = true;
        issued = (await reissuePairingCode(ctx(), agentId, opts)).code;
      }
      return row;
    };
    return { issued: () => issued, restore: () => (agents.findByAddress = original) };
  }

  it('old code must not bind when the re-issue commits after the router read the agent (old code dead at once)', async () => {
    w = await createTestWorld({ modules: [] });
    const { agent, code: old } = await unpaired();
    const race = reissueAfterRouterRead(agent.id);
    await w.inbound({ agentAddress: 'violet-new', fromAddress: 'attacker', text: `/start ${old}` });
    await w.app.settle();
    race.restore();
    expect(race.issued()).toBeDefined(); // the CLI printed a fresh code and said the old one no longer works
    const row = await w.app.repos.agents.get(agent.id);
    expect(row!.owner_address).toBeNull();
    expect(w.textsTo('attacker')).toEqual([CANNED.stranger_reply]);
  });

  it('--reset: a message the router read just before the reset committed is not handled as the owner', async () => {
    w = await createTestWorld();
    const { alex } = w;
    scriptBrain(w, alex, ['I am still your assistant.']);
    const race = reissueAfterRouterRead(alex.agent.id, { reset: true });
    await w.ownerSays(alex, 'what is on my calendar?');
    race.restore();
    expect(race.issued()).toBeDefined();
    expect(w.llm.calls).toEqual([]);
    const received = await w.actions({ action: 'inbound.received', agentId: alex.agent.id });
    expect(received.map((a) => a.detail.from)).toEqual(['stranger']);
  });

  it('--reset: a message already ingested (queued) before the reset is a stranger when it runs', async () => {
    w = await createTestWorld();
    const { alex } = w;
    scriptBrain(w, alex, ['I am still your assistant.']);
    await w.inbound({ agentAddress: alex.agentAddress, fromAddress: alex.address, text: 'book dinner' });
    await reissuePairingCode(ctx(), alex.agent.id, { reset: true });
    await w.app.settle();
    expect(w.llm.calls).toEqual([]);
    expect(w.textsTo(alex.address)).toEqual([CANNED.stranger_reply]);
  });

  it('--reset on an unpaired agent just re-issues (no pairing.reset row, unpaired false)', async () => {
    w = await createTestWorld({ modules: [] });
    const { agent, code: old } = await unpaired();
    const out = await reissuePairingCode(ctx(), agent.id, { reset: true });
    expect(out.unpaired).toBe(false);
    expect(await w.actions({ action: 'pairing.reset' })).toEqual([]);
    await w.inbound({ agentAddress: 'violet-new', fromAddress: 'p', text: `/start ${old}` });
    await w.app.settle();
    expect((await w.app.repos.agents.get(agent.id))!.owner_address).toBeNull();
  });

  it('two re-issues in a row: only the last code pairs', async () => {
    w = await createTestWorld({ modules: [] });
    const { agent } = await unpaired();
    const a = await reissuePairingCode(ctx(), agent.id);
    const b = await reissuePairingCode(ctx(), agent.id);
    await w.inbound({ agentAddress: 'violet-new', fromAddress: 'p', text: `/start ${a.code}` });
    await w.app.settle();
    expect((await w.app.repos.agents.get(agent.id))!.owner_address).toBeNull();
    await w.inbound({ agentAddress: 'violet-new', fromAddress: 'p', text: `/start ${b.code.toLowerCase()}` });
    await w.app.settle();
    expect((await w.app.repos.agents.get(agent.id))!.owner_address).toBe('p');
    expect(w.lastTo('p')).toBe(OWNER_TEXT.paired);
  });

  it('concurrent re-issue and /start with the old code: never both "re-issued" and "bound by the old code"', async () => {
    for (let i = 0; i < 8; i += 1) {
      w = await createTestWorld({ modules: [] });
      const { agent, code: old } = await unpaired(`violet-c${i}`);
      await w.inbound({ agentAddress: `violet-c${i}`, fromAddress: 'p', text: `/start ${old}` });
      const [, re] = await Promise.allSettled([w.app.settle(), reissuePairingCode(ctx(), agent.id)]);
      const row = (await w.app.repos.agents.get(agent.id))!;
      if (re.status === 'fulfilled') {
        // The CLI told the operator the old code no longer works: then it must not have paired.
        expect(row.owner_address).toBeNull();
        expect(row.pairing_code_hash).not.toBeNull();
      } else {
        expect(re.reason).toBeInstanceOf(AlreadyPairedError);
        expect(row.owner_address).toBe('p');
      }
      await w.close();
    }
    w = await createTestWorld({ modules: [] }); // for afterEach
  }, 120_000);
});

describe('verify gfix r1: no fake Google in production', () => {
  let n: NoGoogleWorld | undefined;
  afterEach(async () => {
    await n?.close();
    n = undefined;
  });

  it('createDeps outside production still wires the in-memory fakes', async () => {
    const w = await createTestWorld({ modules: [] });
    for (const NODE_ENV of ['development', 'test']) {
      const deps = createDeps(parseConfig({ TRANSPORT: 'fake', NODE_ENV }), w.db);
      expect(deps.calendar).toBeInstanceOf(FakeCalendar);
      expect(deps.gmail).toBeInstanceOf(FakeGmail);
    }
    await w.close();
  });

  it('approving by number (yes 1) is equally honest (failed, no booked flag, no Booked text)', async () => {
    n = await noGoogleWorld();
    const { w } = n;
    scriptBrain(w, w.alex, [[toolUse('t1', 'request_calendar_event', { title: 'Dinner', start: fri(19), end: fri(20) })], 'Asked.']);
    await n.ownerSays(w.alex, 'book dinner friday');
    await n.ownerSays(w.alex, 'yes 1');
    expect(w.textsTo(w.alex.address).some((t) => /^Booked/.test(t))).toBe(false);
    expect(w.lastTo(w.alex.address)).toBe(`I couldn't book #1: ${NOT_CONFIGURED_REASON}.`);
    const rows = await w.db.query<{ status: string }>('SELECT status FROM approvals');
    expect(rows.rows.map((r) => r.status)).toEqual(['failed']);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toEqual([]);
    // A day of scheduler runs and a digest: still no booked item, nothing retries.
    await n.advance({ hours: 24 });
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toEqual([]);
    expect(w.textsTo(w.alex.address).some((t) => t.includes('Booked'))).toBe(false);
    expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
  });

  it('a model that keeps calling Google tools cannot loop forever: the turn ends', async () => {
    n = await noGoogleWorld();
    const { w } = n;
    const calls = Array.from({ length: 30 }, (_, i) => [toolUse(`t${i}`, 'get_schedule', { from: fri(0), to: fri(23) })]);
    scriptBrain(w, w.alex, [...calls, 'done']);
    await n.ownerSays(w.alex, 'calendar?');
    expect(w.llm.calls.length).toBeLessThan(30);
    expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
  });
});
