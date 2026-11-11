import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { JobQueue } from '../core/jobs.js';
import { sanitize } from '../core/sanitize.js';
import type { AgentRow, OwnerRow } from '../core/types.js';
import type { Queryable } from '../db/db.js';
import type { A2AMessageRow, ConversationRow, MessageKind, Parties, Party, SideRow } from './types.js';

export const TURN_JOB = 'a2a.turn';
export const NOTICE_JOB = 'a2a.notice';
export const OUTCOME_JOB = 'a2a.outcome';

const CONV = `id, household_id, initiator_agent_id, responder_agent_id, topic, status, window_start, window_end, last_seq,
  live_proposal_seq, accepted_proposal_seq, outcome_group_id, outcome_state, open_key, created_at, updated_at, closed_at, close_reason`;
const SIDE = `conversation_id, agent_id, role, brief, availability_calls, messages_sent, owner_questions, awaiting_owner, stalled`;
const MSG = `id, conversation_id, seq, from_agent_id, private_to, kind, body, payload, turn_key, created_at`;

export const conversationColumns = CONV;

/** Read helpers over the a2a tables. Nothing here reads calendars, email, notes or the owner thread. */
export function a2aRepo(db: Queryable) {
  const one = async <T>(sql: string, params: unknown[]) => (await db.query<T>(sql, params)).rows[0] ?? null;
  return {
    conversation: (id: string) => one<ConversationRow>(`SELECT ${CONV} FROM a2a_conversations WHERE id = $1`, [id]),
    /** Locks the conversation row (call inside a transaction): every write to a conversation serializes here. */
    lock: (id: string) => one<ConversationRow>(`SELECT ${CONV} FROM a2a_conversations WHERE id = $1 FOR UPDATE`, [id]),
    side: (conversationId: string, agentId: string) =>
      one<SideRow>(`SELECT ${SIDE} FROM a2a_sides WHERE conversation_id = $1 AND agent_id = $2`, [conversationId, agentId]),
    message: (conversationId: string, seq: number) =>
      one<A2AMessageRow>(`SELECT ${MSG} FROM a2a_messages WHERE conversation_id = $1 AND seq = $2`, [conversationId, seq]),
    byTurnKey: (turnKey: string) => one<A2AMessageRow>(`SELECT ${MSG} FROM a2a_messages WHERE turn_key = $1`, [turnKey]),
    /** What `agentId`'s side may see: every shared message plus its own private ones. */
    async visible(conversationId: string, agentId: string): Promise<A2AMessageRow[]> {
      const res = await db.query<A2AMessageRow>(
        `SELECT ${MSG} FROM a2a_messages WHERE conversation_id = $1 AND (private_to IS NULL OR private_to = $2) ORDER BY seq`,
        [conversationId, agentId],
      );
      return res.rows;
    },
    async forAgent(agentId: string, includeClosed: boolean): Promise<ConversationRow[]> {
      const res = await db.query<ConversationRow>(
        `SELECT ${CONV} FROM a2a_conversations
         WHERE (initiator_agent_id = $1 OR responder_agent_id = $1) AND ($2 OR status <> 'closed') ORDER BY seq`,
        [agentId, includeClosed],
      );
      return res.rows;
    },
    async parties(conv: ConversationRow, meId: string): Promise<Parties> {
      const peerId = peerOf(conv, meId);
      const res = await db.query<AgentRow & { o_id: string; o_household_id: string; o_name: string; o_timezone: string; o_digest_hour: number; o_created_at: Date }>(
        `SELECT a.*, o.id AS o_id, o.household_id AS o_household_id, o.name AS o_name, o.timezone AS o_timezone,
                o.digest_hour AS o_digest_hour, o.created_at AS o_created_at
         FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ANY($1::text[])`,
        [[meId, peerId]],
      );
      const party = (id: string): Party => {
        const r = res.rows.find((x) => x.id === id);
        if (!r) throw new Error(`a2a: unknown agent ${id}`);
        const { o_id, o_household_id, o_name, o_timezone, o_digest_hour, o_created_at, ...agent } = r;
        const owner: OwnerRow = { id: o_id, household_id: o_household_id, name: o_name, timezone: o_timezone, digest_hour: o_digest_hour, created_at: o_created_at };
        return { agent, owner, first: firstName(o_name) };
      };
      const me = party(meId);
      const peer = party(peerId);
      return { me, peer, peerLabel: `${peer.first}'s ${sanitize(peer.agent.name, 40)}` };
    },
  };
}

