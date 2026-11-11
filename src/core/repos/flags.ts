import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { FlagRow, FlagStatus, FlagUrgency } from '../types.js';

const COLUMNS = `id, agent_id, kind, urgency, text, dedupe_key, status, created_at, delivered_at, digest_date::text AS digest_date`;

export function flagsRepo(db: Queryable, clock: Clock) {
  return {
    /** Returns null when a flag with the same dedupe key already exists for this agent. */
    async insert(f: { agentId: string; kind: string; urgency: FlagUrgency; text: string; dedupeKey?: string }): Promise<FlagRow | null> {
      const res = await db.query<FlagRow>(
        `INSERT INTO flags (id, agent_id, kind, urgency, text, dedupe_key, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         ON CONFLICT (agent_id, dedupe_key) DO NOTHING RETURNING ${COLUMNS}`,
        [randomUUID(), f.agentId, f.kind, f.urgency, f.text, f.dedupeKey ?? null, clock.now()],
      );
      return res.rows[0] ?? null;
    },
    async findByDedupeKey(agentId: string, dedupeKey: string): Promise<FlagRow | null> {
      const res = await db.query<FlagRow>(`SELECT ${COLUMNS} FROM flags WHERE agent_id = $1 AND dedupe_key = $2`, [agentId, dedupeKey]);
      return res.rows[0] ?? null;
    },
    async setStatus(id: string, status: FlagStatus): Promise<void> {
      await db.query('UPDATE flags SET status = $2, delivered_at = $3 WHERE id = $1', [
        id,
        status,
        status === 'sent' ? clock.now() : null,
      ]);
    },
    async listPending(agentId: string): Promise<FlagRow[]> {
      const res = await db.query<FlagRow>(
        `SELECT ${COLUMNS} FROM flags WHERE agent_id = $1 AND status = 'pending' ORDER BY seq`,
        [agentId],
      );
      return res.rows;
    },
    async listByAgent(agentId: string): Promise<FlagRow[]> {
      const res = await db.query<FlagRow>(`SELECT ${COLUMNS} FROM flags WHERE agent_id = $1 ORDER BY seq`, [agentId]);
      return res.rows;
    },
  };
}
