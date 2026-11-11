import type { Clock } from '../clock.js';
import type { Db } from '../db/db.js';
import type { InboundMessage } from '../transport/types.js';
import type { ActionEntry, ActionLog } from './actionLog.js';
import { OWNER_TEXT } from './canned.js';
import type { FlagService } from './flags.js';
import type { ControlChannel, OutboundGateway } from './outbound.js';
import { pairingCodeMatches, parseStartCommand } from './pairing.js';
import { inboundFromPayload } from './repos/inboundEvents.js';
import { createRepos, type Repos } from './repos/index.js';
import { quote, sanitize } from './sanitize.js';
import type { AgentRow, InboundEventRow, OwnerRow } from './types.js';

export const CANNED_REPLY_INTERVAL_MS = 12 * 3_600_000;

export interface OwnerMessageCtx {
  agent: AgentRow;
  owner: OwnerRow;
  msg: InboundMessage;
  /** Id of the stored inbound row in `messages`. */
  messageId: string;
}

/**
 * Hooks run at least once per inbound message: if a later step of the same event
 * fails, the retried job runs them again with the same `messageId`. A hook with side
 * effects keys them on `messageId` (approvals, a2a messages, …) so a retry does not
 * repeat them. Everything the router itself does before a hook runs exactly once.
 */
export interface RouterHooks {
  /** Deterministic pre-brain handlers, tried in order. Return true if handled. */
  ownerInterceptors: Array<(ctx: OwnerMessageCtx) => Promise<boolean>>;
  /** The Brain. M1 default: replies "I'm not fully set up yet." */
  onOwnerMessage: (ctx: OwnerMessageCtx) => Promise<void>;
  onPause: Array<(agentId: string) => Promise<void>>;
  /** M4 re-queues waiting Envoy turns. */
  onResume: Array<(agentId: string) => Promise<void>>;
}

export interface Router {
  readonly hooks: RouterHooks;
  /** Flow 8.1 steps 2–6 for one stored inbound event. */
  process(inboundEventId: string): Promise<void>;
}

interface Deps {
  db: Db;
  clock: Clock;
  repos: Repos;
  actionLog: ActionLog;
  gateway: OutboundGateway;
  control: ControlChannel;
  flags: FlagService;
}

const PAUSE_COMMAND = /^\/?(pause|resume)$/i;

/** Routing step that records the pause/resume state change (see applyPauseCommand). */
export const PAUSE_STATE_STEP = 'pause.state';

/**
 * Recorded by app.ingest when the agent was already paused as the event arrived.
 * Such a message is held even if a resume is ingested before its job runs (I14).
 */
export const PAUSED_AT_ARRIVAL_STEP = 'paused_at_arrival';

/** I1: owner identity is an exact (transport, address) match. Nothing else counts. */
export function isOwner(agent: AgentRow, msg: InboundMessage): boolean {
  return agent.owner_address !== null && msg.transport === agent.transport && msg.fromAddress === agent.owner_address;
}

/** The exact pause/resume command (case-insensitive, optional leading `/`), or null. */
export function pauseCommandOf(msg: InboundMessage): 'pause' | 'resume' | null {
  if (msg.kind !== 'text') return null;
  const command = PAUSE_COMMAND.exec(msg.text.trim())?.[1]?.toLowerCase();
  return command === 'pause' || command === 'resume' ? command : null;
}

/** The owner's own pause/resume command (I1 exact match), or null. */
export function ownerPauseCommand(agent: AgentRow, msg: InboundMessage): 'pause' | 'resume' | null {
  return isOwner(agent, msg) ? pauseCommandOf(msg) : null;
}

/**
 * Flips the pause state and logs it, inside the caller's transaction. app.ingest
 * calls this in the transaction that stores the inbound event (pause is immediate:
 * it never waits behind the lane's backlog) and records the result as the event's
 * PAUSE_STATE_STEP, so the queued job only acks and runs hooks.
 */
export async function applyPauseCommand(s: StepCtx, agentId: string, command: 'pause' | 'resume'): Promise<{ changed: boolean }> {
  const wantPaused = command === 'pause';
  const changed = await s.repos.agents.flipPaused(agentId, wantPaused);
  if (changed) await s.log({ agentId, actor: 'owner', action: wantPaused ? 'agent.paused' : 'agent.resumed' });
  return { changed };
}

