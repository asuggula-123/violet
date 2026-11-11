import type { Clock } from '../clock.js';
import type { Queryable } from '../db/db.js';

/** Who caused an action. */
export type Actor = 'system' | 'owner' | 'stranger' | 'brain' | 'envoy' | 'scheduler' | 'job' | 'cli';

export interface ActionEntry {
  agentId?: string | null;
  actor: Actor;
  action: string;
  /** Never put secrets here (I16). */
  detail?: Record<string, unknown>;
}

export interface ActionRow {
  id: string;
  at: Date;
  agent_id: string | null;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface ActionFilter {
  action?: string;
  agentId?: string;
}

/** I15: append-only log of everything that happens. */
export interface ActionLog {
  write(entry: ActionEntry, q?: Queryable): Promise<void>;
  list(filter?: ActionFilter): Promise<ActionRow[]>;
}

export function createActionLog(db: Queryable, clock: Clock): ActionLog {
  return {
    async write(entry, q = db) {
      await q.query('INSERT INTO action_log (at, agent_id, actor, action, detail) VALUES ($1, $2, $3, $4, $5::jsonb)', [
        clock.now(),
        entry.agentId ?? null,
        entry.actor,
        entry.action,
        JSON.stringify(entry.detail ?? {}),
      ]);
    },
    async list(filter = {}) {
      const res = await db.query<ActionRow>(
        `SELECT id::text AS id, at, agent_id, actor, action, detail FROM action_log
         WHERE ($1::text IS NULL OR action = $1) AND ($2::text IS NULL OR agent_id = $2)
         ORDER BY action_log.id`,
        [filter.action ?? null, filter.agentId ?? null],
      );
      return res.rows;
    },
  };
}
