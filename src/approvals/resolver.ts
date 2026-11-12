import type { App } from '../app.js';
import type { OwnerMessageCtx } from '../core/router.js';
import { idsAbove } from '../transport/chatOrder.js';
import { claimDeliveries, deliveriesRepo } from './deliveries.js';
import { approvalsRepo } from './repo.js';
import type { ApprovalServiceImpl } from './service.js';
import type { ApprovalRow } from './types.js';

export type Decision = 'approved' | 'denied';

const YES = ['yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'sure', 'approve', 'do it', 'go ahead', '👍'];
const NO = ['no', 'n', 'nope', 'nah', "don't", 'decline', 'cancel', '👎'];
/**
 * I19 (c): words that often just acknowledge something. Typed bare with no genuine prompt
 * directly above, they never re-prompt: the Brain gets them. Directly under a prompt they
 * answer it like any yes.
 */
export const WEAK_ACKS = ['ok', 'okay', 'sure', '👍'];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS = [...YES, ...NO].sort((a, b) => b.length - a.length).map(escape).join('|');
const GRAMMAR = new RegExp(`^(${WORDS})(?:\\s*#?\\s*(\\d{1,6}))?[\\s.!]*$`, 'u');
/** Emoji presentation selector and skin tones: 👍🏽 counts as 👍. */
const EMOJI_NOISE = /[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

function match(text: string): { word: string; ref?: number } | null {
  const t = text.normalize('NFKC').replace(EMOJI_NOISE, '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const m = GRAMMAR.exec(t);
  if (!m) return null;
  return m[2] ? { word: m[1]!, ref: Number(m[2]) } : { word: m[1]! };
}

/** Section 8.3 grammar: a yes/no word, optionally followed by `#?<ref>`. Anything else → null. */
export function parseDecision(text: string): { decision: Decision; ref?: number } | null {
  const m = match(text);
  if (!m) return null;
  const decision: Decision = YES.includes(m.word) ? 'approved' : 'denied';
  return m.ref !== undefined ? { decision, ref: m.ref } : { decision };
}

/** A bare weak acknowledgement (WEAK_ACKS, no ref). */
export function isWeakAck(text: string): boolean {
  const m = match(text);
  return m !== null && m.ref === undefined && WEAK_ACKS.includes(m.word);
}

const BUTTON = /^(approve|deny):([A-Za-z0-9-]{1,64})$/;

/** How many prompts one "Which one?" re-sends (oldest first). */
export const WHICH_ONE_LIMIT = 5;

export const RESOLVER_TEXT = Object.freeze({
  notOpen: (ref?: number) => (ref === undefined ? "That one isn't open any more." : `#${ref} isn't open any more.`),
  approvedDefault: (ref: number) => `Okay, approved #${ref}.`,
  deniedDefault: (ref: number) => `Okay, not doing #${ref}.`,
  /** Fixed, no quoted content and no refs: the prompts follow, each as its own message. */
  whichOne: (more: number) =>
    `Which one? Tap Yes or No under it, or reply yes and its number.${more > 0 ? ` ${more} more ${more === 1 ? 'is' : 'are'} waiting after these.` : ''}`,
});

type Basis = 'reply_to' | 'run';

/** A re-send claim was lost (a candidate closed meanwhile, or another run of the message claimed first). */
class LostClaim extends Error {}

/**
 * The deterministic approval resolver (I5, I19): an owner interceptor. The router runs it
 * only for the verified owner (I1) and never while paused (I14). A typed yes/no resolves an
 * approval only when a genuine delivery of it (approval_deliveries) is the message replied
 * to, or is in RUN(m), the unbroken run of genuine deliveries directly above the message in
 * the transport's own numbering. Otherwise the prompt is shown again (re-prompt, or "Which
 * one?" with each prompt as its own message), and nothing is resolved. Safety never depends
 * on what any text looks like. Idempotent per message: a retried hook finds the approval it
 * resolved (resolved_by_message_id) or the re-sends it claimed (for_message_id).
 */
export function createResolver(app: App, service: ApprovalServiceImpl) {
  const { db, clock } = app.deps;
  const repo = approvalsRepo(db, clock);
  const deliveries = deliveriesRepo(db, clock);

  /** `tainted`: the text quotes third parties (service.untrusted: the kind, or a tainted turn's approval): stored tainted (8.2 history hygiene). */
  async function reply(ctx: OwnerMessageCtx, text: string, tainted = false): Promise<true> {
    await app.gateway.sendToOwner(ctx.agent.id, text, { purpose: 'reply', ...(tainted ? { meta: { tainted: true } } : {}) });
    return true;
  }

  /** Runs the kind's callback and sends the short confirmation, then (S1) the one other prompt of RUN(m). Safe to repeat. */
  async function finish(ctx: OwnerMessageCtx, a: ApprovalRow): Promise<true> {
    const kind = service.kind(a.kind);
    const kctx = await service.kindContext(a);
    const approved = a.status !== 'denied';
    const text = approved ? await kind?.onApproved?.(kctx) : await kind?.onDenied?.(kctx);
    await reply(ctx, text || (approved ? RESOLVER_TEXT.approvedDefault(a.ref) : RESOLVER_TEXT.deniedDefault(a.ref)), service.untrusted(a));
    await showNextInRun(ctx, a);
    return true;
  }

  /**
   * S1: one message made Violet ask twice and m answered one of them. If exactly one other
   * approval delivered in RUN(m) is still pending, its prompt is shown again right below the
   * confirmation (a genuine re-prompt delivery), so the owner's next bare yes or no is directly
   * under it (I19 unchanged). Claimed per (m, approval): a retried hook sends nothing more. A
   * button press has no chat number, so its RUN(m) is empty and nothing is shown again.
   */
  async function showNextInRun(ctx: OwnerMessageCtx, resolved: ApprovalRow): Promise<void> {
    const run = new Set(await deliveries.run(ctx.agent.id, ctx.msg.chatMessageId));
    run.delete(resolved.id);
    if (run.size === 0) return;
    const others = (await repo.listPending(ctx.agent.id)).filter((x) => run.has(x.id));
    if (others.length !== 1 || (await app.repos.agents.get(ctx.agent.id))?.paused !== false) return;
    const next = others[0]!;
    if (!(await claimDeliveries(db, clock, ctx.agent.id, ctx.messageId, [next.id], 'reprompt'))) return;
    const sent = await service.resend(next, ctx.messageId, 'reprompt');
    await log(ctx, 'approval.reprompted', { approvalId: next.id, ref: next.ref, reason: 'next_in_run', ...(sent ? {} : { sent: false }) });
  }

  function log(ctx: OwnerMessageCtx, action: string, detail: Record<string, unknown>): Promise<void> {
    return app.actionLog.write({ agentId: ctx.agent.id, actor: 'owner', action, detail: { ...detail, messageId: ctx.messageId } });
  }

  async function resolve(ctx: OwnerMessageCtx, target: ApprovalRow, decision: Decision, basis?: Basis): Promise<true> {
    const resolved = await db.tx(async (tx) => {
      const row = await approvalsRepo(tx, clock).resolvePending(target.id, ctx.agent.id, decision, ctx.messageId);
      if (row) {
        await app.actionLog.write(
          {
            agentId: ctx.agent.id,
            actor: 'owner',
            action: decision === 'approved' ? 'approval.approved' : 'approval.denied',
            detail: { approvalId: row.id, ref: row.ref, kind: row.kind, messageId: ctx.messageId, via: ctx.msg.kind, ...(basis ? { basis } : {}) },
          },
          tx,
        );
      }
      return row;
    });
    if (resolved) return finish(ctx, resolved);
    const now = await repo.get(target.id);
    if (now?.resolved_by_message_id === ctx.messageId) return finish(ctx, now);
    return notOpen(ctx, target.id, target.ref, 'not_pending');
  }

  async function notOpen(ctx: OwnerMessageCtx, approvalId: string | null, ref: number | undefined, reason: string): Promise<true> {
    await log(ctx, 'approval.not_open', { approvalId, reason });
    return reply(ctx, RESOLVER_TEXT.notOpen(ref));
  }

  async function onButton(ctx: OwnerMessageCtx): Promise<true> {
    const m = BUTTON.exec(ctx.msg.buttonPayload ?? '');
    const target = m ? await repo.get(m[2]!) : null;
    if (!m || !target || target.agent_id !== ctx.agent.id) {
      // Never resolve another agent's approval, whatever the payload says.
      await log(ctx, 'approval.not_open', { approvalId: null, reason: !m ? 'bad_button' : target ? 'wrong_agent' : 'unknown_approval' });
      return reply(ctx, RESOLVER_TEXT.notOpen());
    }
    return resolve(ctx, target, m[1] === 'approve' ? 'approved' : 'denied');
  }

  /** Rule (d): the stored prompt again, as one new genuine delivery. Claimed first; only the claimant sends. */
  async function reprompt(ctx: OwnerMessageCtx, a: ApprovalRow, reason: string): Promise<true> {
    if (!(await claimDeliveries(db, clock, ctx.agent.id, ctx.messageId, [a.id], 'reprompt'))) throw new LostClaim();
    const sent = await service.resend(a, ctx.messageId, 'reprompt');
    await log(ctx, 'approval.reprompted', { approvalId: a.id, ref: a.ref, reason, ...(sent ? {} : { sent: false }) });
    return true;
  }

  /** Rule (e): one fixed line, then each prompt re-sent as its own genuine delivery, oldest first. */
  async function whichOne(ctx: OwnerMessageCtx, candidates: ApprovalRow[], reason: string): Promise<true> {
    const shown = candidates.slice(0, WHICH_ONE_LIMIT);
    if (!(await claimDeliveries(db, clock, ctx.agent.id, ctx.messageId, shown.map((a) => a.id), 'which_one'))) throw new LostClaim();
    await log(ctx, 'approval.ambiguous', { pending: candidates.length, shown: shown.map((a) => a.id), reason });
    await reply(ctx, RESOLVER_TEXT.whichOne(candidates.length - shown.length));
    for (const a of shown) await service.resend(a, ctx.messageId, 'which_one');
    return true;
  }

  /** An approval named by ref, only if it existed before the message was written (principle 5). */
  async function byRef(ctx: OwnerMessageCtx, ref: number): Promise<ApprovalRow | null> {
    const found = await repo.byRef(ctx.agent.id, ref);
    return found && (await repo.existedBefore(found.id, ctx.messageId)) ? found : null;
  }

  /** Rule (b) target check, and rule (a) with a ref that does not match the replied-to prompt. */
  async function named(ctx: OwnerMessageCtx, ref: number, run: string[] | null, decision: Decision, reason: string): Promise<true> {
    const a = await byRef(ctx, ref);
    if (a?.status !== 'pending') return notOpen(ctx, a?.id ?? null, ref, a ? 'not_pending' : 'unknown_ref');
    if (run?.includes(a.id)) return resolve(ctx, a, decision, 'run');
    return reprompt(ctx, a, reason);
  }

  /** Whether the message directly above is a Brain reply or an Envoy question: it may itself ask the owner something. */
  async function conversationAbove(ctx: OwnerMessageCtx): Promise<boolean> {
    const above = idsAbove(ctx.msg.chatMessageId, 1)[0];
    if (!above) return false;
    const res = await db.query<{ purpose: string | null; sender: string | null }>(
      `SELECT purpose, meta->>'from' AS sender FROM messages
       WHERE agent_id = $1 AND thread = 'owner' AND direction = 'out' AND transport_message_id = $2`,
      [ctx.agent.id, above],
    );
    return res.rows.some((r) => r.sender === 'brain' || r.purpose === 'question');
  }

  /** Rules (d)/(e) over `candidates`: one → re-prompt it; several → Which one, oldest first. */
  async function showAgain(ctx: OwnerMessageCtx, candidates: ApprovalRow[], reason: string): Promise<true> {
    if (candidates.length === 1) return reprompt(ctx, candidates[0]!, reason);
    return whichOne(ctx, [...candidates].sort((x, y) => x.ref - y.ref), reason);
  }

  /** No genuine prompt answered: show the right prompt again, or let the Brain have the message. */
  async function askAgain(ctx: OwnerMessageCtx, reason: string, conversational: boolean): Promise<boolean> {
    const candidates = await repo.listAnswerable(ctx.agent.id, ctx.messageId);
    if (candidates.length === 0) return false;
    // A conversational word or a reply to something that may ask a question goes to the Brain (it cannot approve).
    if (isWeakAck(ctx.msg.text)) return false;
    if (conversational && (await conversationAbove(ctx))) return false;
    return showAgain(ctx, candidates, reason);
  }

  /**
   * P10: never silence. A lost claim (a candidate closed between the choice and its claim) runs
   * the choice once more with fresh candidates; lost again, the owner gets the not-open line.
   * Rows for m already claimed by another run of m: that run answers (g).
   */
  async function onText(ctx: OwnerMessageCtx, decision: Decision, ref: number | undefined): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await decideText(ctx, decision, ref);
      } catch (err) {
        if (!(err instanceof LostClaim)) throw err;
        if (await deliveries.claimedFor(ctx.agent.id, ctx.messageId)) return true;
        if (attempt >= 1) return notOpen(ctx, null, undefined, 'claim_lost');
      }
    }
  }

  async function decideText(ctx: OwnerMessageCtx, decision: Decision, ref: number | undefined): Promise<boolean> {
    const agentId = ctx.agent.id;
    // (a) Reply-to, checked before RUN: binds to the real message replied to.
    const replyTo = ctx.msg.replyToTransportMessageId;
    if (replyTo) {
      const replied = await repo.byPromptMessage(agentId, replyTo);
      if (replied && (ref === undefined || ref === replied.ref)) {
        if (replied.status === 'pending') return resolve(ctx, replied, decision, 'reply_to');
        return notOpen(ctx, replied.id, replied.ref, 'not_pending');
      }
      const reason = replied ? 'ref_conflict' : 'reply_to_non_prompt';
      if (ref !== undefined) return named(ctx, ref, null, decision, reason);
      return askAgain(ctx, reason, false);
    }
    const run = await deliveries.run(agentId, ctx.msg.chatMessageId);
    // (b) Explicit ref: resolves only with a genuine delivery of it in RUN(m).
    if (ref !== undefined) return named(ctx, ref, run, decision, 'not_above');
    // (c) Bare answer: resolves only when RUN(m) names exactly one approval and it is pending.
    // Counted over every approval in RUN(m), closed or not: what the owner saw above is what
    // counts, so an approval that closes between arrival and processing (the other owner's
    // no, a closed conversation, expiry) never turns an ambiguous yes into a yes for the other.
    const distinct = [...new Set(run)];
    const inRun = (await repo.listPending(agentId)).filter((a) => distinct.includes(a.id));
    if (distinct.length === 1) {
      if (inRun.length === 1) return resolve(ctx, inRun[0]!, decision, 'run');
      // P9: the one prompt directly above is closed: say so, as a reply-to or `yes <ref>` would.
      const closed = await repo.get(distinct[0]!);
      return notOpen(ctx, distinct[0]!, closed?.ref, 'not_pending');
    }
    // P8: two or more above: (d)/(e) on those still pending (one left → (d)); none → not open.
    if (distinct.length > 1) return inRun.length === 0 ? notOpen(ctx, null, undefined, 'not_pending') : showAgain(ctx, inRun, 'several_above');
    return askAgain(ctx, 'not_above', true);
  }

  return async function approvalResolver(ctx: OwnerMessageCtx): Promise<boolean> {
    const done = await repo.resolvedBy(ctx.agent.id, ctx.messageId);
    if (done) return finish(ctx, done);
    if (ctx.msg.kind !== 'button' && ctx.msg.kind !== 'text') return false;
    const parsed = ctx.msg.kind === 'text' ? parseDecision(ctx.msg.text) : null;
    if (ctx.msg.kind === 'text' && !parsed) return false;
    // An approval past expires_at is closed even if the sweep has not run (it never runs
    // while paused): mark those expired first, so every target check below sees it.
    await service.expireDue(ctx.agent.id);
    if (!parsed) return onButton(ctx);
    // (g) A retry of a message that already caused re-sends sends nothing more.
    if (await deliveries.claimedFor(ctx.agent.id, ctx.messageId)) return true;
    return onText(ctx, parsed.decision, parsed.ref);
  };
}
