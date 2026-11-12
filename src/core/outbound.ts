import type { Logger } from 'pino';
import { TransportError, type OutboundButton, type OutboundPurpose, type Transport } from '../transport/types.js';
import type { ActionLog } from './actionLog.js';
import { cannedText, type CannedKey } from './canned.js';
import type { Repos } from './repos/index.js';
import type { AgentRow } from './types.js';

export interface SentToOwner {
  /** null: delivered, but the `messages` row could not be stored (outbound.sent `recorded: false`). */
  messageId: string | null;
  transportMessageId: string;
}

/**
 * I4: the only door out. Exactly two methods. There is no way to send free text
 * to anyone but the agent's owner.
 */
export interface OutboundGateway {
  /** Returns null when suppressed (paused, or no owner bound yet). */
  sendToOwner(
    agentId: string,
    text: string,
    opts: { purpose: Exclude<OutboundPurpose, 'canned'>; buttons?: OutboundButton[]; meta?: OwnerMessageMeta },
  ): Promise<SentToOwner | null>;
  sendCanned(agentId: string, contactId: string, key: CannedKey): Promise<void>;
}

/**
 * Internal path for the pause/resume acknowledgement (I14). Only the router gets
 * this object; it is not reachable through the gateway.
 */
export interface ControlChannel {
  sendPauseAck(agentId: string, text: string): Promise<SentToOwner | null>;
}

interface Deps {
  transport: Transport;
  repos: Repos;
  actionLog: ActionLog;
  log: Logger;
}

export type OwnerPurpose = Exclude<OutboundPurpose, 'canned'>;

/** Stored on the outbound `messages` row. `tainted`: the text quotes third parties or was written in a tainted Brain turn (M4). */
export interface OwnerMessageMeta {
  tainted?: boolean;
  /** 'brain': a reply the Brain wrote (I19: a typed yes under it is conversation, not an answer to a prompt). */
  from?: 'brain';
}

