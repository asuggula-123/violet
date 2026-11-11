import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/db.js';

export type DigestStatus = 'sending' | 'sent' | 'empty' | 'rolled_over';

export interface DigestRow {
  id: string;
  agent_id: string;
  local_date: string;
  body: string | null;
  status: DigestStatus;
  item_count: number;
  left_out: number;
  created_at: Date;
}

export interface DigestItem {
  id: string;
  kind: string;
  text: string;
  overflowed: boolean;
}

export interface DigestAgent {
  id: string;
  paused: boolean;
  owner_address: string | null;
  timezone: string;
  digest_hour: number;
}

const COLUMNS = 'id, agent_id, local_date::text AS local_date, body, status, item_count, left_out, created_at';

/** Digest items not yet carried by a digest: pending 'digest' flags and overflowed 'now' flags. */
const ITEMS = `FROM flags WHERE agent_id = $1 AND status = 'pending' AND digest_id IS NULL
  AND (urgency = 'digest' OR overflowed_at IS NOT NULL)`;

export const digestStore = {
  async agents(q: Queryable, agentId?: string): Promise<DigestAgent[]> {
    const res = await q.query<DigestAgent>(
      `SELECT a.id, a.paused, a.owner_address, o.timezone, o.digest_hour FROM agents a JOIN owners o ON o.id = a.owner_id
       WHERE ($1::text IS NULL OR a.id = $1) ORDER BY a.created_at, a.id`,
      [agentId ?? null],
    );
    return res.rows;
  },

  async lockAgent(q: Queryable, agentId: string): Promise<void> {
    await q.query('SELECT id FROM agents WHERE id = $1 FOR UPDATE', [agentId]);
  },

  async get(q: Queryable, agentId: string, date: string): Promise<DigestRow | null> {
    const res = await q.query<DigestRow>(`SELECT ${COLUMNS} FROM digests WHERE agent_id = $1 AND local_date = $2`, [agentId, date]);
    return res.rows[0] ?? null;
  },

  /** Undelivered digests of earlier dates whose send lease is free. */
  async stale(q: Queryable, agentId: string, date: string, now: Date): Promise<DigestRow[]> {
    const res = await q.query<DigestRow>(
      `SELECT ${COLUMNS} FROM digests WHERE agent_id = $1 AND status = 'sending' AND local_date < $2
       AND (lease_until IS NULL OR lease_until <= $3) ORDER BY local_date`,
      [agentId, date, now],
    );
    return res.rows;
  },

  async items(q: Queryable, agentId: string, lock: boolean): Promise<DigestItem[]> {
    const res = await q.query<DigestItem>(
      `SELECT id, kind, text, overflowed_at IS NOT NULL AS overflowed ${ITEMS} ORDER BY seq${lock ? ' FOR UPDATE' : ''}`,
      [agentId],
    );
    return res.rows;
  },

  /** Inserts the date's digest (status 'sending' holds the send lease); null if the date already has one. */
  async insert(
    q: Queryable,
    d: { agentId: string; date: string; body: string | null; itemCount: number; leftOut: number; now: Date; leaseUntil: Date | null },
  ): Promise<DigestRow | null> {
    const res = await q.query<DigestRow>(
      `INSERT INTO digests (id, agent_id, local_date, body, status, item_count, left_out, created_at, lease_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (agent_id, local_date) DO NOTHING RETURNING ${COLUMNS}`,
      [randomUUID(), d.agentId, d.date, d.body, d.body === null ? 'empty' : 'sending', d.itemCount, d.leftOut, d.now, d.leaseUntil],
    );
    return res.rows[0] ?? null;
  },

  async assign(q: Queryable, digest: DigestRow, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await q.query('UPDATE flags SET digest_id = $1, digest_date = $2 WHERE id = ANY($3::text[])', [digest.id, digest.local_date, itemIds]);
  },

  /** Takes the send lease of an undelivered digest; false if another worker holds it. */
  async claim(q: Queryable, id: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const res = await q.query(
      `UPDATE digests SET lease_until = $3 WHERE id = $1 AND status = 'sending' AND (lease_until IS NULL OR lease_until <= $2)`,
      [id, now, leaseUntil],
    );
    return res.rowCount === 1;
  },

  /** Counts a retryable send failure of an undelivered digest; the new count, or null if it is no longer sending. */
  async countFailure(q: Queryable, id: string): Promise<number | null> {
    const res = await q.query<{ send_failures: number }>(
      `UPDATE digests SET send_failures = send_failures + 1 WHERE id = $1 AND status = 'sending' RETURNING send_failures`,
      [id],
    );
    return res.rows[0]?.send_failures ?? null;
  },

  /** Keeps the send lease until `until`: the backoff before the next attempt. */
  async extendLease(q: Queryable, id: string, until: Date): Promise<void> {
    await q.query(`UPDATE digests SET lease_until = $2 WHERE id = $1 AND status = 'sending'`, [id, until]);
  },

  async releaseLease(q: Queryable, id: string): Promise<void> {
    await q.query(`UPDATE digests SET lease_until = NULL WHERE id = $1 AND status = 'sending'`, [id]);
  },

  /** When the gateway already recorded this body as sent (a crash after the send), that time. */
  async recordedAt(q: Queryable, digest: DigestRow): Promise<Date | null> {
    const res = await q.query<{ created_at: Date }>(
      `SELECT created_at FROM messages WHERE agent_id = $1 AND thread = 'owner' AND direction = 'out'
       AND purpose = 'digest' AND body = $2 AND created_at >= $3 ORDER BY seq LIMIT 1`,
      [digest.agent_id, digest.body, digest.created_at],
    );
    return res.rows[0]?.created_at ?? null;
  },

  async markSent(q: Queryable, id: string, at: Date): Promise<boolean> {
    const res = await q.query(`UPDATE digests SET status = 'sent', sent_at = $2, lease_until = NULL WHERE id = $1 AND status = 'sending'`, [id, at]);
    if (res.rowCount !== 1) return false;
    await q.query(`UPDATE flags SET status = 'sent', delivered_at = $2 WHERE digest_id = $1 AND status = 'pending'`, [id, at]);
    return true;
  },

  /** The digest was not delivered: its items go back to the pool for the next digest. Returns how many. */
  async rollOver(q: Queryable, id: string): Promise<number | null> {
    const res = await q.query(`UPDATE digests SET status = 'rolled_over', lease_until = NULL WHERE id = $1 AND status = 'sending'`, [id]);
    if (res.rowCount !== 1) return null;
    const back = await q.query(`UPDATE flags SET digest_id = NULL, digest_date = NULL WHERE digest_id = $1 AND status = 'pending'`, [id]);
    return back.rowCount;
  },

  async deferredLogged(q: Queryable, agentId: string, date: string, reason: string): Promise<boolean> {
    const res = await q.query(
      `SELECT 1 FROM action_log WHERE agent_id = $1 AND action = 'digest.deferred' AND detail->>'date' = $2 AND detail->>'reason' = $3 LIMIT 1`,
      [agentId, date, reason],
    );
    return res.rows.length > 0;
  },
};
