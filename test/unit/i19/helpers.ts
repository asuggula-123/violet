/**
 * I19 test helpers: the invariant checked from stored rows, and small shorthands.
 */
import { parseDecision } from '../../../src/approvals/resolver.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { idsAbove } from '../../../src/transport/chatOrder.js';
import type { Persona, TestWorld } from '../../helpers/world.js';

export const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
export const LUNCH = { title: 'Lunch', start: '2026-11-12T12:00:00-05:00', end: '2026-11-12T13:00:00-05:00' };

/** An approval requested outside any Brain turn: its prompt goes out at once. */
export function ask(w: TestWorld, p: Persona, payload: Record<string, unknown> = DINNER): Promise<ApprovalRow> {
  return w.app.approvals!.request(p.agent.id, { kind: 'calendar_event', payload });
}

export const statusOf = async (w: TestWorld, a: { id: string }) => (await w.app.approvals!.get(a.id))!.status;

/** The transport id of the last genuine prompt (any delivery) sent to the persona. */
export function lastPromptId(w: TestWorld, p: Persona): string {
  return w.transport.sent.filter((m) => m.toAddress === p.address && m.purpose === 'approval').at(-1)!.transportMessageId;
}

export const count = async (w: TestWorld, action: string) => (await w.actions({ action })).length;

/**
 * Invariant I19, checked from stored rows only (messages, approval_deliveries, action_log):
 * every approval.approved / approval.denied with via 'text' was a reply-to on a genuine
 * delivery of that approval, or a genuine delivery of it was in RUN(m) — and for a bare
 * answer it was the only approval in RUN(m), closed or not.
 */
export async function i19Violations(w: TestWorld): Promise<string[]> {
  const deliveries = (
    await w.db.query<{ agent_id: string; approval_id: string; transport_message_id: string }>(
      'SELECT agent_id, approval_id, transport_message_id FROM approval_deliveries WHERE transport_message_id IS NOT NULL',
    )
  ).rows;
  const genuine = new Map(deliveries.map((d) => [`${d.agent_id}|${d.transport_message_id}`, d.approval_id]));
  const all = await w.actions();
  const out: string[] = [];
  for (const row of all) {
    if ((row.action !== 'approval.approved' && row.action !== 'approval.denied') || row.detail.via !== 'text') continue;
    const approvalId = String(row.detail.approvalId);
    const m = (
      await w.db.query<{ body: string; reply_to_transport_message_id: string | null; meta: Record<string, unknown> }>(
        'SELECT body, reply_to_transport_message_id, meta FROM messages WHERE id = $1',
        [row.detail.messageId],
      )
    ).rows[0];
    if (!m) {
      out.push(`${row.id}: no stored message`);
      continue;
    }
    const agent = row.agent_id!;
    if (m.reply_to_transport_message_id && genuine.get(`${agent}|${m.reply_to_transport_message_id}`) === approvalId) continue;
    const run: string[] = [];
    for (const id of idsAbove(m.meta.chatMessageId as string | undefined, 50)) {
      const a = genuine.get(`${agent}|${id}`);
      if (!a) break;
      run.push(a);
    }
    if (!run.includes(approvalId)) {
      out.push(`${row.id}: "${m.body}" resolved ${approvalId} with no genuine delivery of it replied to or right above`);
      continue;
    }
    if (parseDecision(m.body)?.ref !== undefined) continue;
    // I19 (since 305a14a, P11): a bare answer resolves only when it is the ONLY approval in RUN(m),
    // closed or not: an approval that closed earlier still made the answer ambiguous.
    for (const other of new Set(run.filter((a) => a !== approvalId))) {
      out.push(`${row.id}: bare "${m.body}" resolved ${approvalId} while ${other} was also right above`);
    }
  }
  return out;
}