export function createRouter(deps: Deps): Router {
  const { db, clock, repos, actionLog, gateway, control, flags } = deps;

  const hooks: RouterHooks = {
    ownerInterceptors: [],
    onOwnerMessage: async (ctx) => {
      await gateway.sendToOwner(ctx.agent.id, OWNER_TEXT.notSetUp, { purpose: 'reply' });
    },
    onPause: [],
    onResume: [],
  };

  /**
   * Resumable processing (I18). Each step of the flow is recorded in
   * inbound_events.progress with its result; a retried job skips the steps already
   * done and reuses their results.
   * - `atomic` steps only write to the DB: their writes and the step record commit
   *   in one transaction, so they happen exactly once.
   * - `once` steps talk to the outside (sends, hooks). The step is recorded after it
   *   succeeds, so a failure retries only this step and the ones after it.
   */
  function stepsFor(event: InboundEventRow) {
    const done = new Map<string, unknown>(Object.entries(event.progress ?? {}));
    return {
      async atomic<T>(name: string, fn: (s: StepCtx) => Promise<T>): Promise<T> {
        if (done.has(name)) return done.get(name) as T;
        const out = await db.tx(async (tx) => {
          const txRepos = createRepos(tx, clock);
          const result = await fn({ repos: txRepos, log: (entry) => actionLog.write(entry, tx) });
          await txRepos.inboundEvents.markStep(event.id, name, result ?? null);
          return result;
        });
        done.set(name, out ?? null);
        return out;
      },
      async once<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (done.has(name)) return done.get(name) as T;
        const out = await fn();
        await repos.inboundEvents.markStep(event.id, name, out ?? null);
        done.set(name, out ?? null);
        return out;
      },
    };
  }
  type Steps = ReturnType<typeof stepsFor>;

  function pairingRejection(agent: AgentRow, code: string): string | null {
    if (!agent.pairing_code_hash || !agent.pairing_expires_at) return 'no_code';
    if (agent.pairing_expires_at.getTime() <= clock.now().getTime()) return 'expired';
    if (!pairingCodeMatches(code, agent.pairing_code_hash)) return 'wrong_code';
    return null;
  }

  /** Flow 8.1 step 3. Binds the owner inside the routing transaction; returns true if bound. */
  async function tryPairing(s: StepCtx, agent: AgentRow, msg: InboundMessage, eventId: string): Promise<boolean> {
    if (agent.owner_address !== null || msg.kind !== 'text') return false;
    const code = parseStartCommand(msg.text);
    if (code === null) return false;
    const reason = pairingRejection(agent, code);
    if (reason) {
      await s.log({ agentId: agent.id, actor: 'stranger', action: 'pairing.failed', detail: { reason, eventId } });
      return false;
    }
    if (!(await s.repos.agents.bindOwner(agent.id, msg.fromAddress))) {
      await s.log({ agentId: agent.id, actor: 'stranger', action: 'pairing.failed', detail: { reason: 'already_paired', eventId } });
      return false;
    }
    await s.repos.contacts.upsert({ agentId: agent.id, transport: msg.transport, address: msg.fromAddress, kind: 'owner' });
    const stored = await s.repos.messages.add({
      agentId: agent.id,
      thread: 'owner',
      direction: 'in',
      body: '/start',
      transportMessageId: msg.transportMessageId,
    });
    await s.log({ agentId: agent.id, actor: 'owner', action: 'pairing.bound', detail: { eventId, messageId: stored.id } });
    return true;
  }

  async function handlePauseCommand(steps: Steps, agent: AgentRow, command: 'pause' | 'resume'): Promise<void> {
    const wantPaused = command === 'pause';
    // Normally app.ingest already flipped the state and recorded this step, so this
    // returns that result and flips nothing. It only runs here if the sender became
    // the owner after ingest (paired by an earlier job of the lane).
    // The decision is recorded, so a retry after a failed ack resends the same ack.
    const { changed } = await steps.atomic(PAUSE_STATE_STEP, (s) => applyPauseCommand(s, agent.id, command));
    const text = changed
      ? wantPaused
        ? OWNER_TEXT.paused
        : OWNER_TEXT.resumed
      : wantPaused
        ? OWNER_TEXT.alreadyPaused
        : OWNER_TEXT.notPaused;
    await steps.once('pause.ack', async () => {
      await control.sendPauseAck(agent.id, text);
      return true;
    });
    if (!changed) return;
    await steps.once('pause.hooks', async () => {
      for (const hook of wantPaused ? hooks.onPause : hooks.onResume) await hook(agent.id);
      return true;
    });
  }

  async function handleOwner(steps: Steps, agent: AgentRow, msg: InboundMessage, eventId: string, held: boolean): Promise<void> {
    const { messageId } = await steps.atomic('stored', async (s) => {
      const stored = await s.repos.messages.add({
        agentId: agent.id,
        thread: 'owner',
        direction: 'in',
        body: msg.text,
        transportMessageId: msg.transportMessageId,
        replyToTransportMessageId: msg.replyToTransportMessageId ?? null,
        meta: { kind: msg.kind, ...(msg.buttonPayload ? { buttonPayload: msg.buttonPayload } : {}) },
      });
      await s.log({ agentId: agent.id, actor: 'owner', action: 'inbound.received', detail: { from: 'owner', eventId, messageId: stored.id, kind: msg.kind } });
      return { messageId: stored.id };
    });

    const command = pauseCommandOf(msg);
    if (command) {
      await handlePauseCommand(steps, agent, command);
      return;
    }
    if (held) {
      await steps.atomic('held', async (s) => {
        await s.log({ agentId: agent.id, actor: 'system', action: 'inbound.held', detail: { reason: 'paused', messageId } });
        return true;
      });
      return;
    }
    if (msg.kind === 'unsupported') {
      await steps.once('reply', async () => {
        await gateway.sendToOwner(agent.id, OWNER_TEXT.textOnly, { purpose: 'reply' });
        return true;
      });
      return;
    }
    const owner = await repos.owners.get(agent.owner_id);
    if (!owner) throw new Error(`agent ${agent.id} has no owner row`);
    const ctx: OwnerMessageCtx = { agent, owner, msg, messageId };
    await steps.once('owner.handled', async () => {
      for (const intercept of hooks.ownerInterceptors) {
        if (await intercept(ctx)) return true;
      }
      await hooks.onOwnerMessage(ctx);
      return true;
    });
  }

  async function handleStranger(steps: Steps, agent: AgentRow, msg: InboundMessage, eventId: string, held: boolean): Promise<void> {
    const { messageId, contactId } = await steps.atomic('stored', async (s) => {
      const contact = await s.repos.contacts.upsert({
        agentId: agent.id,
        transport: msg.transport,
        address: msg.fromAddress,
        displayName: msg.fromName ? sanitize(msg.fromName, 80) : null,
        kind: 'stranger',
      });
      const stored = await s.repos.messages.add({
        agentId: agent.id,
        thread: 'contact',
        contactId: contact.id,
        direction: 'in',
        body: msg.text,
        transportMessageId: msg.transportMessageId,
        meta: { kind: msg.kind },
      });
      await s.log({
        agentId: agent.id,
        actor: 'stranger',
        action: 'inbound.received',
        detail: { from: 'stranger', eventId, messageId: stored.id, contactId: contact.id, kind: msg.kind },
      });
      return { messageId: stored.id, contactId: contact.id };
    });
    const contact = await repos.contacts.get(contactId);
    if (!contact) throw new Error(`contact ${contactId} vanished`);

    if (held) {
      await steps.atomic('held', async (s) => {
        await s.log({ agentId: agent.id, actor: 'system', action: 'inbound.held', detail: { reason: 'paused', messageId } });
        return true;
      });
      return;
    }

    // The owner learns of the message first (flow 8.1 step 5): a canned reply that can
    // never be delivered (the stranger blocked the bot) must not keep this flag back.
    await steps.once('flag', async () => {
      // I13: the display name is stranger-authored too, so it is quoted like the text.
      const who = quote(contact.display_name ?? contact.address, 80);
      const what = msg.kind === 'unsupported' ? '(a non-text message)' : quote(msg.text, 200);
      await flags.raise(agent.id, {
        kind: 'message_taken',
        urgency: 'digest',
        text: `Message from ${who}: ${what}`,
        dedupeKey: `message:${messageId}`,
      });
      return true;
    });
    // Best-effort: one attempt. The gateway logs every attempt (outbound.failed before
    // or during the send, outbound.sent once delivered, even if recording it then
    // fails); a failure never fails the job, retries, or holds the lane.
    await steps.once('canned', async () => {
      const last = contact.last_canned_reply_at;
      if (!last || clock.now().getTime() - last.getTime() >= CANNED_REPLY_INTERVAL_MS) {
        try {
          await gateway.sendCanned(agent.id, contact.id, 'stranger_reply');
        } catch {
          return 'failed';
        }
        return 'sent';
      }
      await actionLog.write({
        agentId: agent.id,
        actor: 'system',
        action: 'canned.rate_limited',
        detail: { contactId: contact.id, messageId },
      });
      return 'rate_limited';
    });
  }

  async function route(event: InboundEventRow, agent: AgentRow, msg: InboundMessage): Promise<void> {
    const steps = stepsFor(event);
    // I14: held if the agent is paused now, or was paused when the message arrived
    // (a resume ingested before this job ran does not release it).
    const held = agent.paused || event.progress?.[PAUSED_AT_ARRIVAL_STEP] === true;
    const decision = await steps.atomic('route', async (s): Promise<'paired' | 'owner' | 'stranger'> => {
      if (await tryPairing(s, agent, msg, event.id)) return 'paired';
      return isOwner(agent, msg) ? 'owner' : 'stranger';
    });
    if (decision === 'paired') {
      await steps.once('pairing.ack', async () => {
        await gateway.sendToOwner(agent.id, OWNER_TEXT.paired, { purpose: 'ack' });
        return true;
      });
    } else if (decision === 'owner') {
      await handleOwner(steps, agent, msg, event.id, held);
    } else {
      await handleStranger(steps, agent, msg, event.id, held);
    }
  }

  return {
    hooks,
    async process(inboundEventId) {
      const event = await repos.inboundEvents.get(inboundEventId);
      if (!event || event.processed_at) return;
      const msg = inboundFromPayload(event.payload);
      const agent = await repos.agents.findByAddress(msg.transport, msg.agentAddress);
      if (agent) {
        await route(event, agent, msg);
      } else {
        await actionLog.write({
          actor: 'system',
          action: 'inbound.dropped',
          detail: { reason: 'unknown_agent', eventId: event.id, transport: msg.transport, agentAddress: sanitize(msg.agentAddress, 100) },
        });
      }
      await repos.inboundEvents.markProcessed(event.id);
    },
  };
}

export interface StepCtx {
  /** Repos bound to the step's transaction. */
  repos: Repos;
  log(entry: ActionEntry): Promise<void>;
}
