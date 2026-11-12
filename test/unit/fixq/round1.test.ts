/**
 * Fix group Q, round 1 (verifier findings): a booking both owners said yes to waits while one
 * of them is paused (their calendar is neither read nor written) and is booked once after the
 * resume; a pause that lands inside the booking fails it closed with the generic reason; a
 * release left `approved` by anything but a pause is never sent on resume; first names that
 * only differ by Unicode form are the same name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerWithAgent, firstNameKey } from '../../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, FRI, honestDinnerEnvoys, onlyConversation } from '../a2a/helpers.js';

const outcomeState = async (w: TestWorld) =>
  (await w.db.query<{ outcome_state: string | null }>('SELECT outcome_state FROM a2a_conversations')).rows[0]!.outcome_state;
const isPaused = async (w: TestWorld, agentId: string) => (await w.app.repos.agents.get(agentId))!.paused;

describe('round 1: a booking waits for a paused owner', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  /** Records every free/busy read of Alex's calendar made while Alex is paused. */
  function watchReads(): string[] {
    const reads: string[] = [];
    const orig = w.calendar.freeBusy.bind(w.calendar);
    w.calendar.freeBusy = async (ownerId, from, to) => {
      if (ownerId === w.alex.owner.id && (await isPaused(w, w.alex.agent.id))) reads.push(from.toISOString());
      return orig(ownerId, from, to);
    };
    return reads;
  }

  async function bothSayYesWhileAlexPaused(): Promise<{ reads: string[]; samBefore: number }> {
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'pause');
    const reads = watchReads();
    const samBefore = w.textsTo(w.sam.address).length;
    await w.ownerSays(w.sam, 'yes');
    return { reads, samBefore };
  }

  it('Sam is told it waits for Alex; nothing is read, written or delivered; after resume it is booked once', async () => {
    w = await createTestWorld();
    const { reads, samBefore } = await bothSayYesWhileAlexPaused();
    expect(reads).toEqual([]);
    expect(w.calendar.writes).toEqual([]);
    expect(w.textsTo(w.sam.address).slice(samBefore)).toEqual(['Waiting for Alex.']);
    const conv = await onlyConversation(w);
    expect(conv.status).toBe('awaiting_approval');
    expect(await outcomeState(w)).toBeNull();
    const rowsWhilePaused = (await a2aMessages(w)).length;

    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    const creates = w.calendar.writes.filter((x) => x.op === 'create');
    expect(creates.map((x) => x.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    expect(await outcomeState(w)).toBe('booked');
    expect(w.textsTo(w.sam.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
    expect(w.textsTo(w.alex.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
    // A second pause/resume does nothing more.
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(2);
    expect((await a2aMessages(w)).length).toBeGreaterThan(rowsWhilePaused);
  });

  it('Alex busy while paused: nothing about it crosses until resume; after resume the fresh read decides', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'pause');
    w.calendar.seed(w.alex.owner.id, { title: 'Private appointment', start: new Date(FRI.dinner.start), end: new Date(FRI.dinner.end) });
    const samBefore = w.textsTo(w.sam.address).length;
    await w.ownerSays(w.sam, 'yes');
    expect((await a2aMessages(w)).filter((r) => r.kind === 'system' && /no longer free/.test(r.body))).toEqual([]);
    expect(w.textsTo(w.sam.address).slice(samBefore)).toEqual(['Waiting for Alex.']);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect((await a2aMessages(w)).filter((r) => r.kind === 'system' && /no longer free/.test(r.body))).toHaveLength(1);
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toEqual([]);
  });

  it('a pause that lands during the booking read fails it closed: the generic reason, the calendar result is dropped', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    w.calendar.seed(w.alex.owner.id, { title: 'Private appointment', start: new Date(FRI.dinner.start), end: new Date(FRI.dinner.end) });
    const orig = w.calendar.freeBusy.bind(w.calendar);
    let pausedDuring = false;
    w.calendar.freeBusy = async (ownerId, from, to) => {
      const out = await orig(ownerId, from, to);
      if (ownerId === w.alex.owner.id && !pausedDuring && (await outcomeState(w)) === 'booking') {
        pausedDuring = true;
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
      }
      return out;
    };
    const samBefore = w.textsTo(w.sam.address).length;
    await w.ownerSays(w.sam, 'yes');
    expect(pausedDuring).toBe(true);
    const toSam = w.textsTo(w.sam.address).slice(samBefore);
    expect(toSam.filter((t) => /no longer free/.test(t))).toEqual([]);
    expect(toSam.filter((t) => /didn't accept it/.test(t))).toHaveLength(1);
    expect((await a2aMessages(w)).filter((r) => r.kind === 'system' && /no longer free/.test(r.body))).toEqual([]);
    expect(w.calendar.eventsOf(w.sam.owner.id).filter((e) => e.title === 'Dinner')).toEqual([]);
  });
});

describe('round 1: first names compared by NFKC', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('NFD, full-width and case forms are one key; different names stay different', async () => {
    expect(firstNameKey('José')).toBe(firstNameKey('José Two'));
    expect(firstNameKey('Ｓａｍ')).toBe(firstNameKey('sam'));
    expect(firstNameKey('Jose')).not.toBe(firstNameKey('José'));
    w = await createTestWorld();
    await expect(
      createOwnerWithAgent(w.setup, { householdId: w.household.id, name: 'Ｓａｍ Two', timezone: 'UTC', transport: 'fake', agentAddress: 'violet-fw2', ownerAddress: 'fw2-owner' }),
    ).rejects.toThrow(/already used in this household/);
  });
});

/**
 * Real Postgres: Sam's yes (the booking claim: both agent rows FOR SHARE, then the
 * conversation row) races Alex's pause (agent row FOR UPDATE), 20 times. Never a deadlock, never
 * half-booked, never a "no longer free" from a paused calendar, and after the resume the booking
 * is settled exactly once.
 */
const PG = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG)('round 1: booking claim vs pause (real Postgres)', () => {
  it('20 iterations', async () => {
    for (let i = 0; i < 20; i += 1) {
      const w = await createTestWorld();
      try {
        alexOpensDinner(w);
        honestDinnerEnvoys(w);
        await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
        await w.ownerSays(w.alex, 'yes');
        // Sam's yes is resolved; its onApproved hook (the claim) runs against Alex's pause.
        const sam = (await w.db.query<{ id: string }>(`SELECT id FROM approvals WHERE kind = 'a2a_outcome' AND agent_id = $1`, [w.sam.agent.id])).rows[0]!;
        await w.db.query(`UPDATE approvals SET status = 'approved', resolved_at = $2 WHERE id = $1`, [sam.id, w.clock.now()]);
        const service = w.app.approvals as unknown as { kind(n: string): { onApproved(ctx: unknown): Promise<string> } | undefined; kindContext(a: unknown): Promise<unknown> };
        const ctx = await service.kindContext((await w.db.query(`SELECT * FROM approvals WHERE id = $1`, [sam.id])).rows[0]);
        const pause = w.app.ingest({ transport: 'fake', kind: 'text', agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause', transportMessageId: `claim-race-${i}`, receivedAt: w.clock.now() });
        const results = await Promise.allSettled([service.kind('a2a_outcome')!.onApproved(ctx), pause]);
        for (const r of results) if (r.status === 'rejected') throw r.reason;
        await w.app.settle();
        expect(await isPaused(w, w.alex.agent.id)).toBe(true);
        const held = results[0].status === 'fulfilled' && results[0].value === 'Waiting for Alex.';
        expect((await a2aMessages(w)).filter((r) => r.kind === 'system' && /no longer free/.test(r.body))).toEqual([]);
        await w.ownerSays(w.alex, 'resume');
        await w.app.settle();
        const dinners = (ownerId: string) => w.calendar.eventsOf(ownerId).filter((e) => e.title === 'Dinner').length;
        expect(dinners(w.alex.owner.id)).toBe(dinners(w.sam.owner.id));
        expect(dinners(w.alex.owner.id)).toBeLessThanOrEqual(1);
        expect(['booked', 'failed', null]).toContain(await outcomeState(w));
        // Held by the pause (claim refused, or claim given back before any write): booked after the resume.
        if (held) expect(await outcomeState(w)).toBe('booked');
        // Settled either way: booked once, or (a pause inside the booking) failed closed and reopened.
        const conv = await onlyConversation(w);
        expect(conv.status === 'closed' ? dinners(w.alex.owner.id) : 0).toBe(conv.status === 'closed' ? 1 : 0);
        expect(w.textsTo(w.sam.address).filter((t) => /^Booked/.test(t)).length).toBe(dinners(w.sam.owner.id));
      } finally {
        await w.close();
      }
    }
  }, 600_000);
});