export function createOutbound(deps: Deps): { gateway: OutboundGateway; control: ControlChannel } {
  const { transport, repos, actionLog, log } = deps;

  async function suppressed(agentId: string, reason: string, detail: Record<string, unknown>): Promise<null> {
    await actionLog.write({ agentId, actor: 'system', action: 'outbound.suppressed', detail: { reason, ...detail } });
    return null;
  }

  /**
   * I15: every attempt leaves an outbound row. A send that fails is `outbound.failed` (and
   * rethrown, so the job retries). A text the transport delivered is never sent again: if
   * storing it fails, `outbound.sent` is written with `recorded: false` and the caller is told
   * it was sent (`messageId` null), so no retry repeats it.
   */
  async function deliverToOwner(
    agent: AgentRow,
    raw: string,
    purpose: OwnerPurpose,
    buttons: OutboundButton[] | undefined,
    meta: OwnerMessageMeta = {},
  ): Promise<SentToOwner | null> {
    if (!agent.owner_address) return suppressed(agent.id, 'no_owner', { purpose });
    const text = storable(raw);
    // Nothing to say once stored (only NULs or spaces): an empty message is never sent.
    if (text.trim() === '') return suppressed(agent.id, 'empty', { purpose });
    let sent: { transportMessageId: string };
    try {
      sent = await transport.send({
        agentAddress: agent.agent_address,
        toAddress: agent.owner_address,
        text,
        purpose,
        ...(buttons && buttons.length > 0 ? { buttons } : {}),
      });
    } catch (err) {
      await logFailure(agent.id, purpose, err);
      throw err;
    }
    const logged = { to: 'owner', purpose, transportMessageId: sent.transportMessageId, chars: text.length };
    let messageId: string | null = null;
    try {
      const row = await repos.messages.add({
        agentId: agent.id,
        thread: 'owner',
        direction: 'out',
        body: text,
        purpose,
        transportMessageId: sent.transportMessageId,
        meta: {
          ...(meta.tainted ? { tainted: true } : {}),
          ...(meta.from ? { from: meta.from } : {}),
          ...(buttons && buttons.length > 0 ? { buttons } : {}),
        },
      });
      messageId = row.id;
      await actionLog.write({ agentId: agent.id, actor: 'system', action: 'outbound.sent', detail: { ...logged, messageId } });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ agentId: agent.id, purpose, err: error }, 'owner message delivered but not fully recorded');
      try {
        // `tainted` kept here (M.2): the history misses this row, so the next Brain turn reads the taint from the log.
        const taint = meta.tainted ? { tainted: true } : {};
        await actionLog.write({ agentId: agent.id, actor: 'system', action: 'outbound.sent', detail: { ...logged, messageId, recorded: false, error, ...taint } });
      } catch (logErr) {
        // The action log itself cannot be written: the text is delivered, so it is still not sent again.
        log.error(
          { agentId: agent.id, purpose, transportMessageId: sent.transportMessageId, err: logErr instanceof Error ? logErr.message : String(logErr) },
          'owner message delivered but neither its message row nor its outbound.sent row could be stored',
        );
      }
    }
    return { messageId, transportMessageId: sent.transportMessageId };
  }

  /**
   * The error is rethrown by the caller: a permanent TransportError makes the job dead
   * at once (no retry storm), a retryable one keeps the job's retries (see jobs.ts).
   */
  async function logFailure(agentId: string, purpose: OutboundPurpose, err: unknown, extra: Record<string, unknown> = {}): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof TransportError
        ? { permanent: err.permanent, reason: err.reason, ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) }
        : {};
    log.warn({ agentId, purpose, err: error, ...cause }, 'outbound send failed');
    await actionLog.write({ agentId, actor: 'system', action: 'outbound.failed', detail: { purpose, error, ...cause, ...extra } });
  }

  async function loadAgent(agentId: string): Promise<AgentRow> {
    const agent = await repos.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    return agent;
  }

  const gateway: OutboundGateway = Object.freeze({
    async sendToOwner(agentId: string, text: string, opts: { purpose: OwnerPurpose; buttons?: OutboundButton[]; meta?: OwnerMessageMeta }) {
      if ((opts.purpose as OutboundPurpose) === 'canned') throw new Error('canned texts go through sendCanned');
      const agent = await loadAgent(agentId);
      if (agent.paused) return suppressed(agent.id, 'paused', { purpose: opts.purpose });
      return deliverToOwner(agent, text, opts.purpose, opts.buttons, opts.meta);
    },

    async sendCanned(agentId: string, contactId: string, key: CannedKey) {
      // I15: every canned attempt leaves an outbound row. A failure before the send is
      // logged as outbound.failed (sent: false); a failure while recording a text that
      // was delivered still writes outbound.sent, then rethrows.
      let agent: AgentRow;
      let contact: Awaited<ReturnType<typeof repos.contacts.get>>;
      try {
        agent = await loadAgent(agentId);
        contact = await repos.contacts.get(contactId);
        if (!contact || contact.agent_id !== agent.id) throw new Error(`contact ${contactId} does not belong to agent ${agentId}`);
      } catch (err) {
        await logFailure(agentId, 'canned', err, { key, contactId, sent: false });
        throw err;
      }
      if (agent.paused) {
        await suppressed(agent.id, 'paused', { purpose: 'canned', key, contactId });
        return;
      }
      const text = cannedText(key);
      let sent: { transportMessageId: string };
      try {
        sent = await transport.send({ agentAddress: agent.agent_address, toAddress: contact.address, text, purpose: 'canned' });
      } catch (err) {
        await logFailure(agent.id, 'canned', err, { key, contactId, sent: false });
        throw err;
      }
      let messageId: string | null = null;
      let marked = false;
      try {
        const row = await repos.messages.add({
          agentId: agent.id,
          thread: 'contact',
          contactId: contact.id,
          direction: 'out',
          body: text,
          purpose: 'canned',
          transportMessageId: sent.transportMessageId,
        });
        messageId = row.id;
        await repos.contacts.markCannedReply(contact.id);
        marked = true;
        await actionLog.write({
          agentId: agent.id,
          actor: 'system',
          action: 'outbound.sent',
          detail: { to: 'contact', purpose: 'canned', key, contactId, messageId, transportMessageId: sent.transportMessageId },
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn({ agentId: agent.id, err: error }, 'canned reply delivered but not fully recorded');
        // Keep the rate limit if we can, so a later message does not resend at once.
        if (!marked) await repos.contacts.markCannedReply(contact.id).catch(() => undefined);
        await actionLog.write({
          agentId: agent.id,
          actor: 'system',
          action: 'outbound.sent',
          detail: { to: 'contact', purpose: 'canned', key, contactId, messageId, transportMessageId: sent.transportMessageId, recorded: false, error },
        });
        throw err;
      }
    },
  });

  const control: ControlChannel = {
    async sendPauseAck(agentId, text) {
      return deliverToOwner(await loadAgent(agentId), text, 'ack', undefined);
    },
  };

  return { gateway, control };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Every owner-bound text can be stored: U+0000 is dropped and lone surrogates become U+FFFD (Postgres rejects both). */
export function storable(text: string): string {
  return text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD');
}
