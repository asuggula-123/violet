import { wrapUntrusted } from '../brain/untrusted.js';
import type { BrainContextProvider } from '../brain/types.js';
import { sanitize } from '../core/sanitize.js';
import type { Queryable } from '../db/db.js';
import { shown, transcriptLine, whole } from './render.js';
import { a2aRepo, isParty } from './repo.js';
import type { ConversationSummary } from './types.js';

/** Read-side views for the owner and the Brain (both owners can read any conversation their agent is in). */
export function createViews(db: Queryable) {
  const repo = a2aRepo(db);

  async function list(agentId: string, includeClosed = false): Promise<ConversationSummary[]> {
    const out: ConversationSummary[] = [];
    for (const conv of await repo.forAgent(agentId, includeClosed)) {
      const parties = await repo.parties(conv, agentId);
      out.push({ id: conv.id, peer: parties.peerLabel, topic: shown(conv.topic, 80), status: conv.status, openedByMe: conv.initiator_agent_id === agentId });
    }
    return out;
  }

  /** send_transcript_to_owner and the `transcript` command: every stored message the owner's side may see, one code-rendered line each. */
  async function transcript(agentId: string, conversationId: string): Promise<string> {
    const conv = await repo.conversation(conversationId);
    if (!conv || !isParty(conv, agentId)) throw new Error('a2a: not a party to this conversation');
    const parties = await repo.parties(conv, agentId);
    const tz = parties.me.owner.timezone;
    const head = `Transcript: ${sanitize(parties.me.agent.name, 40)} ↔ ${parties.peerLabel}, ${whole(conv.topic, 100)} (${conv.status}${conv.close_reason ? `: ${conv.close_reason}` : ''})`;
    const lines = (await repo.visible(conv.id, agentId)).map((m) => transcriptLine(m, parties, tz));
    return [head, ...lines].join('\n');
  }

  /** The agent's latest conversation (the one started last), open or closed, or null. */
  async function latest(agentId: string): Promise<string | null> {
    const res = await db.query<{ id: string }>(
      'SELECT id FROM a2a_conversations WHERE initiator_agent_id = $1 OR responder_agent_id = $1 ORDER BY seq DESC LIMIT 1',
      [agentId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * D4 / G: open conversations and open Envoy questions in the Brain's dynamic context.
   * Topics the other side chose and every Envoy question are third-party text: untrusted,
   * and they taint the turn (so an answer to a question is a tainted release).
   */
  const brainContext: BrainContextProvider = async (agent) => {
    const convs = await repo.forAgent(agent.id, false);
    if (convs.length === 0) return null;
    let tainted = false;
    const lines = ['Agent conversations (ids for tell_envoy, read_agent_conversation, send_transcript_to_owner, end_agent_conversation):'];
    const questions: string[] = [];
    for (const conv of convs) {
      const parties = await repo.parties(conv, agent.id);
      const mineOpened = conv.initiator_agent_id === agent.id;
      const topic = mineOpened ? shown(conv.topic, 80) : wrapUntrusted('agent', sanitize(conv.topic, 80));
      tainted ||= !mineOpened;
      const side = await repo.side(conv.id, agent.id);
      const waiting = side?.awaiting_owner || side?.stalled ? ', your Envoy waits for guidance' : '';
      lines.push(`- ${conv.id}: with ${parties.peerLabel}, about ${topic}, ${conv.status}${mineOpened ? ', opened by you' : ''}${waiting}`);
      if (!side?.awaiting_owner) continue;
      const rows = await repo.visible(conv.id, agent.id);
      const lastGuidance = Math.max(0, ...rows.filter((m) => m.kind === 'guidance').map((m) => m.seq));
      for (const q of rows.filter((m) => m.kind === 'question' && m.seq > lastGuidance)) questions.push(`- conversation ${conv.id}: ${sanitize(q.body, 500)}`);
    }
    if (questions.length > 0) {
      tainted = true;
      lines.push('Open questions from your Envoy (answer with tell_envoy):', wrapUntrusted('agent', questions.join('\n')));
    }
    return { text: lines.join('\n'), tainted };
  };

  return { list, transcript, latest, brainContext };
}
