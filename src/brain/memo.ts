import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Queryable } from '../db/db.js';

/** JSON with object keys sorted at every level, so equal inputs hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** brain_turns + brain_tool_memo: a finished turn never re-runs; side-effecting calls never repeat. */
export function turnMemo(db: Queryable, clock: Clock) {
  return {
    /** Returns true if the turn for this message is already done. */
    async begin(messageId: string, agentId: string): Promise<boolean> {
      await db.query(
        `INSERT INTO brain_turns (message_id, agent_id, status, created_at) VALUES ($1, $2, 'running', $3)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, agentId, clock.now()],
      );
      const res = await db.query<{ status: string }>('SELECT status FROM brain_turns WHERE message_id = $1', [messageId]);
      return res.rows[0]?.status === 'done';
    },
    async finish(messageId: string, outcome: string): Promise<void> {
      await db.query(`UPDATE brain_turns SET status = 'done', outcome = $2, finished_at = $3 WHERE message_id = $1`, [messageId, outcome, clock.now()]);
    },
    /**
     * I19 prompt-last: the turn's reply is out and it is closing (notices, then prompts). A
     * retry or a duplicate run that finds this mark sends no model text: it only closes, so
     * nothing it says can land after the turn's prompts. Stored as a reserved memo row (the
     * '#' name is not a valid tool name), so no schema change is needed.
     */
    async markClosing(messageId: string, outcome: string): Promise<void> {
      await db.query(
        `INSERT INTO brain_tool_memo (message_id, tool, input_hash, occurrence, result, created_at) VALUES ($1, '#closing', '', 0, $2, $3)
         ON CONFLICT DO NOTHING`,
        [messageId, outcome, clock.now()],
      );
    },
    /** The outcome stored by markClosing, or null when no attempt of the turn reached closing. */
    async closing(messageId: string): Promise<string | null> {
      const res = await db.query<{ result: string }>(
        `SELECT result FROM brain_tool_memo WHERE message_id = $1 AND tool = '#closing' AND input_hash = '' AND occurrence = 0`,
        [messageId],
      );
      return res.rows[0]?.result ?? null;
    },
    async recall(messageId: string, tool: string, inputHash: string, occurrence: number): Promise<string | null> {
      const res = await db.query<{ result: string }>(
        'SELECT result FROM brain_tool_memo WHERE message_id = $1 AND tool = $2 AND input_hash = $3 AND occurrence = $4',
        [messageId, tool, inputHash, occurrence],
      );
      return res.rows[0]?.result ?? null;
    },
    async store(messageId: string, tool: string, inputHash: string, occurrence: number, result: string): Promise<void> {
      await db.query(
        `INSERT INTO brain_tool_memo (message_id, tool, input_hash, occurrence, result, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [messageId, tool, inputHash, occurrence, result, clock.now()],
      );
    },
  };
}
