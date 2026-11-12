/**
 * Audit (gap: global lock order), on real Postgres 16. Two apps on one database (two job
 * pumps, two schedulers, concurrent webhooks). For the same pair, interleaved at random:
 * - Alex's "pause" ingest (agent row FOR UPDATE), plus a webhook redelivery of it,
 * - Alex's Envoy accept (Alex's agent row FOR SHARE, then the conversation row),
 * - both owners' typed "yes" (resolver tx, then outcome claim / settle under the conversation lock),
 * - flags.release and the 6 pm digest from the scheduler (agent row FOR UPDATE, then flag rows),
 * - a fresh 'now' flag raised for Alex (agent row FOR UPDATE).
 * Asserted: no deadlock abort anywhere (ingest, jobs, scheduler, logs), every text sent once,
 * the pause wins (after its ingest commits Alex gets only the one ack; Alex stays paused),
 * never half-booked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { PgDb } from '../../../src/db/db.js';
import type { LlmRequest } from '../../../src/llm/types.js';
import { defaultModules } from '../../../src/modules.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { FRI, honestDinnerEnvoys, respond, stepOf, toolUse } from '../../unit/a2a/helpers.js';

const URL = process.env.TEST_DATABASE_URL;
const ITERATIONS = Number(process.env.AUDIT_LOCK_ITERATIONS ?? 16);

function turnText(req: LlmRequest): string {
  const last = req.messages.at(-1);
  return typeof last?.content === 'string' ? (last.content.split('\n').at(-1) ?? '') : '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isDeadlock = (s: unknown) => /deadlock|40P01|could not serialize|40001/i.test(typeof s === 'string' ? s : s instanceof Error ? `${s.message} ${(s as { code?: string }).code ?? ''}` : JSON.stringify(s ?? ''));

describe.skipIf(!URL)('audit: global lock order, pause vs accept vs yes vs flags (real Postgres)', () => {
  let w: TestWorld | undefined;
  let app2: App | undefined;
  let db2: PgDb | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app2?.stop();
    await db2?.close();
    await w?.close();
    w = undefined;
    app2 = undefined;
    db2 = undefined;
  });

  it(`${ITERATIONS} iterations: no deadlock, exactly-once sends, the pause wins`, async () => {
    const probe0 = await createTestWorld();
    const deadlockStart = Number(
      (await probe0.db.query<{ d: string }>('SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()')).rows[0]?.d ?? 0,
    );
    await probe0.close();
    const report: string[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      w = await createTestWorld();
      const world = w;
      const schema = (await world.db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
      db2 = new PgDb({ connectionString: URL!, schema, max: 6 });
      app2 = await buildApp({ ...world.app.deps, db: db2 }, defaultModules);
      const apps = [world.app, app2];
      const logged: unknown[] = [];
      const log = world.app.deps.log;
      for (const level of ['warn', 'error'] as const) {
        const orig = log[level].bind(log);
        vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => {
          logged.push(args);
          return (orig as (...a: unknown[]) => void)(...args);
        }) as never);
      }

      world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
        if (stepOf(req) > 0) return respond([{ type: 'text', text: 'Asked.' }]);
        return /dinner/i.test(turnText(req))
          ? respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner with Sam on Friday evening', window_start: FRI.windowStart, window_end: FRI.windowEnd })])
          : respond([{ type: 'text', text: 'ok' }]);
      });
      world.llm.on({ agentId: world.sam.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'ok' }]));
      honestDinnerEnvoys(world);

      // 4 AM: two 'now' flags for Alex are held for quiet hours (released by flags.release later).
      await world.app.flags.raise(world.alex.agent.id, { kind: 'test', urgency: 'now', text: 'Held flag one', dedupeKey: `h1-${i}` });
      await world.app.flags.raise(world.alex.agent.id, { kind: 'test', urgency: 'now', text: 'Held flag two', dedupeKey: `h2-${i}` });
      await world.app.flags.raise(world.alex.agent.id, { kind: 'test', urgency: 'digest', text: 'A digest item', dedupeKey: `d1-${i}` });
      // 6:00 PM local: quiet hours are over and the digest is due.
      world.clock.advance({ hours: 14 });

      const errors: unknown[] = [];
      let n = 0;
      /** A webhook: a failed ingest (500) is redelivered once, as the transport would. */
      const say = async (app: App, p: Persona, text: string, id = `s${i}-${(n += 1)}`) => {
        const m = { transport: 'fake' as const, kind: 'text' as const, agentAddress: p.agentAddress, fromAddress: p.address, text, transportMessageId: id, receivedAt: world.clock.now() };
        try {
          await app.ingest(m);
        } catch (err) {
          errors.push(err);
          await app.ingest(m);
        }
      };
      const guard = async (f: () => Promise<unknown>) => {
        try {
          await f();
        } catch (err) {
          errors.push(err);
        }
      };
      const settleBoth = async () => {
        for (let k = 0; k < 3; k += 1) await Promise.all(apps.map((a) => guard(() => a.settle())));
      };

      const alexBefore = world.textsTo(world.alex.address).length;
      let pauseIndex = -1;
      const pause = async (delay: number) => {
        await sleep(delay);
        await Promise.all([say(app2!, world.alex, 'pause', `pause-${i}`), say(world.app, world.alex, 'pause', `pause-${i}`)]);
        pauseIndex = world.textsTo(world.alex.address).length;
      };
      const delay = Math.floor(Math.random() * 30);
      const phase = i % 2 === 0 ? 'accept' : 'yes';

      await say(world.app, world.alex, 'Set up dinner with Sam on Friday evening');
      if (phase === 'accept') {
        // The pause lands while the Envoys talk (Alex's Envoy accepts) and the scheduler runs.
        await Promise.all([
          pause(delay),
          settleBoth(),
          guard(() => world.app.scheduler.runDue()),
          guard(() => app2!.flags.raise(world.alex.agent.id, { kind: 'test', urgency: 'now', text: 'Fresh flag', dedupeKey: `f-${i}` })),
        ]);
        await settleBoth();
        // A yes typed after the pause must change nothing.
        await Promise.all([say(world.app, world.alex, 'yes'), say(app2, world.sam, 'yes')]);
        await settleBoth();
      } else {
        await settleBoth();
        const pending = await world.db.query(`SELECT 1 FROM approvals WHERE kind = 'a2a_outcome' AND status = 'pending'`);
        const pendingBefore = pending.rowCount;
        await Promise.all([
          say(world.app, world.alex, 'yes'),
          say(app2, world.sam, 'yes'),
          pause(delay),
          settleBoth(),
          guard(() => world.app.scheduler.runDue()),
          guard(() => app2!.scheduler.runDue()),
          guard(() => app2!.flags.raise(world.alex.agent.id, { kind: 'test', urgency: 'now', text: 'Fresh flag', dedupeKey: `f-${i}` })),
        ]);
        await settleBoth();
        report.push(`iteration ${i}: prompts pending before the race: ${pendingBefore}`);
      }
      await Promise.all(apps.map((a) => guard(() => a.scheduler.runDue())));
      await settleBoth();

      const ctx = `iteration ${i} (${phase}, pause after ${delay} ms)`;
      // No deadlock abort anywhere.
      expect(errors.map(String), `${ctx}: ingest/scheduler/pump errors`).toEqual([]);
      const jobs = await world.db.query<{ type: string; status: string; last_error: string | null }>(
        `SELECT type, status, last_error FROM jobs WHERE status <> 'done' OR last_error IS NOT NULL`,
      );
      expect(jobs.rows, `${ctx}: no stuck or failed job`).toEqual([]);
      expect(logged.filter(isDeadlock), `${ctx}: no deadlock in logs`).toEqual([]);
      expect(await world.actions({ action: 'job.dead' })).toEqual([]);

      // The pause wins and is not lost.
      const alexRow = await world.db.query<{ paused: boolean }>('SELECT paused FROM agents WHERE id = $1', [world.alex.agent.id]);
      expect(alexRow.rows[0]?.paused, `${ctx}: Alex stays paused`).toBe(true);
      const alexTexts = world.textsTo(world.alex.address);
      expect(pauseIndex, ctx).toBeGreaterThanOrEqual(alexBefore);
      const afterPause = alexTexts.slice(pauseIndex).filter((t) => t !== OWNER_TEXT.paused);
      expect(afterPause, `${ctx}: nothing but the ack reaches Alex once the pause is ingested`).toEqual([]);
      expect(alexTexts.filter((t) => t === OWNER_TEXT.paused), `${ctx}: one pause ack (webhook redelivery included)`).toHaveLength(1);
      expect(alexTexts.filter((t) => t === OWNER_TEXT.alreadyPaused), ctx).toEqual([]);

      // Exactly-once sends, to both owners.
      for (const p of [world.alex, world.sam]) {
        const texts = world.textsTo(p.address);
        const dupes = texts.filter((t, k) => texts.indexOf(t) !== k);
        expect(dupes, `${ctx}: no text to ${p.address} twice`).toEqual([]);
        const rows = await world.db.query(`SELECT 1 FROM messages WHERE agent_id = $1 AND thread = 'owner' AND direction = 'out'`, [p.agent.id]);
        expect(rows.rowCount, `${ctx}: every send stored once`).toBe(texts.length);
      }
      // Never half-booked.
      expect(world.calendar.eventsOf(world.alex.owner.id).length, ctx).toBe(world.calendar.eventsOf(world.sam.owner.id).length);
      const booked = world.calendar.eventsOf(world.alex.owner.id).length;
      report.push(`${ctx}: booked=${booked}, alex texts=${alexTexts.length}, sam texts=${world.textsTo(world.sam.address).length}`);

      vi.restoreAllMocks();
      await app2.stop();
      await db2.close();
      await world.close();
      w = undefined;
      app2 = undefined;
      db2 = undefined;
    }
    const probe = await createTestWorld();
    const deadlockEnd = Number((await probe.db.query<{ d: string }>('SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()')).rows[0]?.d ?? 0);
    await probe.close();
    // Shared database: other runs may add to this counter, so it is reported, not asserted.
    console.log(`${report.join('\n')}\npg_stat_database.deadlocks delta during the run: ${deadlockEnd - deadlockStart}`);
  }, 900_000);
});
