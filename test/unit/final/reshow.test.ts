/**
 * S1: one message made Violet ask twice. After a typed answer resolves one of them, the one
 * other approval still pending in RUN(m) is shown again right below the confirmation line, as a
 * genuine delivery (approval_deliveries kind 'reprompt'). The next bare yes or no then answers
 * it under the unchanged I19 rule. Idempotent on a retried hook; never while paused; not with
 * two or more others pending; not after a button press (it has no chat number, so no RUN).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond, stepOf, toolUse } from '../a2a/helpers.js';
import { i19Violations } from '../i19/helpers.js';
import { DINNER, DINNER_PROMPT } from '../seam/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const LUNCH = { title: 'Lunch', start: '2026-11-13T12:00:00-05:00', end: '2026-11-13T13:00:00-05:00' };
const BREAKFAST = { title: 'Breakfast', start: '2026-11-13T08:00:00-05:00', end: '2026-11-13T09:00:00-05:00' };
const LUNCH_PROMPT = '#2 Lunch — Fri Nov 13, 12:00–1:00 PM. Book it? Reply yes or no.';

/** One owner message, two (or three) prompts from one Brain turn. */
async function asks(events: Array<Record<string, unknown>>, world?: Parameters<typeof createTestWorld>[0]): Promise<void> {
  w = await createTestWorld(world);
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
    stepOf(req) === 0 ? respond(events.map((e, i) => toolUse(`c${i}`, 'request_calendar_event', e))) : respond([{ type: 'text', text: 'Asked.' }]),
  );
  await w.ownerSays(w.alex, 'book these');
}

const status = async (ref: number) => (await w.db.query<{ status: string }>('SELECT status FROM approvals WHERE agent_id = $1 AND ref = $2', [w.alex.agent.id, ref])).rows[0]?.status;
const reshows = async () => (await w.db.query<{ approval_id: string; kind: string; sent: boolean }>("SELECT approval_id, kind, transport_message_id IS NOT NULL AS sent FROM approval_deliveries WHERE for_message_id IS NOT NULL")).rows;
const brainCalls = () => w.llm.calls.filter((c) => c.meta.mind === 'brain').length;

describe('S1: the one other prompt of the same run is shown again', () => {
  it('yes 1 books #1, then #2 is shown again below the confirmation; the next bare yes books #2', async () => {
    await asks([DINNER, LUNCH]);
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.textsTo(w.alex.address).slice(-2)).toEqual(['Booked: Dinner — Fri Nov 13, 7:00–8:30 PM.', `${REPROMPT_PREFIX}${LUNCH_PROMPT}`]);
    expect(await status(2)).toBe('pending');
    expect(await reshows()).toHaveLength(1);
    expect((await w.actions({ action: 'approval.reprompted' })).map((a) => a.detail.reason)).toEqual(['next_in_run']);
    const calls = brainCalls();
    await w.ownerSays(w.alex, 'yes');
    expect([await status(1), await status(2)]).toEqual(['executed', 'executed']);
    expect(brainCalls()).toBe(calls);
    expect(await i19Violations(w)).toEqual([]);
  });

  it('a no works the same way: no 2, then #1 is shown again, and a no under it declines #1', async () => {
    await asks([DINNER, LUNCH]);
    await w.ownerSays(w.alex, 'no 2');
    expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${DINNER_PROMPT(1)}`);
    await w.ownerSays(w.alex, 'no');
    expect([await status(1), await status(2)]).toEqual(['denied', 'denied']);
    expect(w.calendar.writes).toEqual([]);
    expect(await i19Violations(w)).toEqual([]);
  });

  it('a retried hook shows it once: one re-show row, one message', async () => {
    await asks([DINNER, LUNCH], { jobs: { backoffMs: () => 1_000 } });
    const write = w.app.actionLog.write.bind(w.app.actionLog);
    let failed = false;
    w.app.actionLog.write = async (entry, q) => {
      if (!failed && entry.action === 'approval.reprompted') {
        failed = true;
        throw new Error('worker lost after the re-show');
      }
      return write(entry, q);
    };
    await w.ownerSays(w.alex, 'yes 1');
    await w.advance({ seconds: 5 });
    expect(failed).toBe(true);
    expect(await reshows()).toEqual([expect.objectContaining({ kind: 'reprompt', sent: true })]);
    expect(w.textsTo(w.alex.address).filter((t) => t === `${REPROMPT_PREFIX}${LUNCH_PROMPT}`)).toHaveLength(1);
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
  });

  it('two others still pending: nothing is shown again; a bare yes then asks "Which one?"', async () => {
    await asks([DINNER, LUNCH, BREAKFAST]);
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)).toBe('Booked: Dinner — Fri Nov 13, 7:00–8:30 PM.');
    expect(await reshows()).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect([await status(2), await status(3)]).toEqual(['pending', 'pending']);
    expect(w.textsTo(w.alex.address).some((t) => t.startsWith('Which one?'))).toBe(true);
  });

  it('a pause that lands during the resolution: nothing is shown again, then or on resume', async () => {
    await asks([DINNER, LUNCH]);
    const svc = w.app.approvals! as unknown as { kindContext: (x: unknown) => Promise<unknown> };
    const kindContext = svc.kindContext.bind(svc);
    svc.kindContext = async (x) => {
      svc.kindContext = kindContext;
      const out = await kindContext(x);
      await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
      return out;
    };
    await w.ownerSays(w.alex, 'yes 1');
    expect(await reshows()).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    expect(w.transport.sent.filter((m) => m.text.startsWith(REPROMPT_PREFIX))).toEqual([]);
    // The booking itself was held at its write by the same pause (F2) and goes ahead now.
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Booked: Dinner'))).toHaveLength(1);
  });

  it('a button press has no chat number, so it shows nothing again (the other button still answers it)', async () => {
    await asks([DINNER, LUNCH]);
    const ids = (await w.db.query<{ id: string }>('SELECT id FROM approvals ORDER BY ref')).rows.map((r) => r.id);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${ids[0]}` });
    expect(await reshows()).toEqual([]);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${ids[1]}` });
    expect([await status(1), await status(2)]).toEqual(['executed', 'executed']);
  });
});
