import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalsRepo } from '../../../src/approvals/repo.js';
import { composePrompt } from '../../../src/approvals/service.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

const dinner = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };

describe('approvals: only a prompt the owner had seen can be answered (principle 5)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  const status = async (a: ApprovalRow) => (await w.app.approvals!.get(a.id))!.status;
  const lastOwnerMessageId = async () =>
    (
      await w.db.query<{ id: string }>(
        `SELECT id FROM messages WHERE agent_id = $1 AND thread = 'owner' AND direction = 'in' ORDER BY seq DESC LIMIT 1`,
        [w.alex.agent.id],
      )
    ).rows[0]!.id;

  it('a message stored before the prompt went out neither answers it implicitly nor by its ref', async () => {
    await w.ownerSays(w.alex, 'hello');
    const before = await lastOwnerMessageId();
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    const repo = approvalsRepo(w.db, w.clock);
    expect(await repo.listAnswerable(w.alex.agent.id, before)).toEqual([]);
    expect(await repo.existedBefore(a.id, before)).toBe(false);
    await w.ownerSays(w.alex, 'thanks'); // not a decision: goes to the Brain
    const after = await lastOwnerMessageId();
    expect((await repo.listAnswerable(w.alex.agent.id, after)).map((x) => x.id)).toEqual([a.id]);
    expect(await repo.existedBefore(a.id, after)).toBe(true);
  });

  it('a "yes" that arrived before the prompt went out, but was stored after it (queued in the lane), answers nothing', async () => {
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'no 1' });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    expect(a.prompt_transport_message_id).not.toBeNull();
    await w.app.settle();
    expect(await status(a)).toBe('pending');
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(0);
    expect(await w.actions({ action: 'approval.denied' })).toHaveLength(0);
    // Written after the prompt was delivered, but not right under it (I19: the replies to the
    // queued messages came after the prompt): the prompt is shown again; a yes under that answers it.
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).toBe('pending');
    expect(await w.actions({ action: 'approval.reprompted' })).toHaveLength(1);
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).not.toBe('pending');
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(1);
  });

  it('an undelivered prompt is not answerable implicitly even after the owner wrote', async () => {
    w.transport.failNext(1);
    await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await w.ownerSays(w.alex, 'hi');
    expect(await approvalsRepo(w.db, w.clock).listAnswerable(w.alex.agent.id, await lastOwnerMessageId())).toEqual([]);
  });

  it('a reply-to on a non-prompt message with one approval pending shows its prompt again and resolves nothing', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: 'not-a-prompt' });
    expect(await status(a)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toMatch(/^Just to be sure: #1 Dinner/);
    expect((await w.actions({ action: 'approval.reprompted' })).map((r) => r.detail.reason)).toEqual(['reply_to_non_prompt']);
  });

  it('a calendar_event approval expires no later than the event start; the writer refuses a started event', async () => {
    const start = new Date(w.clock.now().getTime() + 3_600_000);
    const end = new Date(start.getTime() + 1_800_000);
    const a = await w.app.approvals!.request(w.alex.agent.id, {
      kind: 'calendar_event',
      payload: { title: 'Call', start: start.toISOString().replace('Z', '+00:00'), end: end.toISOString().replace('Z', '+00:00') },
    });
    expect(a.expires_at.getTime()).toBe(start.getTime());
    // Defence in depth: approved in time, executed after the start.
    await w.db.query(`UPDATE approvals SET status = 'approved', resolved_at = $2 WHERE id = $1`, [a.id, w.clock.now()]);
    w.clock.advance({ hours: 2 });
    const res = await w.app.approvals!.calendar.executeApproved(a.id);
    expect(res).toEqual({ ok: false, reason: 'the event has already started' });
    expect(w.calendar.writes).toEqual([]);
    expect(await status(a)).toBe('failed');
  });

  it('composePrompt removes every number sign that folds to #', () => {
    const p = composePrompt(3, 'A ＃9 B ﹟8 C #7');
    expect(p.normalize('NFKC').match(/#/g)).toHaveLength(1);
    expect(p.startsWith('#3 ')).toBe(true);
  });
});
