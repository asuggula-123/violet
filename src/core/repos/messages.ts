import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { Direction, MessageRow, Thread } from '../types.js';

const COLUMNS = `id, agent_id, thread, contact_id, direction, body, purpose, transport_message_id,
  reply_to_transport_message_id, meta, created_at`;

export function messagesRepo(db: Queryable, clock: Clock) {
  return {
    async add(m: {
      agentId: string;
      thread: Thread;
      contactId?: string | null;
      direction: Direction;
      body: string;
      purpose?: string | null;
      transportMessageId?: string | null;
      replyToTransportMessageId?: string | null;
      meta?: Record<string, unknown>;
    }): Promise<MessageRow> {
      const res = await db.query<MessageRow>(
        `INSERT INTO messages (id, agent_id, thread, contact_id, direction, body, purpose,
                               transport_message_id, reply_to_transport_message_id, meta, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          m.agentId,
          m.thread,
          m.contactId ?? null,
          m.direction,
          m.body,
          m.purpose ?? null,
          m.transportMessageId ?? null,
          m.replyToTransportMessageId ?? null,
          JSON.stringify(m.meta ?? {}),
          clock.now(),
        ],
      );
      return res.rows[0]!;
    },
    /** Most recent `limit` messages of a thread, oldest first. */
    async recent(agentId: string, thread: Thread, limit: number): Promise<MessageRow[]> {
      const res = await db.query<MessageRow>(
        `SELECT ${COLUMNS} FROM (
           SELECT * FROM messages WHERE agent_id = $1 AND thread = $2 ORDER BY seq DESC LIMIT $3
         ) m ORDER BY seq`,
        [agentId, thread, limit],
      );
      return res.rows;
    },
    async listByContact(contactId: string): Promise<MessageRow[]> {
      const res = await db.query<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE contact_id = $1 ORDER BY seq`, [contactId]);
      return res.rows;
    },
  };
}
