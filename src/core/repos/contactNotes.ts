import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { ContactNoteRow } from '../types.js';

export function contactNotesRepo(db: Queryable, clock: Clock) {
  return {
    async add(n: { agentId: string; contactId?: string | null; subject?: string | null; body: string }): Promise<ContactNoteRow> {
      const res = await db.query<ContactNoteRow>(
        `INSERT INTO contact_notes (id, agent_id, contact_id, subject, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, agent_id, contact_id, subject, body, created_at`,
        [randomUUID(), n.agentId, n.contactId ?? null, n.subject ?? null, n.body, clock.now()],
      );
      return res.rows[0]!;
    },
    async listByAgent(agentId: string): Promise<ContactNoteRow[]> {
      const res = await db.query<ContactNoteRow>(
        'SELECT id, agent_id, contact_id, subject, body, created_at FROM contact_notes WHERE agent_id = $1 ORDER BY seq',
        [agentId],
      );
      return res.rows;
    },
  };
}
