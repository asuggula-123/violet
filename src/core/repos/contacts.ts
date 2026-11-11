import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { TransportName } from '../../transport/types.js';
import type { ContactKind, ContactRow } from '../types.js';

export function contactsRepo(db: Queryable, clock: Clock) {
  return {
    /** Insert or touch. An existing contact's kind is only changed when `kind` is 'owner'. */
    async upsert(c: {
      agentId: string;
      transport: TransportName;
      address: string;
      displayName?: string | null;
      kind: ContactKind;
    }): Promise<ContactRow> {
      const now = clock.now();
      const res = await db.query<ContactRow>(
        `INSERT INTO contacts (id, agent_id, transport, address, display_name, kind, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (agent_id, transport, address) DO UPDATE SET
           last_seen_at = EXCLUDED.last_seen_at,
           display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
           kind = CASE WHEN EXCLUDED.kind = 'owner' THEN 'owner' ELSE contacts.kind END
         RETURNING *`,
        [randomUUID(), c.agentId, c.transport, c.address, c.displayName ?? null, c.kind, now],
      );
      return res.rows[0]!;
    },
    async get(id: string): Promise<ContactRow | null> {
      const res = await db.query<ContactRow>('SELECT * FROM contacts WHERE id = $1', [id]);
      return res.rows[0] ?? null;
    },
    async listByAgent(agentId: string): Promise<ContactRow[]> {
      const res = await db.query<ContactRow>('SELECT * FROM contacts WHERE agent_id = $1 ORDER BY first_seen_at, id', [agentId]);
      return res.rows;
    },
    async markCannedReply(id: string): Promise<void> {
      await db.query('UPDATE contacts SET last_canned_reply_at = $2 WHERE id = $1', [id, clock.now()]);
    },
    /** An unpaired owner's contact row becomes a stranger's (pairing re-issue with --reset). */
    async demoteOwner(agentId: string, transport: TransportName, address: string): Promise<void> {
      await db.query(
        `UPDATE contacts SET kind = 'stranger' WHERE agent_id = $1 AND transport = $2 AND address = $3 AND kind = 'owner'`,
        [agentId, transport, address],
      );
    },
  };
}
