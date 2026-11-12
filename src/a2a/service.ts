import type { OwnerMessageCtx } from '../core/router.js';
import { a2aRepo, NOTICE_JOB, TURN_JOB } from './repo.js';
import { expireIdle, type AfterEvent } from './conversations.js';
import type { A2ADeps } from './deps.js';
import { shown } from './render.js';
import type { createViews } from './views.js';
import type { A2AService } from './types.js';

const TRANSCRIPT_COMMAND = 'transcript';
const NO_CONVERSATION = 'No agent conversations yet, so there is no transcript.';

const CLOSE_REASON: Record<string, string> = {
  ended: 'ended by an agent',
  owner_ended: 'ended by an owner',
  limit: 'message limit reached',
  expired: 'no activity for 24 hours',
  booked: 'booked',
};

/** Notices, after-events (digest flags, I17: never texted at once), resume and the idle sweep. */
export function createA2AService(d: A2ADeps, views: ReturnType<typeof createViews>, outcomes: { resumeBookings(): Promise<number>; settleHeld(): Promise<number> }) {
  const repo = a2aRepo(d.db);

  async function sendNotice(job: { id: string }): Promise<void> {
    const res = await d.db.query<{ agent_id: string; purpose: 'reply' | 'question'; text: string; tainted: boolean; status: string }>(
      'SELECT agent_id, purpose, text, tainted, status FROM a2a_notices WHERE id = $1',
      [job.id],
    );
    const n = res.rows[0];
    if (!n || n.status === 'sent') return;
    const agent = await d.repos.agents.get(n.agent_id);
    const sent = agent && !agent.paused ? await d.gateway.sendToOwner(n.agent_id, n.text, { purpose: n.purpose, ...(n.tainted ? { meta: { tainted: true } } : {}) }) : null;
    // I14: held while paused; onResume re-queues it.
    await d.db.query(`UPDATE a2a_notices SET status = $2, sent_at = $3 WHERE id = $1 AND status <> 'sent'`, [job.id, sent ? 'sent' : 'waiting', sent ? d.clock.now() : null]);
  }

  /**
   * I19 prompt-last: a Brain turn sends the agent's pending notices (e.g. the 'Talking to …'
   * line of a conversation it opened) before its approval prompts. The notice jobs then find them sent.
   */
  async function flushNotices(agentId: string): Promise<void> {
    const res = await d.db.query<{ id: string }>(`SELECT id FROM a2a_notices WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at, id`, [agentId]);
    for (const n of res.rows) await sendNotice(n);
  }

  async function after(job: { conversationId: string; event: AfterEvent; groupId?: string | null }): Promise<void> {
    const conv = await repo.conversation(job.conversationId);
    if (!conv) return;
    for (const agentId of [conv.initiator_agent_id, conv.responder_agent_id]) {
      const parties = await repo.parties(conv, agentId);
      const about = `${parties.peerLabel} about ${shown(conv.topic, 80)}`;
      if (job.event === 'opened' && agentId === conv.responder_agent_id) {
        await d.flags.raise(agentId, { kind: 'a2a_opened', urgency: 'digest', text: `${parties.peerLabel} started a conversation with your ${parties.me.agent.name} about ${shown(conv.topic, 80)}.`, dedupeKey: `a2a-opened:${conv.id}` });
      }
      if (job.event === 'closed') {
        await d.flags.raise(agentId, { kind: 'a2a_closed', urgency: 'digest', text: `Conversation with ${about} closed (${CLOSE_REASON[conv.close_reason ?? ''] ?? 'closed'}).`, dedupeKey: `a2a-closed:${conv.id}` });
      }
      if (job.event === 'booked') {
        await d.flags.raise(agentId, { kind: 'a2a_booked', urgency: 'digest', text: `Booked after talking with ${about}.`, dedupeKey: `a2a-booked:${conv.id}` });
      }
    }
    if (job.event === 'closed' && job.groupId) {
      const pending = await d.db.query<{ id: string }>(`SELECT id FROM approvals WHERE group_id = $1 AND status = 'pending' ORDER BY seq`, [job.groupId]);
      for (const a of pending.rows) await d.approvals.cancel(a.id, 'the conversation closed');
    }
  }

  /** Notices that waited (paused, or no owner chat) are queued again on their agent's lane. */
  async function requeueNotices(where: string, params: unknown[]): Promise<void> {
    const notices = await d.db.query<{ id: string; agent_id: string; requeues: number }>(
      `UPDATE a2a_notices SET status = 'pending', requeues = requeues + 1 WHERE status = 'waiting' AND ${where} RETURNING id, agent_id, requeues`,
      params,
    );
    for (const n of notices.rows) await d.jobs.enqueue(NOTICE_JOB, { id: n.id }, { lane: n.agent_id, dedupeKey: `a2a:notice:${n.id}:r${n.requeues}` });
  }

  /**
   * onResume (I14): deliveries and notices that waited while paused are queued again. S3: the
   * notices go out now, in order, so the approvals' unsent prompts (sent by their own hook,
   * which runs after this one) are the last thing the owner gets.
   */
  async function resume(agentId: string): Promise<void> {
    await requeueNotices('agent_id = $1', [agentId]);
    await flushNotices(agentId);
    const turns = await d.db.query<{ turn_key: string; conversation_id: string; trigger_seq: number; requeues: number }>(
      `UPDATE a2a_turns SET requeues = requeues + 1 WHERE agent_id = $1 AND status = 'waiting' RETURNING turn_key, conversation_id, trigger_seq, requeues`,
      [agentId],
    );
    for (const t of turns.rows) {
      await d.jobs.enqueue(TURN_JOB, { conversationId: t.conversation_id, agentId, seq: t.trigger_seq }, { lane: agentId, dedupeKey: `a2a:turn:${t.turn_key}:r${t.requeues}` });
    }
  }

  /**
   * Q5: the owner types `transcript` (trimmed, any case): code sends the transcript of their
   * latest agent conversation, with no model call. An owner interceptor, so it runs only for
   * the verified owner (I1) and is held while paused (I14) like every owner message.
   */
  async function transcriptCommand(ctx: OwnerMessageCtx): Promise<boolean> {
    if (ctx.msg.kind !== 'text' || ctx.msg.text.trim().toLowerCase() !== TRANSCRIPT_COMMAND) return false;
    const conversationId = await views.latest(ctx.agent.id);
    await d.actionLog.write({ agentId: ctx.agent.id, actor: 'owner', action: 'a2a.transcript', detail: { conversationId, messageId: ctx.messageId } });
    if (!conversationId) {
      await d.gateway.sendToOwner(ctx.agent.id, NO_CONVERSATION, { purpose: 'reply' });
      return true;
    }
    await d.gateway.sendToOwner(ctx.agent.id, await views.transcript(ctx.agent.id, conversationId), { purpose: 'transcript', meta: { tainted: true } });
    return true;
  }

  const service: A2AService = {
    listConversations: (agentId, includeClosed) => views.list(agentId, includeClosed),
    transcript: (agentId, conversationId) => views.transcript(agentId, conversationId),
    // Bookings left mid-way first (I7: undo or finish them), then idle conversations. Notices
    // that waited for an owner chat (none after a pairing:reissue --reset) go to the chat paired
    // since; a paused agent's notices wait for onResume (I14).
    sweep: async () => {
      await outcomes.resumeBookings();
      await outcomes.settleHeld();
      await requeueNotices('agent_id IN (SELECT id FROM agents WHERE NOT paused AND owner_address IS NOT NULL)', []);
      return expireIdle(d);
    },
  };

  return { service, sendNotice, flushNotices, after, resume, transcriptCommand };
}
