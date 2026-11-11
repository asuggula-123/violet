import type { Queryable } from '../db/db.js';
import type { LlmMessage } from '../llm/types.js';

export const HISTORY_LIMIT = 40;

interface Row {
  direction: 'in' | 'out';
  body: string;
  meta: Record<string, unknown>;
}

/** The owner thread up to and including `messageId` (later rows, e.g. from a failed attempt, are left out). */
export async function loadOwnerThread(db: Queryable, agentId: string, messageId: string, limit = HISTORY_LIMIT): Promise<Row[]> {
  const res = await db.query<Row>(
    `SELECT direction, body, meta FROM (
       SELECT direction, body, meta, seq FROM messages
       WHERE agent_id = $1 AND thread = 'owner' AND seq <= (SELECT seq FROM messages WHERE id = $2)
       ORDER BY seq DESC LIMIT $3
     ) m ORDER BY seq`,
    [agentId, messageId, limit],
  );
  return res.rows;
}

/**
 * I2: only owner-thread INBOUND messages become user turns. Everything Violet sent the
 * owner (replies, approval prompts, flags, digests, acks) is an assistant turn.
 * Consecutive same-role messages merge; the result starts with a user turn and ends with
 * `current` (the owner's message this turn answers) as the last user turn.
 */
export function toTurns(rows: Row[], current: string): LlmMessage[] {
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const text = r.body.trim() || (role === 'user' && r.meta.kind === 'unsupported' ? '(sent something that is not text)' : '');
    if (!text) continue;
    const last = turns.at(-1);
    if (last?.role === role) last.content = `${last.content}\n\n${text}`;
    else if (turns.length > 0 || role === 'user') turns.push({ role, content: text });
  }
  const now = current.trim() || '(empty message)';
  const last = turns.at(-1);
  if (last?.role !== 'user') turns.push({ role: 'user', content: now });
  else if (!last.content.endsWith(now)) last.content = `${last.content}\n\n${now}`;
  return turns;
}
