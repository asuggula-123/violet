import { randomUUID } from 'node:crypto';
import { addMs } from '../clock.js';
import type { AgentRow } from '../core/types.js';
import type { Queryable } from '../db/db.js';
import type { A2ADeps } from './deps.js';
import { Refusal } from './deps.js';
import { talkingLine, toldLine } from './render.js';
import { a2aRepo, conversationColumns, firstName, isParty, queueNotice, writeMessage } from './repo.js';
import { A2A_LIMITS, DAY_MS, type ConversationRow } from './types.js';

export const AFTER_JOB = 'a2a.after';
export type AfterEvent = 'opened' | 'closed' | 'booked';

export interface OpenRequest {
  initiator: AgentRow;
  responder: AgentRow;
  householdId: string;
  topic: string;
  brief: string;
  window: { start: Date; end: Date } | null;
  /** Idempotency key: the same key opens one conversation, ever. */
  key: string;
  /** Queue the code-rendered "Talking to …" line (false when it is the reply to an approval). */
  notice: boolean;
}

/** I12 per-pair limits, counted under the household lock so concurrent opens cannot exceed them. */
async function checkPairLimits(tx: Queryable, a: string, b: string, now: Date): Promise<void> {
  const res = await tx.query<{ open: number; recent: number }>(
    `SELECT count(*) FILTER (WHERE status <> 'closed')::int AS open, count(*) FILTER (WHERE created_at > $3)::int AS recent
     FROM a2a_conversations
     WHERE (initiator_agent_id = $1 AND responder_agent_id = $2) OR (initiator_agent_id = $2 AND responder_agent_id = $1)`,
    [a, b, addMs(now, -DAY_MS)],
  );
  const { open, recent } = res.rows[0]!;
  if (open >= A2A_LIMITS.openPerPair) throw new Refusal('open_per_pair', `There are already ${open} open conversations with that agent. End one first.`, true);
  if (recent >= A2A_LIMITS.newPerPairPerDay) throw new Refusal('new_per_day', 'Too many new conversations with that agent in the last 24 hours. Try again later.', true);
}

/** Creates the conversation, both sides and the `open` message (delivered to the responder), in one transaction. */
export async function openConversation(d: A2ADeps, r: OpenRequest): Promise<{ conv: ConversationRow; line: string }> {
  const peerLabel = `${firstName((await d.repos.owners.get(r.responder.owner_id))?.name ?? '')}'s ${r.responder.name}`;
  const line = talkingLine(peerLabel, r.topic, r.brief);
  const conv = await d.db.tx(async (tx) => {
    await tx.query('SELECT id FROM households WHERE id = $1 FOR UPDATE', [r.householdId]);
    const existing = await tx.query<ConversationRow>(`SELECT ${conversationColumns} FROM a2a_conversations WHERE open_key = $1`, [r.key]);
    if (existing.rows[0]) return existing.rows[0];
    const now = d.clock.now();
    await checkPairLimits(tx, r.initiator.id, r.responder.id, now);
    const created = await tx.query<ConversationRow>(
      `INSERT INTO a2a_conversations (id, household_id, initiator_agent_id, responder_agent_id, topic, status, window_start, window_end,
         open_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $9) RETURNING ${conversationColumns}`,
      [randomUUID(), r.householdId, r.initiator.id, r.responder.id, r.topic, r.window?.start ?? null, r.window?.end ?? null, r.key, now],
    );
    const c = created.rows[0]!;
    await tx.query(
      `INSERT INTO a2a_sides (conversation_id, agent_id, role, brief, messages_sent) VALUES ($1, $2, 'initiator', $3, 1), ($1, $4, 'responder', NULL, 0)`,
      [c.id, r.initiator.id, r.brief, r.responder.id],
    );
    const window = r.window ? { window_start: r.window.start.toISOString(), window_end: r.window.end.toISOString() } : {};
    await writeMessage(tx, d, { conv: c, from: r.initiator.id, kind: 'open', body: r.brief, payload: { topic: r.topic, ...window }, turnKey: `open:${r.key}`, deliverTo: [r.responder.id] });
    await d.actionLog.write(
      { agentId: r.initiator.id, actor: 'brain', action: 'a2a.opened', detail: { conversationId: c.id, peer: r.responder.id, window: r.window !== null } },
      tx,
    );
    await d.jobs.enqueue(AFTER_JOB, { conversationId: c.id, event: 'opened' }, { dedupeKey: `a2a:after:${c.id}:opened`, tx });
    if (r.notice) await queueNotice(tx, d, { id: `talking:${c.id}`, agentId: r.initiator.id, purpose: 'reply', text: line, tainted: false });
    return c;
  });
  return { conv, line };
}

