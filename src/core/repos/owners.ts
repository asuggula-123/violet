import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { OwnerRow } from '../types.js';

export function ownersRepo(db: Queryable, clock: Clock) {
  return {
    async create(o: { householdId: string; name: string; timezone: string; digestHour?: number }): Promise<OwnerRow> {
      const res = await db.query<OwnerRow>(
        `INSERT INTO owners (id, household_id, name, timezone, digest_hour, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [randomUUID(), o.householdId, o.name, o.timezone, o.digestHour ?? 18, clock.now()],
      );
      return res.rows[0]!;
    },
    async get(id: string): Promise<OwnerRow | null> {
      const res = await db.query<OwnerRow>('SELECT * FROM owners WHERE id = $1', [id]);
      return res.rows[0] ?? null;
    },
    async inHousehold(householdId: string): Promise<OwnerRow[]> {
      const res = await db.query<OwnerRow>('SELECT * FROM owners WHERE household_id = $1 ORDER BY created_at, id', [householdId]);
      return res.rows;
    },
  };
}
