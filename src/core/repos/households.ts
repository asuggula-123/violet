import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { HouseholdRow } from '../types.js';

export function householdsRepo(db: Queryable, clock: Clock) {
  return {
    async create(name: string): Promise<HouseholdRow> {
      const res = await db.query<HouseholdRow>(
        'INSERT INTO households (id, name, created_at) VALUES ($1, $2, $3) RETURNING *',
        [randomUUID(), name, clock.now()],
      );
      return res.rows[0]!;
    },
    async get(id: string): Promise<HouseholdRow | null> {
      const res = await db.query<HouseholdRow>('SELECT * FROM households WHERE id = $1', [id]);
      return res.rows[0] ?? null;
    },
    async findByName(name: string): Promise<HouseholdRow | null> {
      const res = await db.query<HouseholdRow>('SELECT * FROM households WHERE name = $1 ORDER BY created_at LIMIT 1', [name]);
      return res.rows[0] ?? null;
    },
  };
}