export function peerOf(conv: Pick<ConversationRow, 'initiator_agent_id' | 'responder_agent_id'>, agentId: string): string {
  if (agentId === conv.initiator_agent_id) return conv.responder_agent_id;
  if (agentId === conv.responder_agent_id) return conv.initiator_agent_id;
  throw new Error('a2a: agent is not part of this conversation');
}

export function isParty(conv: Pick<ConversationRow, 'initiator_agent_id' | 'responder_agent_id'>, agentId: string): boolean {
  return agentId === conv.initiator_agent_id || agentId === conv.responder_agent_id;
}

/** The first word of an owner's name, sanitized: what agents and prompts call them. */
export function firstName(name: string): string {
  return sanitize(name, 60).split(' ')[0] || 'them';
}

export interface WriteDeps {
  clock: Clock;
  jobs: JobQueue;
  actionLog: ActionLog;
}

export interface NewMessage {
  conv: ConversationRow;
  from: string | null;
  privateTo?: string | null;
  kind: MessageKind;
  body: string;
  payload?: Record<string, unknown>;
  turnKey?: string | null;
  /** Agents whose Envoy runs one turn on this message (a job on each agent's lane). */
  deliverTo?: string[];
}

/**
 * The internal channel. Call inside a transaction holding the conversation lock: the seq
 * comes from the locked row, the message, its delivery jobs and its log row commit
 * together, so a retry can never duplicate, drop or reorder a message.
 */
export async function writeMessage(tx: Queryable, d: WriteDeps, m: NewMessage): Promise<A2AMessageRow> {
  const now = d.clock.now();
  const bumped = await tx.query<{ last_seq: number }>(
    'UPDATE a2a_conversations SET last_seq = last_seq + 1, updated_at = $2 WHERE id = $1 RETURNING last_seq',
    [m.conv.id, now],
  );
  const seq = bumped.rows[0]!.last_seq;
  const res = await tx.query<A2AMessageRow>(
    `INSERT INTO a2a_messages (id, conversation_id, seq, from_agent_id, private_to, kind, body, payload, turn_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING ${MSG}`,
    [randomUUID(), m.conv.id, seq, m.from, m.privateTo ?? null, m.kind, m.body, JSON.stringify(m.payload ?? {}), m.turnKey ?? null, now],
  );
  for (const agentId of m.deliverTo ?? []) {
    await d.jobs.enqueue(TURN_JOB, { conversationId: m.conv.id, agentId, seq }, { lane: agentId, dedupeKey: `a2a:turn:${m.conv.id}:${agentId}:${seq}`, tx });
  }
  const to = m.privateTo ? 'own_side' : m.from ? peerOf(m.conv, m.from) : 'both';
  await d.actionLog.write(
    {
      agentId: m.from ?? m.privateTo ?? null,
      actor: m.from === null ? 'system' : m.kind === 'guidance' || m.kind === 'open' ? 'brain' : 'envoy',
      action: 'a2a.message',
      detail: { conversationId: m.conv.id, seq, kind: m.kind, from: m.from, to, chars: m.body.length },
    },
    tx,
  );
  return res.rows[0]!;
}

export interface NewNotice {
  id: string;
  agentId: string;
  purpose: 'reply' | 'question';
  text: string;
  /** The text quotes another agent: stored tainted (the Brain sees it only as untrusted data). */
  tainted: boolean;
}

/** Queues a code-rendered line for an owner, once per id (inside the caller's transaction). */
export async function queueNotice(tx: Queryable, d: Pick<WriteDeps, 'clock' | 'jobs'>, n: NewNotice): Promise<void> {
  const res = await tx.query(
    `INSERT INTO a2a_notices (id, agent_id, purpose, text, tainted, status, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     ON CONFLICT (id) DO NOTHING`,
    [n.id, n.agentId, n.purpose, n.text, n.tainted, d.clock.now()],
  );
  if (res.rowCount === 1) await d.jobs.enqueue(NOTICE_JOB, { id: n.id }, { lane: n.agentId, dedupeKey: `a2a:notice:${n.id}`, tx });
}
