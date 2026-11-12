/**
 * Q1 on real Postgres: the pause flip at ingest (agent row FOR UPDATE) races each outward a2a
 * write of the paused side (open, guidance, owner close: agent row FOR SHARE first, then the
 * household or conversation row). 20 iterations each: no deadlock, and never a message from the
 * agent written after its pause: either the write committed before the flip (its log row is
 * older than `agent.paused`) or it was refused as `paused`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addGuidance, endByOwner, openConversation } from '../../../src/a2a/conversations.js';
import { isRefusal, type A2ADeps } from '../../../src/a2a/deps.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { scriptEnvoy } from '../a2a/helpers.js';

const URL = process.env.TEST_DATABASE_URL;
const ITERATIONS = 20;

describe.skipIf(!URL)('Q1: pause flip vs outward a2a writes (real Postgres)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  function deps(): A2ADeps {
    const app = w.app;
    return { db: w.db, clock: w.clock, jobs: app.jobs, actionLog: app.actionLog, flags: app.flags, repos: app.repos, gateway: app.gateway, approvals: app.approvals!, calendar: w.calendar, log: app.deps.log };
  }

  let n = 0;
  const pause = (text: 'pause' | 'resume') =>
    w.app.ingest({ transport: 'fake', kind: 'text', agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text, transportMessageId: `race-${(n += 1)}`, receivedAt: w.clock.now() });

  const open = (d: A2ADeps, key: string) =>
    openConversation(d, { initiator: w.alex.agent, responder: w.sam.agent, householdId: w.household.id, topic: 'Race', brief: 'Race?', window: null, key, notice: false });

  /** Runs `write` against a pause; returns 'before' (committed first) or 'refused'. Throws on anything else. */
  async function race(write: () => Promise<unknown>, seqFrom: number): Promise<'before' | 'refused'> {
    const [result] = await Promise.allSettled([write(), pause('pause')]);
    const paused = await w.db.query<{ id: number }>(`SELECT id::int AS id FROM action_log WHERE action = 'agent.paused' ORDER BY id DESC LIMIT 1`);
    const mine = await w.db.query<{ id: number }>(
      `SELECT id::int AS id FROM action_log WHERE action = 'a2a.message' AND agent_id = $1 AND id > $2`,
      [w.alex.agent.id, seqFrom],
    );
    if (result.status === 'rejected') {
      if (!isRefusal(result.reason) || result.reason.reason !== 'paused') throw result.reason;
      expect(mine.rows).toEqual([]);
      return 'refused';
    }
    expect(mine.rows.length).toBe(1);
    expect(mine.rows[0]!.id).toBeLessThan(paused.rows[0]!.id);
    return 'before';
  }

  const lastLogId = async () => (await w.db.query<{ id: number }>('SELECT coalesce(max(id), 0)::int AS id FROM action_log')).rows[0]!.id;

  async function unpause(): Promise<void> {
    await pause('resume');
    await w.app.settle();
  }

  it(`${ITERATIONS} iterations each: open, guidance and owner close against the pause`, async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const d = deps();
    const outcomes: string[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      outcomes.push(await race(() => open(d, `race-open-${i}`), await lastLogId()));
      await w.db.query(`UPDATE a2a_conversations SET status = 'closed' WHERE status <> 'closed'`);
      w.clock.advance({ hours: 3 }); // the new-per-day limit is rolling 24 h
      await unpause();
    }
    const conv = (await open(d, 'race-base')).conv;
    for (let i = 0; i < ITERATIONS; i += 1) {
      outcomes.push(await race(() => addGuidance(d, { agentId: w.alex.agent.id, conversationId: conv.id, text: `Guidance ${i}`, key: `race-g-${i}`, notice: false }), await lastLogId()));
      await unpause();
    }
    for (let i = 0; i < ITERATIONS; i += 1) {
      await w.db.query(`UPDATE a2a_conversations SET status = 'closed' WHERE status <> 'closed'`);
      w.clock.advance({ hours: 3 });
      const c = (await open(d, `race-end-base-${i}`)).conv;
      outcomes.push(await race(() => endByOwner(d, w.alex.agent.id, c.id), await lastLogId()));
      await unpause();
    }
    expect(outcomes).toHaveLength(3 * ITERATIONS);
    expect(outcomes.every((o) => o === 'before' || o === 'refused')).toBe(true);
  }, 240_000);
});
