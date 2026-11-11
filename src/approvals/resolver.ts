import type { App } from '../app.js';
import type { OwnerMessageCtx } from '../core/router.js';
import { sanitize } from '../core/sanitize.js';
import { approvalsRepo, promptSummary } from './repo.js';
import type { ApprovalServiceImpl } from './service.js';
import type { ApprovalRow } from './types.js';

export type Decision = 'approved' | 'denied';

const YES = ['yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'sure', 'approve', 'do it', 'go ahead', '👍'];
const NO = ['no', 'n', 'nope', 'nah', "don't", 'decline', 'cancel', '👎'];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS = [...YES, ...NO].sort((a, b) => b.length - a.length).map(escape).join('|');
const GRAMMAR = new RegExp(`^(${WORDS})(?:\\s*#?\\s*(\\d{1,6}))?[\\s.!]*$`, 'u');
/** Emoji presentation selector and skin tones: 👍🏽 counts as 👍. */
const EMOJI_NOISE = /[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

/** Section 8.3 grammar: a yes/no word, optionally followed by `#?<ref>`. Anything else → null. */
export function parseDecision(text: string): { decision: Decision; ref?: number } | null {
  const t = text.normalize('NFKC').replace(EMOJI_NOISE, '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const m = GRAMMAR.exec(t);
  if (!m) return null;
  const decision: Decision = YES.includes(m[1]!) ? 'approved' : 'denied';
  return m[2] ? { decision, ref: Number(m[2]) } : { decision };
}

const BUTTON = /^(approve|deny):([A-Za-z0-9-]{1,64})$/;

export const RESOLVER_TEXT = Object.freeze({
  notOpen: (ref?: number) => (ref === undefined ? "That one isn't open any more." : `#${ref} isn't open any more.`),
  approvedDefault: (ref: number) => `Okay, approved #${ref}.`,
  deniedDefault: (ref: number) => `Okay, not doing #${ref}.`,
});

export const WHICH_ONE_MAX = 600;

/** "Which one?" with a one-line list of what is pending. */
export function whichOne(pending: ApprovalRow[]): string {
  const list = pending.map((a) => promptSummary(a)).join(' · ');
  const ref = pending[0]?.ref ?? 1;
  return sanitize(`Which one? ${list} — reply yes ${ref} or no ${ref}.`, WHICH_ONE_MAX);
}

/**
 * The deterministic approval resolver (I5): an owner interceptor. The router runs it only
 * for the verified owner (I1) and never while paused (I14). Target: explicit ref (an
 * approval that existed when the message was stored) → the prompt being replied to → the
 * only pending approval whose prompt was delivered before the message → "Which one?". A
 * reply-to naming no prompt never takes the implicit target. Nothing answerable → not
 * handled (the Brain gets the message). Idempotent per message: a retried
 * hook finds the approval it already resolved (resolved_by_message_id) and finishes it.
 */
export function createResolver(app: App, service: ApprovalServiceImpl) {
  const { db, clock } = app.deps;
  const repo = approvalsRepo(db, clock);

  async function reply(ctx: OwnerMessageCtx, text: string): Promise<true> {
    await app.gateway.sendToOwner(ctx.agent.id, text, { purpose: 'reply' });
    return true;
  }

  /** Runs the kind's callback and sends the short confirmation. Safe to repeat. */
  async function finish(ctx: OwnerMessageCtx, a: ApprovalRow): Promise<true> {
    const kind = service.kind(a.kind);
    const kctx = await service.kindContext(a);
    const approved = a.status !== 'denied';
    const text = approved ? await kind?.onApproved?.(kctx) : await kind?.onDenied?.(kctx);
    return reply(ctx, text || (approved ? RESOLVER_TEXT.approvedDefault(a.ref) : RESOLVER_TEXT.deniedDefault(a.ref)));
  }

  async function resolve(ctx: OwnerMessageCtx, target: ApprovalRow, decision: Decision): Promise<true> {
    const resolved = await db.tx(async (tx) => {
      const row = await approvalsRepo(tx, clock).resolvePending(target.id, ctx.agent.id, decision, ctx.messageId);
      if (row) {
        await app.actionLog.write(
          {
            agentId: ctx.agent.id,
            actor: 'owner',
            action: decision === 'approved' ? 'approval.approved' : 'approval.denied',
            detail: { approvalId: row.id, ref: row.ref, kind: row.kind, messageId: ctx.messageId, via: ctx.msg.kind },
          },
          tx,
        );
      }
      return row;
    });
    if (resolved) return finish(ctx, resolved);
    const now = await repo.get(target.id);
    if (now?.resolved_by_message_id === ctx.messageId) return finish(ctx, now);
    await stale(ctx, target.id, 'not_pending');
    return reply(ctx, RESOLVER_TEXT.notOpen(target.ref));
  }

  async function stale(ctx: OwnerMessageCtx, approvalId: string | null, reason: string): Promise<void> {
    await app.actionLog.write({ agentId: ctx.agent.id, actor: 'owner', action: 'approval.not_open', detail: { approvalId, reason, messageId: ctx.messageId } });
  }

  async function onButton(ctx: OwnerMessageCtx): Promise<true> {
    const m = BUTTON.exec(ctx.msg.buttonPayload ?? '');
    const target = m ? await repo.get(m[2]!) : null;
    if (!m || !target || target.agent_id !== ctx.agent.id) {
      // Never resolve another agent's approval, whatever the payload says.
      await stale(ctx, null, !m ? 'bad_button' : target ? 'wrong_agent' : 'unknown_approval');
      return reply(ctx, RESOLVER_TEXT.notOpen());
    }
    return resolve(ctx, target, m[1] === 'approve' ? 'approved' : 'denied');
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

    if (parsed.ref !== undefined) {
      const found = await repo.byRef(ctx.agent.id, parsed.ref);
      // A ref typed before that approval existed names something else (principle 5).
      const target = found && (await repo.existedBefore(found.id, ctx.messageId)) ? found : null;
      if (target?.status === 'pending') return resolve(ctx, target, parsed.decision);
      await stale(ctx, target?.id ?? null, target ? 'not_pending' : 'unknown_ref');
      return reply(ctx, RESOLVER_TEXT.notOpen(parsed.ref));
    }
    const replyTo = ctx.msg.replyToTransportMessageId;
    const repliedTo = replyTo ? await repo.byPromptMessage(ctx.agent.id, replyTo) : null;
    if (repliedTo) {
      if (repliedTo.status === 'pending') return resolve(ctx, repliedTo, parsed.decision);
      await stale(ctx, repliedTo.id, 'not_pending');
      return reply(ctx, RESOLVER_TEXT.notOpen(repliedTo.ref));
    }
    // Implicit targets only among prompts the owner had actually seen when they wrote:
    // delivered, and delivered BEFORE this message was stored (principle 5). A "yes" meant
    // for something else, typed or queued before a prompt went out, or a retried hook
    // whose Brain turn created a prompt, never approves it. An explicit #ref can still
    // name any pending approval that existed when the message was written.
    const pending = await repo.listAnswerable(ctx.agent.id, ctx.messageId);
    if (pending.length === 0) return false;
    // A reply to a message that is not one of this agent's prompts (e.g. a model reply
    // that looks like a prompt) is an explicit signal the owner meant that message: never
    // guess the target from it.
    if (pending.length === 1 && !replyTo) return resolve(ctx, pending[0]!, parsed.decision);
    await app.actionLog.write({
      agentId: ctx.agent.id,
      actor: 'owner',
      action: 'approval.ambiguous',
      detail: { pending: pending.length, messageId: ctx.messageId, ...(replyTo ? { reason: 'reply_to_non_prompt' } : {}) },
    });
    return reply(ctx, whichOne(pending));
  };
}
