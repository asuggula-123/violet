import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Queryable } from '../db/db.js';
import type { ApprovalRow, ApprovalStatus } from './types.js';

const COLUMNS = `id, agent_id, ref, kind, payload, prompt, status, group_id, prompt_transport_message_id, idempotency_key,
  created_at, expires_at, resolved_at, resolved_by_message_id, executed_at, error`;
/** COLUMNS qualified with the alias `a`. */
const A_COLUMNS = COLUMNS.split(',').map((c) => `a.${c.trim()}`).join(', ');
/**
 * Highest inbound_events.arrival_seq handed out so far, committed or not (nextval is not
 * transactional, so an event still being ingested is counted as already arrived).
 */
const ARRIVAL_MARK = `(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM inbound_events_arrival_seq_seq)`;
/** Arrival seq of the inbound event that stored owner message `m` (NULL if unknown). */
const ARRIVAL_OF_M = `(SELECT e.arrival_seq FROM inbound_events e WHERE e.id = m.meta->>'inboundEventId')`;

export interface NewApproval {
  agentId: string;
  kind: string;
  payload: unknown;
  /** Builds the prompt once the ref is known. */
  prompt(ref: number): string;
  groupId: string | null;
  expiresAt: Date;
  idempotencyKey: string | null;
}

export function approvalsRepo(db: Queryable, clock: Clock) {
  const one = async (sql: string, params: unknown[]) => (await db.query<ApprovalRow>(sql, params)).rows[0] ?? null;

  return {
    /** Allocates the next per-agent ref and inserts, both in `db` (call inside a transaction). */
    async insert(a: NewApproval): Promise<ApprovalRow> {
      const counter = await db.query<{ last_ref: number }>(
        `INSERT INTO approval_refs (agent_id, last_ref) VALUES ($1, 1)
         ON CONFLICT (agent_id) DO UPDATE SET last_ref = approval_refs.last_ref + 1 RETURNING last_ref`,
        [a.agentId],
      );
      const ref = counter.rows[0]!.last_ref;
      const res = await db.query<ApprovalRow>(
        `INSERT INTO approvals (id, agent_id, ref, kind, payload, prompt, status, group_id, idempotency_key, created_at, expires_at,
           created_after_message_seq, created_after_arrival_seq)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7, $8, $9, $10,
           (SELECT COALESCE(max(seq), 0) FROM messages WHERE agent_id = $2), ${ARRIVAL_MARK}) RETURNING ${COLUMNS}`,
        [randomUUID(), a.agentId, ref, a.kind, JSON.stringify(a.payload), a.prompt(ref), a.groupId, a.idempotencyKey, clock.now(), a.expiresAt],
      );
      return res.rows[0]!;
    },
    get: (id: string) => one(`SELECT ${COLUMNS} FROM approvals WHERE id = $1`, [id]),
    byKey: (agentId: string, key: string) => one(`SELECT ${COLUMNS} FROM approvals WHERE agent_id = $1 AND idempotency_key = $2`, [agentId, key]),
    byRef: (agentId: string, ref: number) => one(`SELECT ${COLUMNS} FROM approvals WHERE agent_id = $1 AND ref = $2`, [agentId, ref]),
    byPromptMessage: (agentId: string, transportMessageId: string) =>
      one(`SELECT ${COLUMNS} FROM approvals WHERE agent_id = $1 AND prompt_transport_message_id = $2`, [agentId, transportMessageId]),
    resolvedBy: (agentId: string, messageId: string) =>
      one(`SELECT ${COLUMNS} FROM approvals WHERE agent_id = $1 AND resolved_by_message_id = $2 ORDER BY seq LIMIT 1`, [agentId, messageId]),
    /** Pending and not past expires_at (an approval past it is closed even before the sweep marks it). */
    async listPending(agentId: string): Promise<ApprovalRow[]> {
      const res = await db.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM approvals WHERE agent_id = $1 AND status = 'pending' AND expires_at > $2 ORDER BY seq`,
        [agentId, clock.now()],
      );
      return res.rows;
    },
    /**
     * Principle 5: the pending approvals the owner's message `messageId` can answer
     * implicitly: their prompt was delivered (its outbound row exists) BEFORE that message
     * was stored, and before the message's inbound event ARRIVED (ingest), so a "yes"
     * queued in the lane behind the Brain turn that created the prompt does not count
     * either. A "yes" typed, queued or retried before a prompt went out never answers it.
     */
    async listAnswerable(agentId: string, messageId: string): Promise<ApprovalRow[]> {
      const res = await db.query<ApprovalRow>(
        `SELECT ${A_COLUMNS} FROM approvals a
         WHERE a.agent_id = $1 AND a.status = 'pending' AND a.expires_at > $3 AND a.prompt_transport_message_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM messages p, messages m
             WHERE m.id = $2 AND m.agent_id = a.agent_id
               AND p.agent_id = a.agent_id AND p.thread = 'owner' AND p.direction = 'out'
               AND p.transport_message_id = a.prompt_transport_message_id AND p.seq < m.seq
               AND a.prompt_sent_after_arrival_seq IS NOT NULL
               AND COALESCE(${ARRIVAL_OF_M} > a.prompt_sent_after_arrival_seq, true))
         ORDER BY a.seq`,
        [agentId, messageId, clock.now()],
      );
      return res.rows;
    },
    /**
     * Whether the approval already existed when message `messageId` was written: created
     * before the message was stored AND before its inbound event arrived (a "yes 1" queued
     * in the lane before #1 existed names something else).
     */
    async existedBefore(approvalId: string, messageId: string): Promise<boolean> {
      const res = await db.query(
        `SELECT 1 FROM approvals a JOIN messages m ON m.id = $2 AND m.agent_id = a.agent_id
         WHERE a.id = $1 AND m.seq > a.created_after_message_seq
           AND COALESCE(${ARRIVAL_OF_M} > a.created_after_arrival_seq, true)`,
        [approvalId, messageId],
      );
      return res.rows.length > 0;
    },
    async listUnsent(agentId: string): Promise<ApprovalRow[]> {
      const res = await db.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM approvals
         WHERE agent_id = $1 AND status = 'pending' AND expires_at > $2 AND prompt_transport_message_id IS NULL ORDER BY seq`,
        [agentId, clock.now()],
      );
      return res.rows;
    },
    /**
     * Claims the right to send a prompt: one atomic UPDATE, so of any concurrent senders
     * (request, resume, sweep, raced idempotent requests) exactly one wins. The claim lapses
     * after `leaseMs` so a sender that died mid-send does not block delivery forever.
     */
    async claimSend(id: string, leaseMs: number): Promise<boolean> {
      const now = clock.now();
      const res = await db.query(
        `UPDATE approvals SET prompt_sending_until = $3
         WHERE id = $1 AND status = 'pending' AND expires_at > $2 AND prompt_transport_message_id IS NULL
           AND (prompt_sending_until IS NULL OR prompt_sending_until <= $2)`,
        [id, now, new Date(now.getTime() + leaseMs)],
      );
      return res.rowCount === 1;
    },
    async releaseSend(id: string): Promise<void> {
      await db.query('UPDATE approvals SET prompt_sending_until = NULL WHERE id = $1 AND prompt_transport_message_id IS NULL', [id]);
    },
    async markSent(id: string, transportMessageId: string): Promise<void> {
      await db.query(
        `UPDATE approvals SET prompt_transport_message_id = $2, prompt_sending_until = NULL,
           prompt_sent_after_arrival_seq = ${ARRIVAL_MARK}
         WHERE id = $1 AND prompt_transport_message_id IS NULL`,
        [id, transportMessageId],
      );
    },
    /**
     * The one resolution statement: pending → approved/denied, atomically. Returns null when
     * the approval was not pending for this agent (someone else resolved it first) or is
     * past expires_at (closed, even if the sweep has not marked it expired yet).
     */
    resolvePending: (id: string, agentId: string, status: 'approved' | 'denied', messageId: string) =>
      one(
        `UPDATE approvals SET status = $3, resolved_at = $4, resolved_by_message_id = $5
         WHERE id = $1 AND agent_id = $2 AND status = 'pending' AND expires_at > $4 RETURNING ${COLUMNS}`,
        [id, agentId, status, clock.now(), messageId],
      ),
    cancelPending: (id: string, reason: string) =>
      one(
        `UPDATE approvals SET status = 'cancelled', resolved_at = $2, error = $3 WHERE id = $1 AND status = 'pending' RETURNING ${COLUMNS}`,
        [id, clock.now(), reason],
      ),
    async expireDue(agentId: string): Promise<ApprovalRow[]> {
      const now = clock.now();
      const res = await db.query<ApprovalRow>(
        `UPDATE approvals SET status = 'expired', resolved_at = $2
         WHERE agent_id = $1 AND status = 'pending' AND expires_at <= $2 RETURNING ${COLUMNS}`,
        [agentId, now],
      );
      return res.rows;
    },
    /** approved → executed / failed. Returns false if the approval was no longer approved. */
    async finishExecution(id: string, status: Extract<ApprovalStatus, 'executed' | 'failed'>, error: string | null): Promise<boolean> {
      const res = await db.query(
        `UPDATE approvals SET status = $2, executed_at = $3, error = $4 WHERE id = $1 AND status = 'approved'`,
        [id, status, status === 'executed' ? clock.now() : null, error],
      );
      return res.rowCount === 1;
    },
  };
}

/** Strips the fixed tail from a prompt: `#7 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it?` */
export function promptSummary(a: Pick<ApprovalRow, 'prompt'>): string {
  return a.prompt.endsWith(PROMPT_TAIL) ? a.prompt.slice(0, -PROMPT_TAIL.length).trimEnd() : a.prompt;
}

export const PROMPT_TAIL = ' Reply yes or no.';
