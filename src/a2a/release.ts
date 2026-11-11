import { z } from 'zod';
import { PROMPT_BODY_MAX } from '../approvals/service.js';
import type { ApprovalKind } from '../approvals/types.js';
import { sha256 } from '../brain/memo.js';
import { isoInstant } from '../brain/time.js';
import type { BrainToolCtx } from '../brain/types.js';
import { ToolError } from '../llm/tools.js';
import { addGuidance, openConversation } from './conversations.js';
import { isRefusal, Refusal, type A2ADeps } from './deps.js';
import { egressCheck } from './egress.js';
import { releasePrompt } from './render.js';
import { a2aRepo } from './repo.js';
import { ownerSaidIt } from './words.js';

export const RELEASE_KIND = 'a2a_release';

const releasePayload = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    peerAgentId: z.string().min(1).max(100),
    peerLabel: z.string().min(1).max(120),
    topic: z.string().min(1).max(100),
    text: z.string().min(1).max(700),
    windowStart: isoInstant.nullable(),
    windowEnd: isoInstant.nullable(),
  }),
  z.object({
    action: z.literal('guidance'),
    conversationId: z.string().min(1).max(100),
    peerLabel: z.string().min(1).max(120),
    text: z.string().min(1).max(700),
  }),
]);
export type ReleaseAction = z.infer<typeof releasePayload>;

const render = (p: ReleaseAction) => releasePrompt(p.peerLabel, p.text, p.action === 'open' ? p.topic : undefined);
const textsOf = (p: ReleaseAction) => (p.action === 'open' ? [p.topic, p.text] : [p.text]);

/**
 * I11: the ONLY way private knowledge reaches another agent. Every release passes
 * EgressGuard; in a tainted Brain turn it is held as an `a2a_release` approval showing the
 * exact text (unless the owner typed every significant word of it themselves this turn).
 * Yes → released exactly as stored. The owner always sees, code-rendered, what went out.
 */
export function createReleases(d: A2ADeps) {
  async function perform(agentId: string, p: ReleaseAction, key: string, notice: boolean): Promise<{ line: string; conversationId: string }> {
    if (p.action === 'guidance') {
      const { conv, line } = await addGuidance(d, { agentId, conversationId: p.conversationId, text: p.text, key, notice });
      return { line, conversationId: conv.id };
    }
    const initiator = await d.repos.agents.get(agentId);
    const responder = await d.repos.agents.get(p.peerAgentId);
    const [a, b] = await Promise.all([initiator, responder].map(async (x) => (x ? d.repos.owners.get(x.owner_id) : null)));
    if (!initiator || !responder || !a || !b || a.household_id !== b.household_id) throw new Refusal('not_household', 'That agent is not in your household.', true);
    const window = p.windowStart && p.windowEnd ? { start: new Date(p.windowStart), end: new Date(p.windowEnd) } : null;
    const { conv, line } = await openConversation(d, { initiator, responder, householdId: a.household_id, topic: p.topic, brief: p.text, window, key, notice });
    return { line, conversationId: conv.id };
  }

  async function logEntry(agentId: string, action: string, p: ReleaseAction, extra: Record<string, unknown> = {}) {
    const text = textsOf(p).join('\n');
    await d.actionLog.write({ agentId, actor: 'brain', action, detail: { release: p.action, textHash: sha256(text).slice(0, 16), length: text.length, ...extra } });
  }

  /** Runs one release from a Brain tool. Returns the tool result; throws ToolError when blocked or refused. */
  async function release(ctx: BrainToolCtx, p: ReleaseAction, window: { start: Date; end: Date } | null): Promise<string> {
    if (textsOf(p).some((t) => t === '')) throw new ToolError('The text is empty once control characters are removed.');
    const peer = p.action === 'open' ? p.peerAgentId : await peerAgent(ctx.agent.id, p.conversationId);
    const names = await namesOf([ctx.agent.id, peer]);
    const egress = await egressCheck(d, { ownerId: ctx.owner.id, texts: textsOf(p), ownerText: ctx.turn.ownerText, names, window });
    if (egress.ok === false) {
      await logEntry(ctx.agent.id, 'a2a.release_blocked', p, { matches: egress.matches });
      throw new ToolError(
        "Not sent: the text contains a detail from the owner's calendar (an event name, place, person or note) that the owner did not mention in this message. Rewrite it without that detail.",
      );
    }
    const verbatim = ownerSaidIt(ctx.turn.ownerText, textsOf(p), names);
    if (egress.ok === 'unreadable' || (ctx.turn.tainted && !verbatim)) {
      if (Array.from(render(p)).length > PROMPT_BODY_MAX) {
        throw new ToolError(`This needs the owner's yes, and the prompt must show the text in full: shorten it to about ${PROMPT_BODY_MAX - 60} characters.`);
      }
      const approval = await d.approvals.request(ctx.agent.id, { kind: RELEASE_KIND, payload: p, idempotencyKey: ctx.callKey });
      await logEntry(ctx.agent.id, 'a2a.release_held', p, { approvalId: approval.id, reason: egress.ok === 'unreadable' ? 'calendar_unreadable' : 'tainted' });
      return `Not sent yet: ${ctx.owner.name} gets a yes/no prompt (#${approval.ref}) showing the exact text, because this turn read third-party content. It goes out only if they say yes. Do not repeat the prompt.`;
    }
    const done = await perform(ctx.agent.id, p, ctx.callKey, true);
    await logEntry(ctx.agent.id, 'a2a.release', p, { conversationId: done.conversationId, verbatim: ctx.turn.tainted });
    const opened = p.action === 'open' ? ` Conversation id: ${done.conversationId}.` : '';
    return `Sent to ${p.peerLabel}.${opened} ${ctx.owner.name} is shown exactly what was sent; do not repeat it.`;
  }

  async function peerAgent(agentId: string, conversationId: string): Promise<string> {
    const conv = await a2aRepo(d.db).conversation(conversationId);
    if (!conv) throw new ToolError('There is no such conversation.');
    return conv.initiator_agent_id === agentId ? conv.responder_agent_id : conv.initiator_agent_id;
  }

  async function namesOf(agentIds: string[]): Promise<string[]> {
    const res = await d.db.query<{ name: string; owner: string }>(
      'SELECT a.name, o.name AS owner FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ANY($1::text[])',
      [agentIds],
    );
    return res.rows.flatMap((r) => [r.name, r.owner.split(/\s+/)[0] ?? '']);
  }

  const kind: ApprovalKind<ReleaseAction> = {
    schema: releasePayload,
    quotesThirdParty: true,
    render: (p) => render(p),
    async onApproved({ approval }) {
      const p = releasePayload.parse(approval.payload);
      try {
        const { line } = await perform(approval.agent_id, p, `approval:${approval.id}`, false);
        await logEntry(approval.agent_id, 'a2a.release', p, { approvalId: approval.id });
        return line;
      } catch (err) {
        if (!isRefusal(err)) throw err;
        await d.actionLog.write({ agentId: approval.agent_id, actor: 'system', action: err.limit ? 'a2a.limit' : 'a2a.tool_denied', detail: { tool: RELEASE_KIND, [err.limit ? 'limit' : 'reason']: err.reason } });
        return `Couldn't send it: ${err.ownerMessage}`;
      }
    },
    onDenied: async () => "Okay, I won't send it.",
  };

  return { release, kind };
}
