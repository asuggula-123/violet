/**
 * Job queue: lane order with several workers, stale-running recovery (visibility
 * timeout on the Clock), max_attempts for stale jobs, and job.dead agent ids.
 * The multi-worker tests run on separate connection pools against real Postgres
 * when TEST_DATABASE_URL is set (PGlite has one connection, so they still pass there).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJobQueue, type JobQueue, type JobQueueOptions } from '../../src/core/jobs.js';
import { PgDb, type Db } from '../../src/db/db.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe('job queue recovery and lane order', () => {
  let w: TestWorld;
  const extraPools: PgDb[] = [];

  beforeEach(async () => {
    w = await createTestWorld({ jobs: { maxAttempts: 3, backoffMs: () => 1_000 } });
  });
  afterEach(async () => {
    for (const p of extraPools.splice(0)) await p.close();
    await w.close();
  });

  /** A second, independent connection pool on the world's schema (Postgres), else the same Db. */
  async function otherConnection(): Promise<Db> {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return w.db;
    const schema = (await w.db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
    const pool = new PgDb({ connectionString: url, schema, max: 2 });
    extraPools.push(pool);
    return pool;
  }

  function queue(db: Db, opts: JobQueueOptions = {}): JobQueue {
    return createJobQueue({ db, clock: w.clock, actionLog: w.app.actionLog, log: w.app.deps.log }, { maxAttempts: 3, backoffMs: () => 1_000, ...opts });
  }

  async function jobRow(id: string) {
    const res = await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE id = $1`, [id]);
    return res.rows[0];
  }

  async function insertRunning(id: string, lane: string | null, attempts: number, lockedAgoMs: number, type = 'work') {
    const at = new Date(w.clock.now().getTime() - lockedAgoMs);
    await w.db.query(
      `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, locked_at, created_at)
       VALUES ($1, $5, $2, '{}'::jsonb, 'running', $3, 3, $4, $4, $4)`,
      [id, lane, attempts, at, type],
    );
  }

  it('a finish that keeps failing does not wedge the lane: the job is recovered after staleMs by a normal pump', async () => {
    const q = queue(w.db, { staleMs: 60_000 });
    const ran: string[] = [];
    q.register('work', async (p: { id: string }) => void ran.push(p.id));
    const realQuery = w.db.query.bind(w.db);
    let failures = 2; // the finish and its immediate retry
    w.db.query = (async (sql: string, params?: unknown[]) => {
      if (failures > 0 && /SET status = 'done'/.test(sql)) {
        failures -= 1;
        throw new Error('connection reset');
      }
      return realQuery(sql, params);
    }) as Db['query'];
    await q.enqueue('work', { id: 'a' }, { lane: 'L1' });
    await q.enqueue('work', { id: 'b' }, { lane: 'L1' });
    await q.enqueue('work', { id: 'other' }, { lane: 'L2' });
    await q.pump();
    // 'a' ran but could not be marked done; its lane waits, other lanes do not.
    expect(ran.sort()).toEqual(['a', 'other']);
    w.clock.advance({ seconds: 59 });
    await q.pump();
    expect(ran).toHaveLength(2);
    w.clock.advance({ seconds: 2 });
    await q.pump(); // no start(), no restart: the pump recovers it
    expect(ran.filter((x) => x === 'a')).toHaveLength(2); // at least once
    expect(ran.at(-1)).toBe('b');
    const res = await w.db.query<{ status: string }>(`SELECT status FROM jobs ORDER BY seq`);
    expect(res.rows.map((r) => r.status)).toEqual(['done', 'done', 'done']);
  });

  it('a stale job with attempts left is requeued and run; a fresh running job is left alone', async () => {
    const q = queue(w.db, { staleMs: 60_000 });
    let runs = 0;
    q.register('work', async () => void (runs += 1));
    await insertRunning('stale', 'L1', 1, 61_000);
    await insertRunning('fresh', 'L2', 1, 30_000);
    expect(await q.pump()).toBe(1);
    expect(runs).toBe(1);
    expect(await jobRow('stale')).toEqual({ status: 'done', attempts: 2 });
    expect(await jobRow('fresh')).toEqual({ status: 'running', attempts: 1 });
  });

  it('a stale job that used its last attempt is dead with job.dead (agent id set when the lane is an agent)', async () => {
    const q = queue(w.db, { staleMs: 60_000 });
    let runs = 0;
    q.register('work', async () => void (runs += 1));
    await insertRunning('agent-job', w.alex.agent.id, 3, 61_000);
    await insertRunning('plain-job', 'L9', 3, 61_000);
    await q.pump();
    expect(runs).toBe(0);
    expect(await jobRow('agent-job')).toEqual({ status: 'dead', attempts: 3 });
    expect(await jobRow('plain-job')).toEqual({ status: 'dead', attempts: 3 });
    const dead = await w.actions({ action: 'job.dead' });
    expect(dead.map((d) => [d.detail.jobId, d.agent_id]).sort()).toEqual([
      ['agent-job', w.alex.agent.id],
      ['plain-job', null],
    ]);
    // Dead is finished: the lane moves on.
    await q.enqueue('work', {}, { lane: w.alex.agent.id });
    expect(await q.pump()).toBe(1);
  });

  it('a job that hangs or kills its worker every time is dead after max_attempts, not retried forever', async () => {
    let calls = 0;
    const hang = () => {
      calls += 1;
      return new Promise<void>(() => undefined); // the worker never comes back
    };
    await w.app.jobs.enqueue('crashy', {}, { lane: w.alex.agent.id });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const worker = queue(w.db, { staleMs: 60_000 }); // a fresh process each time
      worker.register('crashy', hang);
      void worker.pump();
      for (let i = 0; i < 100 && calls < attempt; i += 1) await new Promise((r) => setTimeout(r, 5));
      expect(calls).toBe(attempt);
      w.clock.advance({ seconds: 61 });
    }
    const last = queue(w.db, { staleMs: 60_000 });
    last.register('crashy', hang);
    expect(await last.pump()).toBe(0);
    expect(calls).toBe(3);
    const res = await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE type = 'crashy'`);
    expect(res.rows).toEqual([{ status: 'dead', attempts: 3 }]);
    const dead = await w.actions({ action: 'job.dead' });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.agent_id).toBe(w.alex.agent.id);
  });

  it('job.dead from handler failures carries the agent id of an agent lane', async () => {
    w.app.jobs.register('always', async () => {
      throw new Error('no');
    });
    await w.app.jobs.enqueue('always', {}, { lane: w.alex.agent.id });
    for (let i = 0; i < 4; i += 1) {
      await w.app.settle();
      w.clock.advance({ seconds: 2 });
    }
    const dead = await w.actions({ action: 'job.dead' });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.agent_id).toBe(w.alex.agent.id);
    expect(await w.actions({ action: 'job.dead', agentId: w.alex.agent.id })).toHaveLength(1);
  });

  it('a late finish from a worker whose job was recovered and re-claimed changes nothing', async () => {
    const q = queue(w.db, { staleMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    q.register('slow', async () => {
      runs += 1;
      if (runs === 1) await gate;
      else throw new Error('second run fails');
    });
    const q2 = queue(w.db, { staleMs: 60_000 });
    q2.register('slow', async () => {
      runs += 1;
      throw new Error('second run fails');
    });
    await q.enqueue('slow', {}, { lane: 'L1' });
    const first = q.pump();
    for (let i = 0; i < 50 && runs === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    w.clock.advance({ seconds: 61 });
    await q2.pump(); // recovers the stale job and runs attempt 2, which fails
    const [row] = (await w.db.query<{ id: string }>(`SELECT id FROM jobs`)).rows;
    expect(await jobRow(row!.id)).toEqual({ status: 'failed', attempts: 2 });
    release();
    await first; // attempt 1 finishes late
    expect(await jobRow(row!.id)).toEqual({ status: 'failed', attempts: 2 });
  });

  it('a queued job scheduled for later does not hold back due jobs of its lane', async () => {
    const ran: string[] = [];
    w.app.jobs.register('mark', async (p: { id: string }) => void ran.push(p.id));
    await w.app.jobs.enqueue('mark', { id: 'later' }, { lane: 'L1', runAt: new Date(w.clock.now().getTime() + 3_600_000) });
    await w.app.jobs.enqueue('mark', { id: 'now' }, { lane: 'L1' });
    await w.app.settle();
    expect(ran).toEqual(['now']);
    w.clock.advance({ hours: 1 });
    await w.app.settle();
    expect(ran).toEqual(['now', 'later']);
  });

  it('a newer job waits while an older job of its lane is waiting for a retry or running', async () => {
    const ran: string[] = [];
    w.app.jobs.register('mark', async (p: { id: string }) => void ran.push(p.id));
    for (const status of ['failed', 'running']) {
      await w.db.query(`DELETE FROM jobs`);
      await w.db.query(
        `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, locked_at, created_at)
         VALUES ('head', 'mark', 'L1', '{"id":"head"}'::jsonb, $1, 1, 3, $2, $3, $4)`,
        [status, new Date(w.clock.now().getTime() + 60_000), status === 'running' ? w.clock.now() : null, w.clock.now()],
      );
      await w.app.jobs.enqueue('mark', { id: `after-${status}` }, { lane: 'L1' });
      expect(await w.app.jobs.pump()).toBe(0);
      expect(ran).toEqual([]);
    }
  });

  it.skipIf(!onPostgres)('two workers on separate connections: lane order holds while worker 1 has the head row-locked', async () => {
    const db2 = await otherConnection();
    const ran: string[] = [];
    let selected!: () => void;
    const selectedP = new Promise<void>((r) => (selected = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let held = false;
    const slowDb: Db = {
      query: (sql, params) => w.db.query(sql, params),
      exec: (sql) => w.db.exec(sql),
      close: async () => undefined,
      tx: (fn) =>
        w.db.tx((tx) =>
          fn({
            async query<R>(sql: string, params?: unknown[]) {
              const res = await tx.query<R>(sql, params);
              if (!held && /SKIP LOCKED/.test(sql) && res.rows.length > 0) {
                held = true;
                selected();
                await gate;
              }
              return res;
            },
          }),
        ),
    };
    const q1 = queue(slowDb);
    const q2 = queue(db2);
    for (const q of [q1, q2]) q.register('ordered', async (p: { id: string }) => void ran.push(p.id));
    for (const id of ['pause', 'resume', 'hello']) await q2.enqueue('ordered', { id }, { lane: 'agent-1' });
    await q2.enqueue('ordered', { id: 'free' }, { lane: 'agent-2' });

    const p1 = q1.pump();
    await selectedP;
    const ranByQ2 = await q2.pump();
    // Worker 2 may only take the other lane while worker 1 holds agent-1's head.
    expect(ran).toEqual(['free']);
    expect(ranByQ2).toBe(1);
    open();
    await p1;
    expect(ran).toEqual(['free', 'pause', 'resume', 'hello']);
  });

  it.skipIf(!onPostgres)('three workers on separate connections keep every lane in enqueue order', async () => {
    const dbs = [w.db, await otherConnection(), await otherConnection()];
    const order = new Map<string, number[]>();
    let active = new Map<string, number>();
    let overlaps = 0;
    const queues = dbs.map((db) => queue(db));
    for (const q of queues) {
      q.register('seq', async (p: { lane: string; n: number }) => {
        const n = (active.get(p.lane) ?? 0) + 1;
        active.set(p.lane, n);
        if (n > 1) overlaps += 1;
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
        order.set(p.lane, [...(order.get(p.lane) ?? []), p.n]);
        active.set(p.lane, (active.get(p.lane) ?? 1) - 1);
      });
    }
    const lanes = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];
    const perLane = 12;
    for (let n = 0; n < perLane; n += 1) {
      for (const lane of lanes) await queues[0]!.enqueue('seq', { lane, n }, { lane });
    }
    let total = 0;
    for (let round = 0; round < 20 && total < lanes.length * perLane; round += 1) {
      const counts = await Promise.all(queues.map((q) => q.pump()));
      total += counts.reduce((a, b) => a + b, 0);
    }
    expect(total).toBe(lanes.length * perLane);
    expect(overlaps).toBe(0);
    for (const lane of lanes) expect(order.get(lane)).toEqual([...Array(perLane).keys()]);
    active = new Map();
  });

  it.skipIf(!onPostgres)('two workers on separate connections: a failing head job holds its lane for both until it is done', async () => {
    const db2 = await otherConnection();
    const ran: string[] = [];
    let failOnce = true;
    const handler = async (p: { id: string }) => {
      if (p.id === 'head' && failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      ran.push(p.id);
    };
    const q1 = queue(w.db);
    const q2 = queue(db2);
    q1.register('ordered', handler);
    q2.register('ordered', handler);
    await q1.enqueue('ordered', { id: 'head' }, { lane: 'agent-1' });
    await q1.enqueue('ordered', { id: 'next' }, { lane: 'agent-1' });
    await Promise.all([q1.pump(), q2.pump()]);
    await Promise.all([q1.pump(), q2.pump()]);
    expect(ran).toEqual([]);
    w.clock.advance({ seconds: 1 });
    await Promise.all([q1.pump(), q2.pump()]);
    await Promise.all([q1.pump(), q2.pump()]);
    expect(ran).toEqual(['head', 'next']);
  });
});
