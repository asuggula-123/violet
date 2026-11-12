import { z } from 'zod';
import { PROMPT_BODY_MAX } from '../approvals/service.js';
import { approvalsRepo } from '../approvals/repo.js';
import type { ApprovalKind, ApprovalRow } from '../approvals/types.js';
import { sha256 } from '../brain/memo.js';
import { isoInstant } from '../brain/time.js';
import type { BrainToolCtx } from '../brain/types.js';
import { ToolError } from '../llm/tools.js';
import { addGuidance, openConversation } from './conversations.js';
import { isRefusal, Refusal, type A2ADeps } from './deps.js';
import { egressCheck } from './egress.js';
import { releasePrompt } from './render.js';
import { a2aRepo, queueNotice } from './repo.js';

export const RELEASE_KIND = 'a2a_release';
/** The reply to a yes that landed while paused (suppressed while paused; the release goes out after resume). */
const PAUSED_REPLY = "You're paused, so it waits: it goes out when you text resume.";

const releasePayload = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    peerAgentId: z.string().min(1).max(100),
    peerLabel: z.string().min(1).max(120),
    topic: z.string().min(1).max(100),
    text: z.string().min(1).max(700),
    windowStart: isoInstant.nullable(),
    windowEnd: isoInstant.nullable(),
    /** The owner's time zone, for showing the window in the prompt (I20). */
    timezone: z.string().min(1).max(64).optional(),
    /** When the Brain asked, so the prompt can show the year when the window is in another one (I20). Never crosses. */
    requestedAt: isoInstant.optional(),
  }),
  z.object({
    action: z.literal('guidance'),
    conversationId: z.string().min(1).max(100),
    peerLabel: z.string().min(1).max(120),
    text: z.string().min(1).max(700),
  }),
]);
export type ReleaseAction = z.infer<typeof releasePayload>;

/**
 * I20: the prompt shows everything that crosses: the topic, the text and the window (to the
 * minute, as stored; with the year and the UTC offset whenever they are not otherwise certain).
 */
const render = (p: ReleaseAction) =>
  p.action === 'open'
    ? releasePrompt(
        p.peerLabel,
        p.text,
        p.topic,
        p.windowStart && p.windowEnd
          ? { start: new Date(p.windowStart), end: new Date(p.windowEnd), timezone: p.timezone ?? 'UTC', requestedAt: p.requestedAt ? new Date(p.requestedAt) : undefined }
          : undefined,
      )
    : releasePrompt(p.peerLabel, p.text);
const textsOf = (p: ReleaseAction) => (p.action === 'open' ? [p.topic, p.text] : [p.text]);

/**
 * The fixed tool result of a held release. I19: the prompt is held by the turn and goes out
 * after the reply, or on resume when a pause lands (also after this text was returned), so
 * the text promises neither; the model must not write the prompt, its number or a request to
 * confirm itself.
 */
function heldText(peer: string, owner: string): string {
  return `Not sent. Nothing has gone to ${peer}: ${owner} gets a yes/no prompt showing the exact text after your reply, or when I can send again, and it goes out only if they say yes. Tell ${owner} you will check with them first; do not say it was sent, and do not repeat the prompt or ask them to confirm in your own words.`;
}

