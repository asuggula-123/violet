/**
 * Locks (gfix × M4), on real Postgres: app.ingest and the router's 'route' step take the agent row
 * FOR UPDATE; an Envoy act takes its own agent row FOR SHARE, then the conversation row; booking
 * claims the conversation row while both approvals are bookable. Two apps on one database, both
 * owners texting while a conversation runs and both approving at the same moment: no deadlock,
 * no stuck job, one booking each.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import { PgDb } from '../../../src/db/db.js';
import type { LlmRequest } from '../../../src/llm/types.js';
import { defaultModules } from '../../../src/modules.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { FRI, honestDinnerEnvoys, respond, stepOf, toolUse } from '../a2a/helpers.js';

const URL = process.env.TEST_DATABASE_URL;
const ITERATIONS = 20;
const BOOKED = 'Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.';

/** The text of the turn's own (last) user message. */
function turnText(req: LlmRequest): string {
  const last = req.messages.at(-1);
  return typeof last?.content === 'string' ? (last.content.split('\n').at(-1) ?? '') : '';
}

describe.skipIf(!URL)('lock order under concurrency (real Postgres)', () => {
  let w: TestWorld | undefined;
  let app2: App | undefined;
  let db2: PgDb | undefined;
  afterEach(async () => {
    await app2?.stop();
    await db2?.close();
    await w?.close();
    w = undefined;
    app2 = undefined;
    db2 = undefined;
  });

  it(`${ITERATIONS} iterations: chatter while the Envoys talk, both owners approve at once`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      w = await createTestWorld();
      const world = w;
      const schema = (await world.db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
      db2 = new PgDb({ connectionString: URL!, schema, max: 4 });
      app2 = await buildApp({ ...world.app.deps, db: db2 }, defaultModules);
      const apps = [world.app, app2];

      world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
        if (stepOf(req) > 0) return respond([{ type: 'text', text: 'Asked.' }]);
        return /dinner/i.test(turnText(req))
          ? respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner with Sam on Friday evening', window_start: FRI.windowStart, window_end: FRI.windowEnd })])
          : respond([{ type: 'text', text: 'ok' }]);
      });
      world.llm.on({ agentId: world.sam.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'ok' }]));
      honestDinnerEnvoys(world);

      let n = 0;
      const say = (app: App, p: Persona, text: string) =>
        app.ingest({ transport: 'fake', kind: 'text', agentAddress: p.agentAddress, fromAddress: p.address, text, transportMessageId: `s${i}-${(n += 1)}`, receivedAt: world.clock.now() });
      const settleBoth = async () => {
        await Promise.all(apps.map((a) => a.settle()));
        await Promise.all(apps.map((a) => a.settle()));
      };

      await say(world.app, world.alex, 'Set up dinner with Sam on Friday evening');
      await Promise.all([say(app2, world.sam, 'how is my week'), say(world.app, world.alex, 'and remind me later'), say(app2, world.alex, 'thanks')]);
      await settleBoth();
      const pending = await world.db.query<{ agent_id: string }>(`SELECT agent_id FROM approvals WHERE kind = 'a2a_outcome' AND status = 'pending'`);
      expect(pending.rowCount, `iteration ${i}: both prompts out`).toBe(2);

      await Promise.all([say(world.app, world.alex, 'yes'), say(app2, world.sam, 'yes')]);
      await Promise.all([say(app2, world.alex, 'great'), say(world.app, world.sam, 'nice')]);
      await settleBoth();

      const jobs = await world.db.query<{ type: string; status: string; last_error: string | null }>(`SELECT type, status, last_error FROM jobs WHERE status <> 'done' OR last_error IS NOT NULL`);
      expect(jobs.rows, `iteration ${i}: no stuck or failed job`).toEqual([]);
      expect(await world.actions({ action: 'job.dead' })).toEqual([]);
      for (const p of [world.alex, world.sam]) {
        expect(world.calendar.eventsOf(p.owner.id), `iteration ${i}`).toHaveLength(1);
        expect(world.textsTo(p.address).filter((t) => t === BOOKED)).toHaveLength(1);
      }
      const conv = await world.db.query<{ status: string; outcome_state: string }>('SELECT status, outcome_state FROM a2a_conversations');
      expect(conv.rows).toEqual([{ status: 'closed', outcome_state: 'booked' }]);

      await app2.stop();
      await db2.close();
      await world.close();
      w = undefined;
      app2 = undefined;
      db2 = undefined;
    }
  }, 600_000);
});
