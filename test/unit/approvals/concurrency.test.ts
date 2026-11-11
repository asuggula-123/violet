import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerMessageCtx } from '../../../src/core/router.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

/** Runs on PGlite by default and on real Postgres under `npm run test:pg` (TEST_DATABASE_URL). */
describe('concurrent resolution', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  async function ownerMessage(text: string): Promise<OwnerMessageCtx> {
    const row = await w.app.repos.messages.add({ agentId: w.alex.agent.id, thread: 'owner', direction: 'in', body: text });
    return {
      agent: w.alex.agent,
      owner: w.alex.owner,
      messageId: row.id,
      msg: { transport: 'fake', agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, kind: 'text', text, transportMessageId: row.id, receivedAt: w.clock.now() },
    };
  }

  it('two yes messages at once: one atomic resolution, one booking', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, {
      kind: 'calendar_event',
      payload: { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' },
    });
    const resolver = w.app.router.hooks.ownerInterceptors[0]!;
    const ctxs = await Promise.all([ownerMessage('yes'), ownerMessage('yes #1'), ownerMessage('👍'), ownerMessage('no')]);
    const handled = await Promise.all(ctxs.map((c) => resolver(c)));
    const row = (await w.app.approvals!.get(a.id))!;
    expect(['executed', 'denied']).toContain(row.status);
    const winner = ctxs.findIndex((c) => c.messageId === row.resolved_by_message_id);
    expect(winner).toBeGreaterThanOrEqual(0);
    const decided = [...(await w.actions({ action: 'approval.approved' })), ...(await w.actions({ action: 'approval.denied' }))];
    expect(decided).toHaveLength(1);
    expect(w.calendar.writes.filter((x) => x.op === 'create').length).toBe(row.status === 'executed' ? 1 : 0);
    // Each loser either looked while #1 was still pending, lost the atomic UPDATE and got the
    // not-open reply, or looked after it was resolved: then a bare yes/no has nothing
    // answerable and is not handled (8.3: falls through to the Brain). The explicit
    // 'yes #1' always names #1, so it is always handled. Which happens is timing only.
    expect(handled[winner]).toBe(true);
    expect(handled[1]).toBe(true);
    const notOpen = new Set((await w.actions({ action: 'approval.not_open' })).map((r) => r.detail.messageId));
    ctxs.forEach((c, i) => {
      if (i !== winner) expect(notOpen.has(c.messageId)).toBe(handled[i]);
    });
    expect(notOpen.size).toBe(handled.filter(Boolean).length - 1);
  });

  it('concurrent requests allocate distinct refs and one approval per idempotency key', async () => {
    const payload = { title: 'Lunch', start: '2026-11-13T12:00:00-05:00', end: '2026-11-13T13:00:00-05:00' };
    const svc = w.app.approvals!;
    const rows = await Promise.all([
      svc.request(w.alex.agent.id, { kind: 'calendar_event', payload }),
      svc.request(w.alex.agent.id, { kind: 'calendar_event', payload }),
      svc.request(w.alex.agent.id, { kind: 'calendar_event', payload, idempotencyKey: 'same' }),
      svc.request(w.alex.agent.id, { kind: 'calendar_event', payload, idempotencyKey: 'same' }),
    ]);
    expect(new Set(rows.map((r) => r.ref)).size).toBe(3);
    expect(rows[2]!.id).toBe(rows[3]!.id);
    expect(await svc.listPending(w.alex.agent.id)).toHaveLength(3);
  });

  it('two writers executing the same approved approval at once book it once', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, {
      kind: 'calendar_event',
      payload: { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' },
    });
    await w.db.query(`UPDATE approvals SET status = 'approved' WHERE id = $1`, [a.id]);
    const results = await Promise.all([w.app.approvals!.calendar.executeApproved(a.id), w.app.approvals!.calendar.executeApproved(a.id)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    const writes = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_writes');
    expect(writes.rows[0]!.n).toBe(1);
    expect((await w.actions({ action: 'approval.executed' })).length).toBe(1);
  });
});