/**
 * I11 + I20: the ONLY way private knowledge reaches another agent. Every release passes
 * EgressGuard; in a tainted Brain turn it is ALWAYS held as an `a2a_release` approval
 * showing the exact text, whoever's words they are (code cannot tell what the owner meant
 * to keep private, so there is no owner-verbatim exception). An unreadable calendar holds
 * it too. Yes → released exactly as stored. The owner always sees, code-rendered, what went out.
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
    // I20 + idempotency: a call that already made an approval (a retry of the same tool call,
    // whether or not this run is tainted) is answered by that approval's state, never released
    // again: after a no nothing goes out, after a yes it is not sent a second time.
    const earlier = await d.db.query<{ ref: number; status: string }>(
      'SELECT ref, status FROM approvals WHERE agent_id = $1 AND idempotency_key = $2 AND kind = $3',
      [ctx.agent.id, ctx.callKey, RELEASE_KIND],
    );
    const prior = earlier.rows[0];
    if (prior && prior.status !== 'pending') return priorResult(ctx, p, prior);
    const peer = p.action === 'open' ? p.peerAgentId : await peerAgent(ctx.agent.id, p.conversationId);
    const names = await namesOf([ctx.agent.id, peer]);
    const egress = await egressCheck(d, { ownerId: ctx.owner.id, texts: textsOf(p), ownerText: ctx.turn.ownerText, names, window });
    if (egress.ok === false) {
      await logEntry(ctx.agent.id, 'a2a.release_blocked', p, { matches: egress.matches });
      throw new ToolError(
        "Not sent: the text contains a detail from the owner's calendar (an event name, place, person or note) that the owner did not mention in this message. Rewrite it without that detail.",
      );
    }
    if (egress.ok === 'unreadable' || ctx.turn.tainted || prior) {
      if (Array.from(render(p)).length > PROMPT_BODY_MAX) {
        throw new ToolError(`This needs the owner's yes, and the prompt must show the text in full: shorten it to about ${PROMPT_BODY_MAX - 60} characters.`);
      }
      const approval = await d.approvals.request(ctx.agent.id, { kind: RELEASE_KIND, payload: p, idempotencyKey: ctx.callKey });
      await logEntry(ctx.agent.id, 'a2a.release_held', p, { approvalId: approval.id, reason: egress.ok === 'unreadable' ? 'calendar_unreadable' : ctx.turn.tainted ? 'tainted' : 'pending_retry' });
      return heldText(p.peerLabel, ctx.owner.name);
    }
    const done = await perform(ctx.agent.id, p, ctx.callKey, true);
    await logEntry(ctx.agent.id, 'a2a.release', p, { conversationId: done.conversationId });
    const opened = p.action === 'open' ? ` Conversation id: ${done.conversationId}.` : '';
    return `Sent to ${p.peerLabel}.${opened} ${ctx.owner.name} is shown exactly what was sent; do not repeat it.`;
  }

  function priorResult(ctx: BrainToolCtx, p: ReleaseAction, prior: { ref: number; status: string }): string {
    const who = ctx.owner.name;
    if (prior.status === 'approved' || prior.status === 'executed') {
      return `${who} already said yes to this (#${prior.ref}) and it was handled then; it is not sent again. Do not repeat it.`;
    }
    const why = prior.status === 'denied' ? `${who} said no to it` : prior.status === 'expired' ? `${who} did not answer in time` : 'it was not sent';
    throw new ToolError(`Not sent: this exact request was already put to ${who} (#${prior.ref}) and ${why}. Do not send it again.`);
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

  /**
   * Carries out an approved release exactly as stored (key `approval:<id>`, so a repeat never
   * releases twice) and marks the approval executed, or failed on a refusal. I14: while the
   * agent is paused nothing crosses: the approval stays `approved` and `resumeApproved` carries
   * it out after the owner's resume. Returns the owner's line and, when refused, the reason shown.
   */
  async function carryOut(approval: Pick<ApprovalRow, 'id' | 'agent_id' | 'payload'>, notice: boolean): Promise<{ line: string; refused: string | null }> {
    const p = releasePayload.parse(approval.payload);
    const finish = (status: 'executed' | 'failed', error: string | null) => approvalsRepo(d.db, d.clock).finishExecution(approval.id, status, error);
    try {
      const { line } = await perform(approval.agent_id, p, `approval:${approval.id}`, notice);
      if (await finish('executed', null)) await d.actionLog.write({ agentId: approval.agent_id, actor: 'system', action: 'approval.executed', detail: { approvalId: approval.id } });
      await logEntry(approval.agent_id, 'a2a.release', p, { approvalId: approval.id });
      return { line, refused: null };
    } catch (err) {
      if (!isRefusal(err)) throw err;
      await d.actionLog.write({ agentId: approval.agent_id, actor: 'system', action: err.limit ? 'a2a.limit' : 'a2a.tool_denied', detail: { tool: RELEASE_KIND, approvalId: approval.id, [err.limit ? 'limit' : 'reason']: err.reason } });
      if (err.reason === 'paused') {
        // The log row above marks it for resumeApproved. A resume that ran between the refusal
        // and that row did not see it, so the pause is read again: if it is already over, it
        // goes out now (the key makes a second carry-out by the resume hook a no-op).
        const agent = await d.repos.agents.get(approval.agent_id);
        if (agent && !agent.paused) return carryOut(approval, notice);
        return { line: PAUSED_REPLY, refused: null };
      }
      if (await finish('failed', err.ownerMessage)) await d.actionLog.write({ agentId: approval.agent_id, actor: 'system', action: 'approval.failed', detail: { approvalId: approval.id, reason: err.reason } });
      return { line: `Couldn't send it: ${err.ownerMessage}`, refused: err.ownerMessage };
    }
  }

  /**
   * onResume (I14): releases the owner approved that a pause refused (approved just before
   * the pause landed) are carried out now, once; the owner gets the usual
   * `Talking to …` / `Told …` notice, or one `Couldn't send #n: …` line.
   */
  async function resumeApproved(agentId: string): Promise<void> {
    // Only releases a pause held back (carryOut logged that refusal with the approval's id):
    // a row left `approved` for any other reason (e.g. by older code after a refusal the owner
    // was told about) never crosses here.
    const res = await d.db.query<Pick<ApprovalRow, 'id' | 'agent_id' | 'payload' | 'ref'>>(
      `SELECT a.id, a.agent_id, a.payload, a.ref FROM approvals a
       WHERE a.agent_id = $1 AND a.kind = $2 AND a.status = $3
         AND EXISTS (SELECT 1 FROM action_log l WHERE l.agent_id = a.agent_id AND l.action = 'a2a.tool_denied'
                     AND l.detail->>'approvalId' = a.id AND l.detail->>'reason' = 'paused')
       ORDER BY a.seq`,
      [agentId, RELEASE_KIND, 'approved'],
    );
    for (const a of res.rows) {
      const { refused } = await carryOut(a, true);
      if (refused) await queueNotice(d.db, d, { id: `release-failed:${a.id}`, agentId, purpose: 'reply', text: `Couldn't send #${a.ref}: ${refused}`, tainted: false });
    }
  }

  const kind: ApprovalKind<ReleaseAction> = {
    schema: releasePayload,
    quotesThirdParty: true,
    render: (p) => render(p),
    async onApproved({ approval }) {
      // A retried hook after a refusal: the refusal stands, nothing is tried again.
      if (approval.status === 'failed') return `Couldn't send it: ${approval.error ?? 'it was refused'}`;
      return (await carryOut(approval, false)).line;
    },
    onDenied: async () => "Okay, I won't send it.",
  };

  return { release, kind, resumeApproved };
}
