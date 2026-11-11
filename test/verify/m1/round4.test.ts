/**
 * Verifier (M1, round 4): immediate pause (decision A), best-effort canned reply
 * (decision B), and the job queue with several workers on real Postgres
 * (no double run, concurrent stale recovery, dedupe).
 *
 * Tests marked "pg only" use separate connections and are skipped on PGlite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { createJobQueue, type JobQueue, type JobQueueOptions } from '../../../src/core/jobs.js';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { PgDb, type Db } from '../../../src/db/db.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe('verify M1 round 4', () => {
  let w: TestWorld;
  const extraPools: PgDb[] = [];

  beforeEach(async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000, maxAttempts: 3 } });
  });
  afterEach(async () => {
    for (const p of extraPools.splice(0)) await p.close();
    await w.close();
  });

  async function otherConnection(): Promise<Db> {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return w.db;
    const schema = (await w.db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
    const pool = new PgDb({ connectionString: url, schema, max: 3 });
    extraPools.push(pool);
    return pool;
  }

  function queue(db: Db, opts: JobQueueOptions = {}): JobQueue {
    return createJobQueue(
      { db, clock: w.clock, actionLog: w.app.actionLog, log: w.app.deps.log },
      { maxAttempts: 3, backoffMs: () => 1_000, ...opts },
    );
  }

  const paused = async () => (await w.app.repos.agents.get(w.alex.agent.id))!.paused;
  const acksTo = (address: string) => w.transport.sent.filter((m) => m.toAddress === address && m.purpose === 'ack').map((m) => m.text);

  // ---------------------------------------------------------------- immediate pause

  it('pause: a message that arrives while paused is held even if resume is ingested before its job runs (I14)', async () => {
    await w.ownerSays(w.alex, 'pause');
    // Arrive while paused, all backlogged before any job runs.
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'book dinner' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: 'stranger-p', text: 'hello?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'resume' });
    await w.app.settle();
    // Both messages reached a paused agent; they must be stored silently, not answered
    // later, and nothing may go out before the "Resumed" ack.
    expect(w.textsTo('stranger-p')).toEqual([]);
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.resumed]);
    expect(await w.actions({ action: 'inbound.held', agentId: w.alex.agent.id })).toHaveLength(2);
  });

  it('pause: a newly paired owner who says pause before the pairing job ran ends paused with one ack each', async () => {
    const created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Alex',
      timezone: 'America/New_York',
      transport: 'fake',
      agentAddress: 'violet-unpaired',
    });
    await w.inbound({ agentAddress: 'violet-unpaired', fromAddress: 'new-owner', text: `/start ${created.pairingCode}` });
    await w.inbound({ agentAddress: 'violet-unpaired', fromAddress: 'new-owner', text: 'pause' });
    await w.inbound({ agentAddress: 'violet-unpaired', fromAddress: 'new-owner', text: 'hello' });
    await w.app.settle();
    const agent = (await w.app.repos.agents.get(created.agent.id))!;
    expect(agent.paused).toBe(true);
    expect(w.textsTo('new-owner')).toEqual([OWNER_TEXT.paired, OWNER_TEXT.paused]);
    expect(await w.actions({ action: 'agent.paused', agentId: created.agent.id })).toHaveLength(1);
  });

  it('pause: a stranger cannot pause through the ingest path on an unpaired agent, even with /pause', async () => {
    const created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Sam',
      timezone: 'America/New_York',
      transport: 'fake',
      agentAddress: 'violet-unpaired-2',
    });
    await w.inbound({ agentAddress: 'violet-unpaired-2', fromAddress: 'intruder', text: '/start 000000' });
    await w.inbound({ agentAddress: 'violet-unpaired-2', fromAddress: 'intruder', text: '/pause' });
    await w.app.settle();
    expect((await w.app.repos.agents.get(created.agent.id))!.paused).toBe(false);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(0);
    expect(acksTo('intruder')).toEqual([]);
  });

  it.skipIf(!onPostgres)('pause: the same pause delivered twice at the same instant flips once, logs once, acks once (pg only)', async () => {
    const msg = {
      transport: 'fake' as const,
      kind: 'text' as const,
      agentAddress: w.alex.agentAddress,
      fromAddress: w.alex.address,
      text: 'pause',
      transportMessageId: 'dup-pause-1',
      receivedAt: w.clock.now(),
    };
    await Promise.all([w.app.ingest(msg), w.app.ingest(msg), w.app.ingest(msg)]);
    await w.app.settle();
    expect(await paused()).toBe(true);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
    expect(await w.actions({ action: 'inbound.duplicate' })).toHaveLength(2);
    expect(acksTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
  });

  it.skipIf(!onPostgres)('pause: concurrent pause and resume — the last ack the owner gets always matches the final state (pg only)', async () => {
    const stateText = (p: boolean): string[] => (p ? [OWNER_TEXT.paused, OWNER_TEXT.alreadyPaused] : [OWNER_TEXT.resumed, OWNER_TEXT.notPaused]);
    const mismatches: string[] = [];
    for (let trial = 0; trial < 30; trial += 1) {
      const start = w.transport.sent.length;
      const base = {
        transport: 'fake' as const,
        kind: 'text' as const,
        agentAddress: w.alex.agentAddress,
        fromAddress: w.alex.address,
        receivedAt: w.clock.now(),
      };
      await Promise.all([
        w.app.ingest({ ...base, text: 'pause', transportMessageId: `race-p-${trial}` }),
        w.app.ingest({ ...base, text: 'resume', transportMessageId: `race-r-${trial}` }),
      ]);
      await w.app.settle();
      const acks = w.transport.sent.slice(start).filter((m) => m.purpose === 'ack').map((m) => m.text);
      const final = await paused();
      expect(acks).toHaveLength(2);
      if (!stateText(final).includes(acks.at(-1)!)) mismatches.push(`trial ${trial}: final paused=${final}, acks=${JSON.stringify(acks)}`);
    }
    expect(mismatches).toEqual([]);
  });

  // ---------------------------------------------------------------- canned best-effort

  it('canned: a canned text that was delivered is always in the action log (I15), even if recording it fails', async () => {
    const realQuery = w.db.query.bind(w.db);
    let failures = 1;
    w.db.query = (async (sql: string, params?: unknown[]) => {
      if (failures > 0 && /INSERT INTO messages/.test(sql) && params?.includes('canned')) {
        failures -= 1;
        throw new Error('connection reset');
      }
      return realQuery(sql, params);
    }) as Db['query'];
    await w.strangerSays(w.alex, 'stranger-c', 'hi');
    for (let i = 0; i < 4; i += 1) await w.advance({ seconds: 2 });
    w.db.query = realQuery as Db['query'];
    const delivered = w.textsTo('stranger-c').length;
    expect(delivered).toBe(1);
    const sent = (await w.actions({ action: 'outbound.sent', agentId: w.alex.agent.id })).filter((a) => a.detail.purpose === 'canned');
    const failed = (await w.actions({ action: 'outbound.failed', agentId: w.alex.agent.id })).filter((a) => a.detail.purpose === 'canned');
    // The text went out; some outbound row must say so.
    expect(sent.length + failed.length).toBeGreaterThanOrEqual(1);
  });

  it('canned: a failed canned reply does not block the lane and the next stranger message still gets a reply attempt', async () => {
    w.transport.failNext(1);
    await w.strangerSays(w.alex, 'stranger-d', 'first');
    await w.strangerSays(w.alex, 'stranger-d', 'second');
    // First attempt failed (no last_canned_reply_at), so the second message is not rate-limited.
    expect(w.textsTo('stranger-d')).toHaveLength(1);
    expect(await w.actions({ action: 'canned.rate_limited' })).toHaveLength(0);
    const jobs = await w.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'inbound.process' ORDER BY seq`);
    expect(jobs.rows.map((r) => r.status)).toEqual(['done', 'done']);
  });

  // ---------------------------------------------------------------- job queue, several workers

  it.skipIf(!onPostgres)('jobs: three workers pumping at once never run a job twice (lane and lane-less jobs) (pg only)', async () => {
    const dbs = [w.db, await otherConnection(), await otherConnection()];
    const runs = new Map<string, number>();
    const queues = dbs.map((db) => queue(db));
    for (const q of queues) {
      q.register('once', async (p: { id: string }) => {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
        runs.set(p.id, (runs.get(p.id) ?? 0) + 1);
      });
    }
    const ids: string[] = [];
    for (let n = 0; n < 40; n += 1) {
      const id = `j${n}`;
      ids.push(id);
      await queues[0]!.enqueue('once', { id }, n % 2 === 0 ? {} : { lane: `lane-${n % 5}` });
    }
    let total = 0;
    for (let round = 0; round < 30 && total < ids.length; round += 1) {
      const counts = await Promise.all(queues.map((q) => q.pump()));
      total += counts.reduce((a, b) => a + b, 0);
    }
    expect(total).toBe(ids.length);
    for (const id of ids) expect(runs.get(id), id).toBe(1);
    const res = await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status <> 'done'`);
    expect(res.rows[0]!.n).toBe(0);
  });

  it.skipIf(!onPostgres)('jobs: concurrent stale recovery by two workers writes one job.dead per job and reruns a requeued job once (pg only)', async () => {
    const db2 = await otherConnection();
    const q1 = queue(w.db, { staleMs: 60_000 });
    const q2 = queue(db2, { staleMs: 60_000 });
    let runs = 0;
    for (const q of [q1, q2]) q.register('work', async () => void (runs += 1));
    const old = new Date(w.clock.now().getTime() - 3_600_000);
    for (let i = 0; i < 5; i += 1) {
      await w.db.query(
        `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, locked_at, created_at)
         VALUES ($1, 'work', $2, '{}'::jsonb, 'running', 3, 3, $3, $3, $3)`,
        [`dead-${i}`, i === 0 ? w.sam.agent.id : `lane-dead-${i}`, old],
      );
    }
    await w.db.query(
      `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, locked_at, created_at)
       VALUES ('retry-1', 'work', $1, '{}'::jsonb, 'running', 1, 3, $2, $2, $2)`,
      [w.alex.agent.id, old],
    );
    await Promise.all([q1.pump(), q2.pump(), q1.pump(), q2.pump()]);
    const dead = await w.actions({ action: 'job.dead' });
    expect(dead.map((d) => d.detail.jobId).sort()).toEqual(['dead-0', 'dead-1', 'dead-2', 'dead-3', 'dead-4']);
    expect(runs).toBe(1);
    const row = await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE id = 'retry-1'`);
    expect(row.rows[0]).toEqual({ status: 'done', attempts: 2 });
  });

  it.skipIf(!onPostgres)('jobs: the same dedupe key enqueued concurrently from two workers creates one job (pg only)', async () => {
    const db2 = await otherConnection();
    const q1 = queue(w.db);
    const q2 = queue(db2);
    let runs = 0;
    for (const q of [q1, q2]) q.register('dd', async () => void (runs += 1));
    await Promise.all([
      q1.enqueue('dd', {}, { dedupeKey: 'k-1', lane: 'L' }),
      q2.enqueue('dd', {}, { dedupeKey: 'k-1', lane: 'L' }),
      q1.enqueue('dd', {}, { dedupeKey: 'k-1', lane: 'L' }),
    ]);
    await Promise.all([q1.pump(), q2.pump()]);
    expect(runs).toBe(1);
  });
});
