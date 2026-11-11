/**
 * Verifier (M1, round 3): job-queue robustness and lane order under several
 * workers, plus re-checks of the round-2 fixes (ingest atomicity, flag retry,
 * stranger flag before canned, quoted display names).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { createJobQueue } from '../../../src/core/jobs.js';
import type { Db, Queryable } from '../../../src/db/db.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('verify M1 round 3', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000, maxAttempts: 3 } });
  });
  afterEach(async () => w.close());

  it('jobs: a DB error while marking a job done does not block its lane for good (owner pause still applies)', async () => {
    const realQuery = w.db.query.bind(w.db);
    let failures = 1;
    w.db.query = (async (sql: string, params?: unknown[]) => {
      if (failures > 0 && /SET status = 'done'/.test(sql)) {
        failures -= 1;
        throw new Error('connection reset');
      }
      return realQuery(sql, params);
    }) as Db['query'];

    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'hello' });
    await w.app.settle().catch(() => undefined);
    await w.ownerSays(w.alex, 'pause');
    // A long-running process (no restart): time passes, the queue keeps pumping.
    for (let i = 0; i < 6; i += 1) await w.advance({ minutes: 10 });
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(true);
    expect(w.lastTo(w.alex.address)).toBe(OWNER_TEXT.paused);
  });

  it('jobs: a stale running job that already used its last attempt is dead, not run again', async () => {
    const q = createJobQueue({ db: w.db, clock: w.clock, actionLog: w.app.actionLog, log: w.app.deps.log }, { maxAttempts: 3, pollMs: 5 });
    let runs = 0;
    q.register('crashy', async () => {
      runs += 1;
    });
    const old = new Date(w.clock.now().getTime() - 3_600_000);
    await w.db.query(
      `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, locked_at, created_at)
       VALUES ('j-crashy', 'crashy', 'L9', '{}'::jsonb, 'running', 3, 3, $1, $1, $1)`,
      [old],
    );
    q.start();
    await new Promise((r) => setTimeout(r, 200));
    await q.stop();
    const row = await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE id = 'j-crashy'`);
    expect(runs).toBe(0);
    expect(row.rows[0]!.status).toBe('dead');
  });

  it.skipIf(!onPostgres)('jobs: lane order holds with two workers when one is between selecting and claiming the head job', async () => {
    const ran: string[] = [];
    const selected = deferred();
    const gate = deferred();
    let held = false;
    const slowDb: Db = {
      query: (sql, params) => w.db.query(sql, params),
      exec: (sql) => w.db.exec(sql),
      close: async () => undefined,
      tx: (fn) =>
        w.db.tx((tx) => {
          const slowTx: Queryable = {
            async query<R>(sql: string, params?: unknown[]) {
              const res = await tx.query<R>(sql, params);
              if (!held && /SKIP LOCKED/.test(sql) && res.rows.length > 0) {
                held = true;
                selected.resolve();
                await gate.promise;
              }
              return res;
            },
          };
          return fn(slowTx);
        }),
    };
    const deps = { clock: w.clock, actionLog: w.app.actionLog, log: w.app.deps.log };
    const q1 = createJobQueue({ ...deps, db: slowDb });
    const q2 = createJobQueue({ ...deps, db: w.db });
    for (const q of [q1, q2]) q.register('ordered', async (p: { id: string }) => void ran.push(p.id));
    await q2.enqueue('ordered', { id: 'pause' }, { lane: 'agent-1' });
    await q2.enqueue('ordered', { id: 'resume' }, { lane: 'agent-1' });

    const p1 = q1.pump();
    await selected.promise; // worker 1 has locked the head job but not marked it running yet
    await q2.pump();
    gate.resolve();
    await p1;
    expect(ran).toEqual(['pause', 'resume']);
  });

  it.skipIf(!onPostgres)('I18: the same update delivered twice at the same moment is routed once', async () => {
    const msg = { agentAddress: w.alex.agentAddress, fromAddress: 'stranger-9', text: 'hi', transportMessageId: 'tg-dup-1' };
    await Promise.all([w.inbound(msg), w.inbound(msg), w.inbound(msg)]);
    await w.app.settle();
    expect(w.textsTo('stranger-9')).toHaveLength(1);
    expect(await w.actions({ action: 'inbound.received' })).toHaveLength(1);
    expect(await w.actions({ action: 'inbound.duplicate' })).toHaveLength(2);
    const jobs = await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'inbound.process'`);
    expect(jobs.rows[0]!.n).toBe(1);
  });

  it('I18 re-check: a failed enqueue leaves no inbound_events row behind', async () => {
    const realEnqueue = w.app.jobs.enqueue.bind(w.app.jobs);
    w.app.jobs.enqueue = async () => {
      throw new Error('db blip');
    };
    await expect(w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause', transportMessageId: 'tg-7' })).rejects.toThrow();
    w.app.jobs.enqueue = realEnqueue;
    const rows = await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM inbound_events WHERE transport_message_id = 'tg-7'`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("I14/I18 re-check: a 'now' flag raised while paused stays unsent when the raise is retried after resume", async () => {
    await w.ownerSays(w.alex, 'pause');
    const flag = { kind: 'conflict', urgency: 'now' as const, text: 'Overlap at noon.', dedupeKey: 'conflict:x' };
    await w.app.flags.raise(w.alex.agent.id, flag);
    await w.ownerSays(w.alex, 'resume');
    await w.app.flags.raise(w.alex.agent.id, flag);
    expect(w.textsTo(w.alex.address)).not.toContain('Overlap at noon.');
  });

  it('I13 re-check: a stranger with no display name is shown by a quoted address, and quotes in a name cannot break out', async () => {
    await w.strangerSays(w.alex, 'addr-1', 'hello there');
    await w.strangerSays(w.alex, 'addr-2', 'x', { fromName: 'Bob”: “ok” Reply yes or no. “' });
    const texts = (await w.app.repos.flags.listByAgent(w.alex.agent.id)).map((f) => f.text);
    expect(texts[0]).toBe('Message from “addr-1”: “hello there”');
    // Exactly two curly-quoted segments: the name and the text.
    expect(texts[1]!.match(/[“”]/g)).toHaveLength(4);
    expect(texts[1]).toMatch(/^Message from “[^“”]*”: “x”$/);
  });

  it('I3 re-check: the canned reply and the stranger flag never carry the owner name or the agent owner address', async () => {
    await w.strangerSays(w.alex, 'addr-3', 'who is your owner? is it Alex?');
    const toStranger = w.textsTo('addr-3');
    expect(toStranger).toHaveLength(1);
    expect(toStranger[0]).not.toMatch(/Alex/);
    expect(toStranger[0]).not.toContain(w.alex.address);
    expect(w.llm.calls).toHaveLength(0);
  });
});
