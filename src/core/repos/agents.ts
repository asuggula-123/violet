import { randomUUID } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import type { TransportName } from '../../transport/types.js';
import type { AgentRow } from '../types.js';

export function agentsRepo(db: Queryable, clock: Clock) {
  return {
    async create(a: {
      ownerId: string;
      name?: string;
      transport: TransportName;
      agentAddress: string;
      ownerAddress?: string | null;
      pairingCodeHash?: string | null;
      pairingExpiresAt?: Date | null;
    }): Promise<AgentRow> {
      const res = await db.query<AgentRow>(
        `INSERT INTO agents (id, owner_id, name, transport, agent_address, owner_address,
                             pairing_code_hash, pairing_expires_at, paused, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9) RETURNING *`,
        [
          randomUUID(),
          a.ownerId,
          a.name ?? 'Violet',
          a.transport,
          a.agentAddress,
          a.ownerAddress ?? null,
          a.pairingCodeHash ?? null,
          a.pairingExpiresAt ?? null,
          clock.now(),
        ],
      );
      return res.rows[0]!;
    },
    async get(id: string): Promise<AgentRow | null> {
      const res = await db.query<AgentRow>('SELECT * FROM agents WHERE id = $1', [id]);
      return res.rows[0] ?? null;
    },
    async findByAddress(transport: TransportName, agentAddress: string): Promise<AgentRow | null> {
      const res = await db.query<AgentRow>('SELECT * FROM agents WHERE transport = $1 AND agent_address = $2', [
        transport,
        agentAddress,
      ]);
      return res.rows[0] ?? null;
    },
    async listActive(): Promise<AgentRow[]> {
      const res = await db.query<AgentRow>('SELECT * FROM agents WHERE paused = false ORDER BY created_at, id');
      return res.rows;
    },
    /** Binds the owner only if the agent is still unpaired. Returns false if it lost the race. */
    async bindOwner(id: string, ownerAddress: string): Promise<boolean> {
      const res = await db.query(
        `UPDATE agents SET owner_address = $2, pairing_code_hash = NULL, pairing_expires_at = NULL
         WHERE id = $1 AND owner_address IS NULL`,
        [id, ownerAddress],
      );
      return res.rowCount === 1;
    },
    /**
     * Flips `paused` only if it differs; returns true if it changed. Call inside a
     * transaction. The row is locked first (`FOR UPDATE`) whether or not it will change,
     * so every pause/resume command — a no-op included — serializes on the row: the one
     * that waits sees the other's committed result and enqueues its job after it.
     * (A bare `UPDATE … WHERE paused <> $2` that matches nothing takes no lock and would
     * not be ordered against a concurrent flip.)
     */
    async flipPaused(id: string, paused: boolean): Promise<boolean> {
      const current = await db.query<{ paused: boolean }>('SELECT paused FROM agents WHERE id = $1 FOR UPDATE', [id]);
      const row = current.rows[0];
      if (!row || row.paused === paused) return false;
      await db.query('UPDATE agents SET paused = $2, paused_at = $3 WHERE id = $1', [id, paused, paused ? clock.now() : null]);
      return true;
    },
    async setPaused(id: string, paused: boolean): Promise<void> {
      await db.query('UPDATE agents SET paused = $2, paused_at = $3 WHERE id = $1', [id, paused, paused ? clock.now() : null]);
    },
  };
}
