import { addMs } from '../clock.js';
import type { App } from '../app.js';
import { sanitize } from '../core/sanitize.js';
import { pgErrorCode } from '../db/db.js';
import { createCalendarWriter } from './calendarWriter.js';
import { deliveriesRepo, type DeliveryKind } from './deliveries.js';
import { codeLine, NUMBER_SIGNS } from './line.js';
import { approvalsRepo, PROMPT_TAIL, promptSummary } from './repo.js';
import { currentTurn } from './turn.js';
import type { ApprovalKind, ApprovalRow, ApprovalService, KindContext } from './types.js';

export const DEFAULT_EXPIRY_MS = 24 * 3_600_000;
/** Cap for the rendered part of a prompt (I13). */
export const PROMPT_BODY_MAX = 240;
/** How long a delivery claim holds before another sender may retry. */
export const SEND_LEASE_MS = 120_000;
/**
 * How long an approval requested inside a Brain turn is held for that turn to deliver it:
 * the job queue's stale time (10 min) plus a margin. After it, the sweep delivers it (the
 * turn died: the prompt comes late, never never).
 */
export const TURN_HOLD_MS = 15 * 60_000;
/** The one fixed prefix of a re-prompt (I19 rule d), on the same line as the stored prompt. */
export const REPROMPT_PREFIX = 'Just to be sure: ';

export interface ApprovalServiceImpl extends ApprovalService {
  kind(name: string): ApprovalKind | undefined;
  kindContext(approval: ApprovalRow): Promise<KindContext>;
  /**
   * Sends a claimed re-send of `a`'s stored prompt (a re-prompt with REPROMPT_PREFIX, or a
   * "Which one?" copy) through the same gateway call as the first delivery and records its
   * transport id. Returns false when the gateway suppressed it (paused) or the send failed.
   */
  resend(a: ApprovalRow, forMessageId: string, kind: Exclude<DeliveryKind, 'prompt'>): Promise<boolean>;
}

/**
 * I13: the prompt is code-rendered from the stored payload and forced to ONE line with no
 * number sign in the rendered part (codeLine), so the leading `#<ref>` is the only reference in it.
 */
export function composePrompt(ref: number, rendered: string): string {
  return `#${ref} ${codeLine(rendered, PROMPT_BODY_MAX)}${PROMPT_TAIL}`;
}

/**
 * Whether composePrompt would show `rendered` whole (no cut at PROMPT_BODY_MAX). Kinds whose
 * yes acts on more than the prompt could show (M4 multi-event outcomes) check this first.
 */
export function promptFits(rendered: string): boolean {
  const raw = sanitize(rendered, Number.MAX_SAFE_INTEGER);
  const folded = sanitize(raw.normalize('NFKC').replace(NUMBER_SIGNS, ''), Number.MAX_SAFE_INTEGER);
  return Array.from(raw).length <= PROMPT_BODY_MAX && Array.from(folded).length <= PROMPT_BODY_MAX;
}

export function approvalButtons(id: string) {
  return [
    { id: `approve:${id}`, label: 'Yes' },
    { id: `deny:${id}`, label: 'No' },
  ];
}

