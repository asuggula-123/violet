import type { Logger } from 'pino';
import type { OutboundButton, OutboundPurpose, Transport } from '../transport/types.js';
import type { ActionLog } from './actionLog.js';
import { cannedText, type CannedKey } from './canned.js';
import type { Repos } from './repos/index.js';
import type { AgentRow } from './types.js';

export interface SentToOwner {
  messageId: string;
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
    opts: { purpose: Exclude<OutboundPurpose, 'canned'>; buttons?: OutboundButton[] },
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

type OwnerPurpose = Exclude<OutboundPurpose, 'canned'>;

export function createOutbound(deps: Deps): { gateway: OutboundGateway; control: ControlChannel } {
  const { transport, repos, actionLog, log } = deps;

  async function suppressed(agentId: string, reason: string, detail: Record<string, unknown>): Promise<null> {
    await actionLog.write({ agentId, actor: 'system', action: 'outbound.suppressed', detail: { reason, ...detail } });
    return null;
  }

  async function deliverToOwner(
    agent: AgentRow,
    text: string,
    purpose: OwnerPurpose,
    buttons: OutboundButton[] | undefined,
  ): Promise<SentToOwner | null> {
    if (!agent.owner_address) return suppressed(agent.id, 'no_owner', { purpose });
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
    const row = await repos.messages.add({
      agentId: agent.id,
      thread: 'owner',
      direction: 'out',
      body: text,
      purpose,
      transportMessageId: sent.transportMessageId,
      meta: buttons && buttons.length > 0 ? { buttons } : {},
    });
    await actionLog.write({
      agentId: agent.id,
      actor: 'system',
      action: 'outbound.sent',
      detail: { to: 'owner', purpose, messageId: row.id, transportMessageId: sent.transportMessageId, chars: text.length },
    });
    return { messageId: row.id, transportMessageId: sent.transportMessageId };
  }

  async function logFailure(agentId: string, purpose: OutboundPurpose, err: unknown, extra: Record<string, unknown> = {}): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ agentId, purpose, err: error }, 'outbound send failed');
    await actionLog.write({ agentId, actor: 'system', action: 'outbound.failed', detail: { purpose, error, ...extra } });
  }

  async function loadAgent(agentId: string): Promise<AgentRow> {
    const agent = await repos.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    return agent;
  }

  const gateway: OutboundGateway = Object.freeze({
    async sendToOwner(agentId: string, text: string, opts: { purpose: OwnerPurpose; buttons?: OutboundButton[] }) {
      if ((opts.purpose as OutboundPurpose) === 'canned') throw new Error('canned texts go through sendCanned');
      const agent = await loadAgent(agentId);
      if (agent.paused) return suppressed(agent.id, 'paused', { purpose: opts.purpose });
      return deliverToOwner(agent, text, opts.purpose, opts.buttons);
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
