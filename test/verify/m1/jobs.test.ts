/** Verifier (M1): job queue edge cases the unit tests do not cover. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJobQueue } from '../../../src/core/jobs.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

describe('verify M1: job queue', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ jobs: { maxAttempts: 3, backoffMs: () => 10_000 } });
  });
  afterEach(async () => w.close());

  it('a lane stays in order when its head job fails and is retried (lane = agent)', async () => {
    const ran: string[] = [];
    let failed = false;
    w.app.jobs.register('ordered', async (p: { id: string }) => {
      if (p.id === 'a' && !failed) {
        failed = true;
        throw new Error('transient');
      }
      ran.push(p.id);
    });
    await w.app.jobs.enqueue('ordered', { id: 'a' }, { lane: 'L1' });
    await w.app.jobs.enqueue('ordered', { id: 'b' }, { lane: 'L1' });
    await w.app.settle();
    w.clock.advance({ seconds: 11 });
    await w.app.settle();
    expect(ran).toEqual(['a', 'b']);
  });

  it('retries wait for the Clock, not real time', async () => {
    let n = 0;
    w.app.jobs.register('flaky', async () => {
      n += 1;
      if (n === 1) throw new Error('once');
    });
    await w.app.jobs.enqueue('flaky', {});
    await w.app.settle();
    await new Promise((r) => setTimeout(r, 50));
    await w.app.settle();
    expect(n).toBe(1);
    w.clock.advance({ seconds: 10 });
    await w.app.settle();
    expect(n).toBe(2);
    const res = await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE type = 'flaky'`);
    expect(res.rows).toEqual([{ status: 'done', attempts: 2 }]);
  });

  it('a throwing handler never loses its job: it is failed then dead, with job.dead logged', async () => {
    w.app.jobs.register('always', async () => {
      throw 'not an Error';
    });
    await w.app.jobs.enqueue('always', { x: 1 }, { lane: 'L9' });
    for (let i = 0; i < 4; i += 1) {
      await w.app.settle();
      w.clock.advance({ seconds: 10 });
    }
    const res = await w.db.query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM jobs WHERE type = 'always'`,
    );
    expect(res.rows).toEqual([{ status: 'dead', attempts: 3, last_error: 'not an Error' }]);
    expect(await w.actions({ action: 'job.dead' })).toHaveLength(1);
  });

  it('a chain of jobs in the same lane is drained by one pump', async () => {
    const seen: number[] = [];
    w.app.jobs.register('chain', async (p: { n: number }) => {
      seen.push(p.n);
      if (p.n < 5) await w.app.jobs.enqueue('chain', { n: p.n + 1 }, { lane: 'L2' });
    });
    await w.app.jobs.enqueue('chain', { n: 1 }, { lane: 'L2' });
    expect(await w.app.jobs.pump()).toBe(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('json payloads round-trip with the same types on both drivers', async () => {
    const got: unknown[] = [];
    w.app.jobs.register('payload', async (p) => {
      got.push(p);
    });
    const payload = { s: 'x', n: 3, b: true, nil: null, arr: [1, 'a'], nested: { k: 'v' } };
    await w.app.jobs.enqueue('payload', payload);
    await w.app.settle();
    expect(got).toEqual([payload]);
  });

  it('two queues racing on many lanes never run two jobs of one lane at once', async () => {
    const deps = { db: w.db, clock: w.clock, actionLog: w.app.actionLog, log: w.app.deps.log };
    const queues = [createJobQueue(deps), createJobQueue(deps), createJobQueue(deps)];
    const active = new Map<string, number>();
    let violations = 0;
    let total = 0;
    for (const q of queues) {
      q.register('race', async (p: { lane: string }) => {
        const n = (active.get(p.lane) ?? 0) + 1;
        active.set(p.lane, n);
        if (n > 1) violations += 1;
        await new Promise((r) => setTimeout(r, 2));
        active.set(p.lane, (active.get(p.lane) ?? 1) - 1);
        total += 1;
      });
    }
    for (let i = 0; i < 24; i += 1) await queues[0]!.enqueue('race', { lane: `L${i % 3}` }, { lane: `L${i % 3}` });
    const counts = await Promise.all(queues.map((q) => q.pump()));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(24);
    expect(total).toBe(24);
    expect(violations).toBe(0);
  });
});
