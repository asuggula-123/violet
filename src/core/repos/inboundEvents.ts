import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { InboundMessage } from '../../transport/types.js';
import type { InboundEventRow } from '../types.js';

export function inboundEventsRepo(db: Queryable, clock: Clock) {
  return {
    /** Returns the new row, or null if this transport message id was already stored (I18). */
    async insert(msg: InboundMessage): Promise<InboundEventRow | null> {
      const res = await db.query<InboundEventRow>(
        `INSERT INTO inbound_events (id, transport, transport_message_id, agent_address, payload, received_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (transport, transport_message_id) DO NOTHING RETURNING *`,
        [randomUUID(), msg.transport, msg.transportMessageId, msg.agentAddress, JSON.stringify(msg), clock.now()],
      );
      return res.rows[0] ?? null;
    },
    async get(id: string): Promise<InboundEventRow | null> {
      const res = await db.query<InboundEventRow>('SELECT * FROM inbound_events WHERE id = $1', [id]);
      return res.rows[0] ?? null;
    },
    /** Records that routing step `name` is done, with its JSON result. */
    async markStep(id: string, name: string, result: unknown): Promise<void> {
      await db.query(`UPDATE inbound_events SET progress = progress || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [
        id,
        name,
        JSON.stringify(result ?? null),
      ]);
    },
    async markProcessed(id: string): Promise<void> {
      await db.query('UPDATE inbound_events SET processed_at = $2 WHERE id = $1', [id, clock.now()]);
    },
  };
}

/** Rebuilds the InboundMessage stored in an event payload. */
export function inboundFromPayload(payload: Record<string, unknown>): InboundMessage {
  const p = payload as unknown as Omit<InboundMessage, 'receivedAt'> & { receivedAt: string };
  return { ...p, receivedAt: new Date(p.receivedAt) };
}
