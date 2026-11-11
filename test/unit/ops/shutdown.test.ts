import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** SIGTERM path (src/main.ts → app.stop): bounded by the work in flight, not by the backlog. */
describe('graceful shutdown', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  it('jobs.stop waits for the job in flight and leaves the backlog queued', async () => {
    const release = gate();
    const ran: string[] = [];
    w.app.jobs.register('ops.work', async (p: { id: string }) => {
      ran.push(p.id);
      if (p.id === 'a') await release.opened;
    });
    for (const id of ['a', 'b', 'c']) await w.app.jobs.enqueue('ops.work', { id });
    w.app.jobs.start();
    await until(() => ran.length === 1);
    let stopped = false;
    const stopping = w.app.jobs.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release.open();
    await stopping;
    expect(ran).toEqual(['a']);
    const left = await w.db.query<{ status: string }>("SELECT status FROM jobs WHERE type = 'ops.work' ORDER BY seq");
    expect(left.rows.map((r) => r.status)).toEqual(['done', 'queued', 'queued']);
    // The queue works again after a stop (next boot, or settle in tests).
    expect(await w.app.jobs.pump()).toBe(2);
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  it('app.stop waits for the scheduler tick in flight before returning', async () => {
    const release = gate();
    let finished = false;
    let started = false;
    w.app.scheduler.register('ops.slow', 60_000, async () => {
      started = true;
      await release.opened;
      finished = true;
    });
    await w.app.start();
    await until(() => started);
    let stopped = false;
    const stopping = w.app.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release.open();
    await stopping;
    expect(finished).toBe(true);
    const state = await w.db.query("SELECT 1 FROM scheduler_state WHERE name = 'ops.slow'");
    expect(state.rowCount).toBe(1);
  });
});
