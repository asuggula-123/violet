import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('Scheduler', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ modules: [] }); // bare M1 core
  });
  afterEach(async () => w.close());

  it('runs a task when due, using the clock and scheduler_state', async () => {
    const runs: string[] = [];
    w.app.scheduler.register('hourly', 3_600_000, async (now) => void runs.push(now.toISOString()));
    await w.app.scheduler.runDue();
    await w.app.scheduler.runDue();
    expect(runs).toHaveLength(1);
    await w.advance({ minutes: 59 });
    expect(runs).toHaveLength(1);
    await w.advance({ minutes: 1 });
    expect(runs).toEqual(['2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z']);
    const state = await w.db.query<{ name: string; scope: string; last_run_at: Date }>('SELECT * FROM scheduler_state');
    expect(state.rows).toEqual([{ name: 'hourly', scope: 'global', last_run_at: new Date('2026-11-09T10:00:00.000Z') }]);
  });

  it('state survives a restart (shared through the database)', async () => {
    const runs: number[] = [];
    w.app.scheduler.register('daily', 86_400_000, async () => void runs.push(1));
    await w.app.scheduler.runDue();
    const { createScheduler } = await import('../../src/core/scheduler.js');
    const again = createScheduler({ db: w.db, clock: w.clock, repos: w.app.repos, actionLog: w.app.actionLog, log: w.app.deps.log });
    again.register('daily', 86_400_000, async () => void runs.push(2));
    await again.runDue();
    expect(runs).toEqual([1]);
  });

  it('a failing task is logged and retried on the next tick; others still run', async () => {
    let fail = true;
    const runs: string[] = [];
    w.app.scheduler.register('fragile', 60_000, async () => {
      if (fail) throw new Error('nope');
      runs.push('fragile');
    });
    w.app.scheduler.register('steady', 60_000, async () => void runs.push('steady'));
    await w.app.scheduler.runDue();
    expect(runs).toEqual(['steady']);
    expect(await w.actions({ action: 'scheduler.failed' })).toHaveLength(1);
    fail = false;
    await w.app.scheduler.runDue();
    expect(runs).toEqual(['steady', 'fragile']);
  });

  it('per-agent tasks skip paused agents (I14)', async () => {
    const runs: string[] = [];
    w.app.scheduler.registerPerAgent('check', 60_000, async (agentId) => void runs.push(agentId));
    await w.ownerSays(w.alex, 'pause');
    await w.app.scheduler.runDue();
    expect(runs).toEqual([w.sam.agent.id]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.scheduler.runDue();
    expect(runs).toEqual([w.sam.agent.id, w.alex.agent.id]);
  });

  it('rejects duplicate task names', () => {
    w.app.scheduler.register('dup', 1000, async () => undefined);
    expect(() => w.app.scheduler.register('dup', 1000, async () => undefined)).toThrow();
  });
});