export function createApprovalService(app: App): ApprovalServiceImpl {
  const { db, clock, calendar: provider, log } = app.deps;
  const { repos, actionLog, gateway, flags } = app;
  const kinds = new Map<string, ApprovalKind>();
  const repo = approvalsRepo(db, clock);
  const deliveries = deliveriesRepo(db, clock);
  const calendar = createCalendarWriter({ db, clock, repos, calendar: provider, actionLog, flags, log, kind: (n) => kinds.get(n) });

  async function ownerOf(agentId: string) {
    const agent = await repos.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    const owner = await repos.owners.get(agent.owner_id);
    if (!owner) throw new Error(`agent ${agentId} has no owner row`);
    return { agent, owner };
  }

  /**
   * Sends a pending, unexpired prompt that has not reached the owner yet. Never throws on a
   * failed send. Concurrent callers (request, a raced idempotent request, onResume, the
   * sweep) are serialized by an atomic claim: only the claimant sends, so a prompt goes out
   * once. A claim that lapses (sender died mid-send) lets the sweep try again.
   */
  /** The one gateway call every genuine delivery goes through (purpose 'approval', buttons, tainted per kind). */
  function sendPrompt(a: ApprovalRow, text: string) {
    return gateway.sendToOwner(a.agent_id, text, {
      purpose: 'approval',
      buttons: approvalButtons(a.id),
      ...(service.quotesThirdParty(a.kind) ? { meta: { tainted: true } } : {}),
    });
  }

  async function deliver(a: ApprovalRow): Promise<ApprovalRow> {
    if (a.status !== 'pending' || a.prompt_transport_message_id !== null) return a;
    if (!(await repo.claimSend(a.id, SEND_LEASE_MS))) return (await repo.get(a.id)) ?? a;
    try {
      const sent = await sendPrompt(a, a.prompt);
      if (!sent) {
        await repo.releaseSend(a.id); // paused: sent on resume
        return a;
      }
      await db.tx(async (tx) => {
        if (await approvalsRepo(tx, clock).markSent(a.id, sent.transportMessageId)) {
          await deliveriesRepo(tx, clock).recordFirst(a.agent_id, a.id, sent.transportMessageId);
        }
      });
      return { ...a, prompt_transport_message_id: sent.transportMessageId };
    } catch (err) {
      // The gateway logged outbound.failed; the sweep sends it later.
      await repo.releaseSend(a.id);
      log.warn({ approvalId: a.id, err: err instanceof Error ? err.message : String(err) }, 'approval prompt not sent');
      return a;
    }
  }

  /** The requested (or default) expiry, never later than the kind's own deadline. */
  function expiryOf(kind: ApprovalKind, payload: unknown, requested: Date | undefined): Date {
    const base = requested ?? addMs(clock.now(), DEFAULT_EXPIRY_MS);
    const deadline = kind.latestExpiry?.(payload);
    return deadline && deadline.getTime() < base.getTime() ? deadline : base;
  }

  const service: ApprovalServiceImpl = {
    calendar,
    kind: (name) => kinds.get(name),
    quotesThirdParty: (name) => kinds.get(name)?.quotesThirdParty === true,

    async kindContext(approval) {
      const { agent, owner } = await ownerOf(approval.agent_id);
      return { approval, agent, owner, calendar };
    },

    registerKind(name, def) {
      if (kinds.has(name)) throw new Error(`approval kind already registered: ${name}`);
      kinds.set(name, def as ApprovalKind);
    },

    async request(agentId, r) {
      const kind = kinds.get(r.kind);
      if (!kind) throw new Error(`unknown approval kind: ${r.kind}`);
      const payload = kind.schema.parse(r.payload);
      const { owner } = await ownerOf(agentId);
      const key = r.idempotencyKey ?? null;
      // Inside a Brain turn the prompt is held: the turn delivers it after its reply (deliverTurn).
      const turn = currentTurn();
      const deliverNow = (a: ApprovalRow) => (turn === undefined ? deliver(a) : a);
      if (key) {
        const existing = await repo.byKey(agentId, key);
        if (existing) return deliverNow(existing);
      }
      const rendered = kind.render(payload, { timezone: owner.timezone });
      let created: ApprovalRow;
      try {
        created = await db.tx(async (tx) => {
          const row = await approvalsRepo(tx, clock).insert({
            agentId,
            kind: r.kind,
            payload,
            prompt: (ref) => composePrompt(ref, rendered),
            groupId: r.groupId ?? null,
            expiresAt: expiryOf(kind, payload, r.expiresAt),
            idempotencyKey: key,
            holdUntil: turn === undefined ? null : addMs(clock.now(), TURN_HOLD_MS),
            turnMessageId: turn ?? null,
          });
          await actionLog.write(
            { agentId, actor: 'system', action: 'approval.requested', detail: { approvalId: row.id, ref: row.ref, kind: row.kind, groupId: row.group_id } },
            tx,
          );
          return row;
        });
      } catch (err) {
        // A concurrent request with the same key won the insert.
        const raced = key && pgErrorCode(err) === '23505' ? await repo.byKey(agentId, key) : null;
        if (!raced) throw err;
        created = raced;
      }
      return deliverNow(created);
    },

    async deliverTurn(agentId, messageId) {
      // Creation order, hold ignored; also picks up approvals an earlier attempt of the turn left.
      for (const a of await repo.listTurnUnsent(agentId, messageId)) await deliver(a);
      await repo.releaseTurn(agentId, messageId);
    },

    async resend(a, forMessageId, kind) {
      const text = kind === 'reprompt' ? `${REPROMPT_PREFIX}${a.prompt}` : a.prompt;
      try {
        const sent = await sendPrompt(a, text);
        if (sent) await deliveries.markSent(a.agent_id, forMessageId, a.id, sent.transportMessageId);
        return sent !== null;
      } catch (err) {
        // The gateway logged outbound.failed. The claim stays: a retry never sends it again.
        log.warn({ approvalId: a.id, err: err instanceof Error ? err.message : String(err) }, 'approval prompt not re-sent');
        return false;
      }
    },

    get: (id) => repo.get(id),
    listPending: (agentId) => repo.listPending(agentId),

    async cancel(id, reason) {
      const row = await repo.cancelPending(id, sanitize(reason, 200));
      if (!row) return false;
      await actionLog.write({ agentId: row.agent_id, actor: 'system', action: 'approval.cancelled', detail: { approvalId: id, ref: row.ref, reason: row.error } });
      return true;
    },

    async sendUnsent(agentId) {
      // Nothing expires while paused (the sweep skips paused agents): close what lapsed
      // first, so resume never delivers a stale prompt.
      await service.expireDue(agentId);
      for (const a of await repo.listUnsent(agentId)) await deliver(a);
    },

    async expireDue(agentId) {
      const expired = await repo.expireDue(agentId);
      for (const a of expired) {
        await actionLog.write({ agentId, actor: 'scheduler', action: 'approval.expired', detail: { approvalId: a.id, ref: a.ref, kind: a.kind } });
        await kinds.get(a.kind)?.onExpired?.(await service.kindContext(a));
        await flags.raise(agentId, {
          kind: 'approval_expired',
          urgency: 'digest',
          text: `No answer, so it expired: ${promptSummary(a)}`,
          dedupeKey: `approval-expired:${a.id}`,
        });
      }
      return expired.length;
    },
  };
  return service;
}
