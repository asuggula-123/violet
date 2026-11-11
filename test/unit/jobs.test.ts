import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBackoffMs } from '../../src/core/jobs.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('JobQueue', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ jobs: { maxAttempts: 3, backoffMs: (n) => n * 10_000 } });
  });
  afterEach(async () => w.close());

  async function statuses() {
    const res = await w.db.query<{ type: string; status: string; attempts: number }>(
      'SELECT type, status, attempts FROM jobs WHERE type <> $1 ORDER BY seq',
      ['inbound.process'],
    );
    return res.rows;
  }

  it('runs jobs in a lane one at a time, in order', async () => {
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    w.app.jobs.register('slow', async (p: { id: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push(`start ${p.id}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${p.id}`);
      active -= 1;
    });
    for (const id of ['a', 'b', 'c']) await w.app.jobs.enqueue('slow', { id }, { lane: 'L1' });
    await Promise.all([w.app.jobs.pump(), w.app.jobs.pump(), w.app.jobs.pump()]);
    expect(maxActive).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('two queues on one database never run two jobs of a lane at once', async () => {
    const { createJobQueue } = await import('../../src/core/jobs.js');
    const deps = { db: w.db, clock: w.clock, actionLog: w.app.actionLog, log: w.app.deps.log };
    const queues = [createJobQueue(deps), createJobQueue(deps)];
    const ran: string[] = [];
    let active = 0;
    let maxActive = 0;
    for (const q of queues) {
      q.register('lane-job', async (p: { id: string }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        ran.push(p.id);
        active -= 1;
      });
    }
    for (let i = 0; i < 6; i += 1) await queues[0]!.enqueue('lane-job', { id: `j${i}` }, { lane: 'L1' });
    const counts = await Promise.all(queues.map((q) => q.pump()));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(maxActive).toBe(1);
    expect(ran.sort()).toEqual(['j0', 'j1', 'j2', 'j3', 'j4', 'j5']);
  });

  it('the database refuses two running jobs in one lane', async () => {
    await w.app.jobs.enqueue('x', {}, { lane: 'L1' });
    await w.app.jobs.enqueue('x', {}, { lane: 'L1' });
    await w.db.query(`UPDATE jobs SET status = 'running' WHERE seq = (SELECT min(seq) FROM jobs)`);
    await expect(w.db.query(`UPDATE jobs SET status = 'running' WHERE status = 'queued'`)).rejects.toThrow();
  });

  it('a running job blocks its lane but not other lanes', async () => {
    const ran: string[] = [];
    w.app.jobs.register('mark', async (p: { id: string }) => void ran.push(p.id));
    await w.app.jobs.enqueue('mark', { id: 'blocked' }, { lane: 'L1' });
    await w.app.jobs.enqueue('mark', { id: 'other' }, { lane: 'L2' });
    await w.app.jobs.enqueue('mark', { id: 'free' });
    // Simulate a job in L1 held by another worker.
    await w.db.query(
      `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, created_at)
       VALUES ('held', 'mark', 'L1', '{}'::jsonb, 'running', 1, 3, $1, $1)`,
      [w.clock.now()],
    );
    expect(await w.app.jobs.pump()).toBe(2);
    expect(ran.sort()).toEqual(['free', 'other']);
  });

  it('retries with backoff from the clock, then dead-letters and logs', async () => {
    let calls = 0;
    w.app.jobs.register('flaky', async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    });
    await w.app.jobs.enqueue('flaky', {}, { lane: 'L1' });

    expect(await w.app.jobs.pump()).toBe(1);
    expect(await statuses()).toEqual([{ type: 'flaky', status: 'failed', attempts: 1 }]);

    w.clock.advance({ seconds: 9 });
    expect(await w.app.jobs.pump()).toBe(0);
    w.clock.advance({ seconds: 1 });
    expect(await w.app.jobs.pump()).toBe(1);
    expect(calls).toBe(2);

    w.clock.advance({ seconds: 19 });
    expect(await w.app.jobs.pump()).toBe(0);
    w.clock.advance({ seconds: 1 });
    expect(await w.app.jobs.pump()).toBe(1);
    expect(calls).toBe(3);
    expect(await statuses()).toEqual([{ type: 'flaky', status: 'dead', attempts: 3 }]);

    w.clock.advance({ days: 1 });
    expect(await w.app.jobs.pump()).toBe(0);
    const dead = await w.actions({ action: 'job.dead' });
    expect(dead).toHaveLength(1);
    expect(dead[0]?.detail).toMatchObject({ type: 'flaky', attempts: 3, error: 'boom 3', lane: 'L1' });
    const err = await w.db.query<{ last_error: string }>('SELECT last_error FROM jobs WHERE type = $1', ['flaky']);
    expect(err.rows[0]?.last_error).toBe('boom 3');
  });

  it('a failing job does not block later jobs in other lanes', async () => {
    const ran: string[] = [];
    w.app.jobs.register('bad', async () => {
      throw new Error('no');
    });
    w.app.jobs.register('good', async () => void ran.push('good'));
    await w.app.jobs.enqueue('bad', {}, { lane: 'L1' });
    await w.app.jobs.enqueue('good', {}, { lane: 'L2' });
    expect(await w.app.jobs.pump()).toBe(2);
    expect(ran).toEqual(['good']);
  });

  it('a job type without a handler goes straight to dead', async () => {
    await w.app.jobs.enqueue('nobody', {});
    expect(await w.app.jobs.pump()).toBe(1);
    expect(await statuses()).toEqual([{ type: 'nobody', status: 'dead', attempts: 1 }]);
    expect(await w.actions({ action: 'job.dead' })).toHaveLength(1);
  });

  it('dedupeKey makes enqueue idempotent', async () => {
    let calls = 0;
    w.app.jobs.register('once', async () => void (calls += 1));
    await w.app.jobs.enqueue('once', {}, { dedupeKey: 'k1' });
    await w.app.jobs.enqueue('once', {}, { dedupeKey: 'k1' });
    await w.app.jobs.pump();
    await w.app.jobs.enqueue('once', {}, { dedupeKey: 'k1' });
    await w.app.jobs.enqueue('once', {}, { dedupeKey: 'k2' });
    await w.app.jobs.pump();
    expect(calls).toBe(2);
  });

  it('respects runAt', async () => {
    let calls = 0;
    w.app.jobs.register('later', async () => void (calls += 1));
    await w.app.jobs.enqueue('later', {}, { runAt: new Date(w.clock.now().getTime() + 60_000) });
    expect(await w.app.jobs.pump()).toBe(0);
    w.clock.advance({ minutes: 1 });
    expect(await w.app.jobs.pump()).toBe(1);
    expect(calls).toBe(1);
  });

  it('pump drains jobs enqueued by the jobs it runs', async () => {
    const seen: number[] = [];
    w.app.jobs.register('chain', async (p: { n: number }) => {
      seen.push(p.n);
      if (p.n < 5) await w.app.jobs.enqueue('chain', { n: p.n + 1 }, { lane: 'L1' });
    });
    await w.app.jobs.enqueue('chain', { n: 1 }, { lane: 'L1' });
    expect(await w.app.jobs.pump()).toBe(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('start() processes jobs in the background and stop() waits', async () => {
    let calls = 0;
    w.app.jobs.register('bg', async () => void (calls += 1));
    w.app.jobs.start();
    await w.app.jobs.enqueue('bg', {});
    for (let i = 0; i < 100 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    await w.app.jobs.stop();
    expect(calls).toBe(1);
  });

  it('default backoff grows and is capped', () => {
    expect(defaultBackoffMs(1)).toBe(5_000);
    expect(defaultBackoffMs(2)).toBe(10_000);
    expect(defaultBackoffMs(30)).toBe(3_600_000);
  });
});
