import type { Queryable } from '../db/db.js';
import type { LlmMessage } from '../llm/types.js';
import { wrapUntrusted } from './untrusted.js';

export const HISTORY_LIMIT = 40;

export interface HistoryRow {
  direction: 'in' | 'out';
  body: string;
  purpose: string | null;
  meta: Record<string, unknown>;
}

/**
 * Outbound messages that relay third parties (flags quote strangers, digests and
 * transcripts quote everyone, Envoy questions quote the other agent's conversation) never
 * replay as text: the model sees a neutral placeholder and fetches details with its tools,
 * which taint the turn. Envoy questions reach the Brain through the dynamic context.
 */
export const HISTORY_PLACEHOLDER: Readonly<Record<string, string>> = Object.freeze({
  flag: '[flag sent]',
  digest: '[daily digest sent]',
  transcript: '[transcript sent]',
  question: '[question from an agent conversation sent]',
});

/** A Violet message written in a tainted turn, or one quoting third parties (messages.meta.tainted). */
export const isTaintedRow = (r: HistoryRow): boolean => r.direction === 'out' && r.meta.tainted === true && !HISTORY_PLACEHOLDER[r.purpose ?? ''];

/** Whether the history window holds third-party text (as untrusted data): the turn starts tainted (I11). */
export function historyTainted(rows: HistoryRow[]): boolean {
  const first = rows.findIndex((r) => r.direction === 'in');
  return first >= 0 && rows.slice(first).some(isTaintedRow); // leading assistant rows are dropped by toTurns
}

function textOf(r: HistoryRow, role: 'user' | 'assistant'): string {
  if (role === 'user') return r.body.trim() || (r.meta.kind === 'unsupported' ? '(sent something that is not text)' : '');
  const placeholder = HISTORY_PLACEHOLDER[r.purpose ?? ''];
  if (placeholder) return placeholder;
  if (!r.body.trim()) return '';
  return isTaintedRow(r) ? wrapUntrusted('agent', r.body.trim()) : r.body.trim();
}

/**
 * Fail closed (I11): a tainted text the owner was sent but whose `messages` row could not be
 * stored (outbound.sent `recorded: false`, `tainted`) is missing from the history, so it would
 * not taint later turns; its log row does. Like a tainted row, it never wears off by itself.
 */
export async function unrecordedTaint(db: Queryable, agentId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM action_log WHERE agent_id = $1 AND action = 'outbound.sent' AND detail->>'recorded' = 'false' AND detail->>'tainted' = 'true' LIMIT 1`,
    [agentId],
  );
  return res.rows.length > 0;
}

/** The owner thread up to and including `messageId` (later rows, e.g. from a failed attempt, are left out). */
export async function loadOwnerThread(db: Queryable, agentId: string, messageId: string, limit = HISTORY_LIMIT): Promise<HistoryRow[]> {
  const res = await db.query<HistoryRow>(
    `SELECT direction, body, purpose, meta FROM (
       SELECT direction, body, purpose, meta, seq FROM messages
       WHERE agent_id = $1 AND thread = 'owner' AND seq <= (SELECT seq FROM messages WHERE id = $2)
       ORDER BY seq DESC LIMIT $3
     ) m ORDER BY seq`,
    [agentId, messageId, limit],
  );
  return res.rows;
}

/**
 * I2: only owner-thread INBOUND messages become user turns. Everything Violet sent the
 * owner (replies, approval prompts, acks) is an assistant turn; flags, digests, transcripts
 * and questions become placeholders, and tainted messages are wrapped as untrusted data.
 * Consecutive same-role messages merge; the result starts with a user turn and ends with
 * `current` (the owner's message this turn answers) as the last user turn.
 */
export function toTurns(rows: HistoryRow[], current: string): LlmMessage[] {
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const text = textOf(r, role);
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