/** Owner guidance for its own Envoy: stored private to that side; the Envoy runs a turn on it (if the conversation is open). */
export async function addGuidance(
  d: A2ADeps,
  g: { agentId: string; conversationId: string; text: string; key: string; notice: boolean },
): Promise<{ conv: ConversationRow; line: string }> {
  return d.db.tx(async (tx) => {
    const repo = a2aRepo(tx);
    const conv = await repo.lock(g.conversationId);
    if (!conv || !isParty(conv, g.agentId)) throw new Refusal('unknown_conversation', 'There is no such conversation.');
    const parties = await repo.parties(conv, g.agentId);
    const line = toldLine(parties.peerLabel, g.text);
    if (await repo.byTurnKey(`guidance:${g.key}`)) return { conv, line };
    if (conv.status === 'closed') throw new Refusal('closed', 'That conversation is closed. Start a new one with talk_to_agent.');
    await writeMessage(tx, d, {
      conv,
      from: g.agentId,
      privateTo: g.agentId,
      kind: 'guidance',
      body: g.text,
      turnKey: `guidance:${g.key}`,
      deliverTo: conv.status === 'open' ? [g.agentId] : [],
    });
    await tx.query('UPDATE a2a_sides SET awaiting_owner = false, stalled = false WHERE conversation_id = $1 AND agent_id = $2', [conv.id, g.agentId]);
    if (g.notice) await queueNotice(tx, d, { id: `told:${g.key}`, agentId: g.agentId, purpose: 'reply', text: line, tainted: false });
    return { conv, line };
  });
}

/**
 * Closes a locked conversation (inside the caller's transaction): status, a `close` message
 * the other side sees, and the after-job (closing flags, pending outcome approvals cancelled).
 */
export async function closeInTx(
  tx: Queryable,
  d: Pick<A2ADeps, 'clock' | 'jobs' | 'actionLog'>,
  conv: ConversationRow,
  c: { by: string | null; reason: string; body: string; turnKey?: string },
): Promise<void> {
  const now = d.clock.now();
  await tx.query(`UPDATE a2a_conversations SET status = 'closed', closed_at = $2, close_reason = $3 WHERE id = $1`, [conv.id, now, c.reason]);
  await writeMessage(tx, d, { conv, from: c.by, kind: 'close', body: c.body, payload: { reason: c.reason }, turnKey: c.turnKey ?? null });
  await d.actionLog.write({ agentId: c.by, actor: c.by ? 'envoy' : 'system', action: 'a2a.closed', detail: { conversationId: conv.id, reason: c.reason } }, tx);
  await d.jobs.enqueue(AFTER_JOB, { conversationId: conv.id, event: 'closed', groupId: conv.outcome_group_id }, { dedupeKey: `a2a:after:${conv.id}:closed`, tx });
}

/** The owner ends a conversation (end_agent_conversation). */
export async function endByOwner(d: A2ADeps, agentId: string, conversationId: string): Promise<ConversationRow> {
  return d.db.tx(async (tx) => {
    const repo = a2aRepo(tx);
    const conv = await repo.lock(conversationId);
    if (!conv || !isParty(conv, agentId)) throw new Refusal('unknown_conversation', 'There is no such conversation.');
    if (conv.status === 'closed') return conv;
    const parties = await repo.parties(conv, agentId);
    // A booking being settled (I7) keeps outcome_state 'booking': the booking sweep still
    // finishes it (undoing whatever is on a calendar, writing nothing new) and tells both owners.
    await closeInTx(tx, d, conv, { by: agentId, reason: 'owner_ended', body: `${parties.me.first} ended the conversation.` });
    return conv;
  });
}

/** Idle conversations (no message for 24 h) → closed with reason 'expired' (I12). */
export async function expireIdle(d: A2ADeps): Promise<number> {
  const cutoff = addMs(d.clock.now(), -A2A_LIMITS.idleMs);
  // A booking in progress is never closed under it: the booking sweep settles it first (I7).
  const idle = await d.db.query<{ id: string }>(
    `SELECT id FROM a2a_conversations WHERE status <> 'closed' AND updated_at <= $1 AND outcome_state IS DISTINCT FROM 'booking' ORDER BY seq`,
    [cutoff],
  );
  let closed = 0;
  for (const { id } of idle.rows) {
    const done = await d.db.tx(async (tx) => {
      const conv = await a2aRepo(tx).lock(id);
      if (!conv || conv.status === 'closed' || conv.outcome_state === 'booking' || conv.updated_at.getTime() > cutoff.getTime()) return false;
      await closeInTx(tx, d, conv, { by: null, reason: 'expired', body: 'No activity for 24 hours: the conversation expired.' });
      return true;
    });
    if (done) closed += 1;
  }
  return closed;
}
