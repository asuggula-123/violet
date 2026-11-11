import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { JobQueue } from '../core/jobs.js';
import { sanitize } from '../core/sanitize.js';
import { isoInZone, isoInstant } from '../brain/time.js';
import type { Db, Queryable } from '../db/db.js';
import type { CalendarProvider } from '../google/types.js';
import type { ToolDef } from '../llm/tools.js';
import { closeInTx } from './conversations.js';
import { Refusal } from './deps.js';
import { SLOT_GONE_SYSTEM, slotsFree } from './outcome.js';
import { outcomePromptFits, questionLine } from './render.js';
import { a2aRepo, OUTCOME_JOB, peerOf, queueNotice, writeMessage } from './repo.js';
import { A2A_LIMITS, DAY_MS, type ConversationRow, type Parties, type ProposalEvent, type ProposalPayload, type SideRow } from './types.js';

/**
 * What the Envoy's tools can touch: the a2a tables, the job queue, the action log and
 * free/busy (busy intervals, nothing else). No event details, email, notes, contacts or
 * owner thread: there is nothing to spill (principle 2).
 */
export interface EnvoyDeps {
  db: Db;
  clock: Clock;
  jobs: JobQueue;
  actionLog: ActionLog;
  calendar: Pick<CalendarProvider, 'freeBusy'>;
}

export interface EnvoyCtx {
  conv: ConversationRow;
  side: SideRow;
  parties: Parties;
  now: Date;
  turnKey: string;
  /** The outward act this turn made (at most one), or null. */
  acted: string | null;
  /** The agent was paused mid-turn: no act is written, the turn waits for resume. */
  paused: boolean;
}

export type EnvoyTool<I = any> = ToolDef<EnvoyCtx, I>;

/** I10: the part of the window this side may read: all of it for the owner who set it (≤ 31 days), the first 7 days for the peer. */
export function effectiveWindow(conv: ConversationRow, side: SideRow): { start: Date; end: Date } | null {
  if (!conv.window_start || !conv.window_end) return null;
  const limit = side.role === 'initiator' ? A2A_LIMITS.ownWindowDays : A2A_LIMITS.peerWindowDays;
  const end = Math.min(conv.window_end.getTime(), conv.window_start.getTime() + limit * DAY_MS);
  return { start: conv.window_start, end: new Date(end) };
}

const MIN_EVENT_MS = 5 * 60_000;
const MAX_EVENT_MS = DAY_MS;

const eventInput = z.object({
  title: z.string().min(1).max(120),
  start: isoInstant,
  end: isoInstant,
  location: z.string().max(200).optional(),
  calendars: z.enum(['both', 'mine', 'theirs']).describe("Whose calendars: both owners', only your owner's, or only the other owner's"),
});
const proposeInput = z.object({
  summary: z.string().min(1).max(500).describe('What both sides agree to, in one or two sentences'),
  events: z.array(eventInput).max(A2A_LIMITS.maxEvents).describe('0 to 5 events to book; none = an agreement with nothing to book'),
});
type ProposeInput = z.infer<typeof proposeInput>;

const text = (s: string, max: number) => sanitize(s.replace(/\u0000/g, ''), max);

/** Code validation of proposed events (I7): start < end, sane length, in the future, inside the window when there is one. */
export function checkEvents(events: Array<{ start: string; end: string }>, conv: ConversationRow, now: Date): void {
  for (const [i, e] of events.entries()) {
    const s = Date.parse(e.start);
    const t = Date.parse(e.end);
    const at = `events.${i}: `;
    if (t - s < MIN_EVENT_MS) throw new Refusal('invalid_event', `${at}end must be at least 5 minutes after start.`);
    if (t - s > MAX_EVENT_MS) throw new Refusal('invalid_event', `${at}an event can last at most 24 hours.`);
    if (s <= now.getTime()) throw new Refusal('invalid_event', `${at}that start is not in the future.`);
    if (conv.window_start && conv.window_end && (s < conv.window_start.getTime() || t > conv.window_end.getTime())) {
      throw new Refusal('outside_window', `${at}events must be inside the conversation's window.`);
    }
  }
}

/** I5/I13: each owner's outcome prompt must show every event a yes would book (else refused). */
function checkPromptFits(p: ProposalPayload, parties: Parties): void {
  for (const [me, peer] of [
    [parties.me, parties.peer],
    [parties.peer, parties.me],
  ] as const) {
    const shownEvents = p.events.map((e) => ({ title: e.title, start: e.start, end: e.end, ...(e.location ? { location: e.location } : {}) }));
    if (!outcomePromptFits({ peer: peer.first, summary: p.summary, events: shownEvents }, me.owner.timezone)) {
      throw new Refusal(
        'prompt_too_long',
        p.events.length === 0
          ? 'Each owner must see the whole agreement in one short line: shorten the summary (about 180 characters at most).'
          : 'Each owner must see every event in one short line: propose fewer events or shorter titles.',
      );
    }
  }
}

export function envoyTools(d: EnvoyDeps): EnvoyTool[] {
  /** Runs one outward act in a transaction that holds the conversation lock (I12 checks included). */
  async function inTurn<T>(ctx: EnvoyCtx, fn: (tx: Queryable, conv: ConversationRow, side: SideRow) => Promise<T>): Promise<T | 'limit'> {
    return d.db.tx(async (tx) => {
      // I14: a pause flips the agent row under FOR UPDATE; this share lock orders the act against it.
      const agent = await tx.query<{ paused: boolean }>('SELECT paused FROM agents WHERE id = $1 FOR SHARE', [ctx.parties.me.agent.id]);
      if (agent.rows[0]?.paused !== false) {
        ctx.paused = true;
        throw new Refusal('paused', 'Your owner paused you. Stop now.');
      }
      const repo = a2aRepo(tx);
      const conv = (await repo.lock(ctx.conv.id))!;
      if (conv.status !== 'open') throw new Refusal('not_open', 'This conversation is not open for messages now. Stop.');
      const side = (await repo.side(conv.id, ctx.parties.me.agent.id))!;
      if (side.messages_sent >= A2A_LIMITS.messagesPerSide) {
        await closeInTx(tx, d, conv, { by: null, reason: 'limit', body: 'The message limit was reached, so the conversation closed.', turnKey: ctx.turnKey });
        return 'limit' as const;
      }
      return fn(tx, conv, side);
    });
  }

  async function send<T>(ctx: EnvoyCtx, fn: (tx: Queryable, conv: ConversationRow, side: SideRow) => Promise<T>): Promise<T> {
    const out = await inTurn(ctx, fn);
    if (out !== 'limit') return out;
    ctx.acted = 'limit';
    throw new Refusal('messages_per_side', 'The message limit for this conversation is reached: it is now closed. Stop.', true);
  }

  const bumpSent = (tx: Queryable, conv: ConversationRow, side: SideRow) =>
    tx.query('UPDATE a2a_sides SET messages_sent = messages_sent + 1, stalled = false WHERE conversation_id = $1 AND agent_id = $2', [conv.id, side.agent_id]);

  function liveProposal(conv: ConversationRow, seq: number) {
    if (conv.live_proposal_seq === null || conv.live_proposal_seq !== seq) throw new Refusal('stale_proposal', `There is no live proposal with proposal_seq ${seq}.`);
  }

  /**
   * I7 + I10: the accept-time free/busy re-check. Its result reaches both Envoys (a slot that
   * is gone reopens the conversation), so it is held to what availability may reveal: for
   * each side, only the events on that side's calendar that lie inside that side's effective
   * window, and only while that side has availability budget left (it costs one call). Events
   * not checked here are checked anyway by the booking guard right before anything is written
   * — after both owners said yes — so nothing is ever double-booked; the Envoys just cannot use
   * accept as a free/busy oracle outside the window or the budget.
   */
  async function acceptTimeFree(ctx: EnvoyCtx, p: ProposalPayload): Promise<boolean> {
    let free = true;
    for (const party of [ctx.parties.me, ctx.parties.peer]) {
      const side = await a2aRepo(d.db).side(ctx.conv.id, party.agent.id);
      const window = side ? effectiveWindow(ctx.conv, side) : null;
      if (!window) continue;
      const inside = p.events.filter(
        (e) => e.agents.includes(party.agent.id) && Date.parse(e.start) >= window.start.getTime() && Date.parse(e.end) <= window.end.getTime(),
      );
      if (inside.length === 0) continue;
      const counted = await d.db.query(
        `UPDATE a2a_sides SET availability_calls = availability_calls + 1 WHERE conversation_id = $1 AND agent_id = $2 AND availability_calls < $3`,
        [ctx.conv.id, party.agent.id, A2A_LIMITS.availabilityPerSide],
      );
      if (counted.rowCount !== 1) continue; // no budget left: the booking guard checks it
      if (!(await slotsFree(d, party.owner.id, inside))) free = false;
    }
    return free;
  }

  const checkAvailability: EnvoyTool<{ start: string; end: string }> = {
    name: 'check_availability',
    description: "Your owner's busy times (start and end only) between two instants, clipped to the conversation's window. Limited number of calls.",
    input: z.object({ start: isoInstant, end: isoInstant }),
    async handler(input, ctx) {
      // I14: a pause that lands mid-turn stops free/busy reads too, not only outward acts.
      const agent = await d.db.query<{ paused: boolean }>('SELECT paused FROM agents WHERE id = $1', [ctx.parties.me.agent.id]);
      if (agent.rows[0]?.paused !== false) {
        ctx.paused = true;
        throw new Refusal('paused', 'Your owner paused you. Stop now.');
      }
      const window = effectiveWindow(ctx.conv, ctx.side);
      if (!window) throw new Refusal('no_window', 'This conversation has no time window, so availability is not shared.', true);
      const from = Math.max(Date.parse(input.start), window.start.getTime(), ctx.now.getTime());
      const to = Math.min(Date.parse(input.end), window.end.getTime());
      if (from >= to) throw new Refusal('outside_window', `Ask inside the window: ${window.start.toISOString()} to ${window.end.toISOString()} (and not in the past).`, true);
      const counted = await d.db.query(
        `UPDATE a2a_sides SET availability_calls = availability_calls + 1 WHERE conversation_id = $1 AND agent_id = $2 AND availability_calls < $3`,
        [ctx.conv.id, ctx.side.agent_id, A2A_LIMITS.availabilityPerSide],
      );
      if (counted.rowCount !== 1) throw new Refusal('availability_budget', 'No availability checks left for this conversation.', true);
      const a = new Date(from);
      const b = new Date(to);
      const busy = (await d.calendar.freeBusy(ctx.parties.me.owner.id, a, b))
        .map((x) => ({ start: Math.max(x.start.getTime(), from), end: Math.min(x.end.getTime(), to) }))
        .filter((x) => x.end > x.start);
      await d.actionLog.write({
        agentId: ctx.side.agent_id,
        actor: 'envoy',
        action: 'a2a.availability',
        detail: { conversationId: ctx.conv.id, from: a.toISOString(), to: b.toISOString(), intervals: busy.length },
      });
      const tz = ctx.parties.me.owner.timezone;
      const rows = busy.map((x) => `- ${isoInZone(new Date(x.start), tz)} → ${isoInZone(new Date(x.end), tz)}`);
      return `${ctx.parties.me.first}'s busy times from ${isoInZone(a, tz)} to ${isoInZone(b, tz)}:\n${rows.length ? rows.join('\n') : '- none (free the whole time)'}`;
    },
  };

  /** The six outward acts: the first that succeeds ends the turn; any later one is refused. */
  function outward<I>(def: { name: string; description: string; input: z.ZodType<I>; act(input: I, ctx: EnvoyCtx): Promise<string> }): EnvoyTool<I> {
    return {
      name: def.name,
      description: def.description,
      input: def.input,
      sideEffect: true,
      async handler(input, ctx) {
        if (ctx.acted) throw new Refusal('second_act', 'You already made your one outward act this turn. Your turn is over: stop now.');
        const out = await def.act(input, ctx);
        ctx.acted = def.name;
        return `${out} Your turn is over: stop now, without calling more tools.`;
      },
    };
  }

  const say = outward({
    name: 'say',
    description: 'Send a message to the other agent (at most 1000 characters).',
    input: z.object({ text: z.string().min(1).max(1000) }),
    act: async (input, ctx) =>
      send(ctx, async (tx, conv, side) => {
        await writeMessage(tx, d, { conv, from: side.agent_id, kind: 'text', body: text(input.text, 1000), turnKey: ctx.turnKey, deliverTo: [peerOf(conv, side.agent_id)] });
        await bumpSent(tx, conv, side);
        return 'Sent.';
      }),
  });

  const propose = outward<ProposeInput>({
    name: 'propose',
    description: 'Propose an outcome: a summary and 0 to 5 events. Zero events = an agreement with nothing to book. Both owners must still approve.',
    input: proposeInput,
    act: async (input, ctx) => {
      checkEvents(input.events, ctx.conv, ctx.now);
      const me = ctx.parties.me.agent.id;
      const peer = ctx.parties.peer.agent.id;
      const events: ProposalEvent[] = input.events.map((e) => ({
        title: text(e.title, 120),
        start: e.start,
        end: e.end,
        ...(e.location && text(e.location, 200) ? { location: text(e.location, 200) } : {}),
        calendars: e.calendars,
        agents: e.calendars === 'both' ? [me, peer] : e.calendars === 'mine' ? [me] : [peer],
      }));
      const payload: ProposalPayload = { summary: text(input.summary, 500), events };
      checkPromptFits(payload, ctx.parties);
      return send(ctx, async (tx, conv, side) => {
        const m = await writeMessage(tx, d, { conv, from: me, kind: 'proposal', body: payload.summary, payload: { ...payload }, turnKey: ctx.turnKey, deliverTo: [peer] });
        await tx.query('UPDATE a2a_conversations SET live_proposal_seq = $2 WHERE id = $1', [conv.id, m.seq]);
        await bumpSent(tx, conv, side);
        return `Proposed (proposal_seq ${m.seq}).`;
      });
    },
  });

  const accept = outward<{ proposal_seq: number }>({
    name: 'accept',
    description: "Accept the other agent's latest proposal. This only asks both owners: nothing is booked unless both say yes.",
    input: z.object({ proposal_seq: z.number().int().min(1) }),
    act: async (input, ctx) => {
      const repo = a2aRepo(d.db);
      const proposal = await repo.message(ctx.conv.id, input.proposal_seq);
      if (!proposal || proposal.kind !== 'proposal') throw new Refusal('stale_proposal', `There is no proposal with proposal_seq ${input.proposal_seq}.`);
      if (proposal.from_agent_id === ctx.parties.me.agent.id) throw new Refusal('own_proposal', 'You cannot accept your own proposal.');
      liveProposal(ctx.conv, input.proposal_seq);
      const p = proposal.payload as unknown as ProposalPayload;
      checkEvents(p.events, ctx.conv, ctx.now);
      checkPromptFits(p, ctx.parties);
      const free = await acceptTimeFree(ctx, p);
      return send(ctx, async (tx, conv, side) => {
        if (proposal.from_agent_id !== peerOf(conv, side.agent_id)) throw new Refusal('own_proposal', 'You cannot accept your own proposal.');
        liveProposal(conv, input.proposal_seq);
        if (!free) {
          await tx.query('UPDATE a2a_conversations SET live_proposal_seq = NULL WHERE id = $1', [conv.id]);
          await writeMessage(tx, d, { conv, from: null, kind: 'system', body: SLOT_GONE_SYSTEM, turnKey: ctx.turnKey, deliverTo: [conv.initiator_agent_id, conv.responder_agent_id] });
          return 'That time is no longer free: nothing was accepted.';
        }
        const groupId = randomUUID();
        await writeMessage(tx, d, { conv, from: side.agent_id, kind: 'accept', body: '', payload: { proposal_seq: input.proposal_seq }, turnKey: ctx.turnKey });
        await tx.query(
          `UPDATE a2a_conversations SET status = 'awaiting_approval', accepted_proposal_seq = $2, outcome_group_id = $3, outcome_state = NULL WHERE id = $1`,
          [conv.id, input.proposal_seq, groupId],
        );
        await bumpSent(tx, conv, side);
        for (const agentId of [conv.initiator_agent_id, conv.responder_agent_id]) {
          await d.jobs.enqueue(OUTCOME_JOB, { conversationId: conv.id, agentId, groupId }, { lane: agentId, dedupeKey: `a2a:outcome:${groupId}:${agentId}`, tx });
        }
        return 'Accepted: both owners are now asked to approve. Nothing is booked unless both say yes.';
      });
    },
  });

  const decline = outward<{ proposal_seq: number; reason?: string | undefined }>({
    name: 'decline',
    description: "Decline the other agent's latest proposal, optionally with a short reason.",
    input: z.object({ proposal_seq: z.number().int().min(1), reason: z.string().max(300).optional() }),
    act: async (input, ctx) =>
      send(ctx, async (tx, conv, side) => {
        liveProposal(conv, input.proposal_seq);
        const proposal = await a2aRepo(tx).message(conv.id, input.proposal_seq);
        if (proposal?.from_agent_id === side.agent_id) throw new Refusal('own_proposal', 'You cannot decline your own proposal.');
        await tx.query('UPDATE a2a_conversations SET live_proposal_seq = NULL WHERE id = $1', [conv.id]);
        const body = input.reason ? text(input.reason, 300) : '';
        await writeMessage(tx, d, { conv, from: side.agent_id, kind: 'decline', body, payload: { proposal_seq: input.proposal_seq }, turnKey: ctx.turnKey, deliverTo: [peerOf(conv, side.agent_id)] });
        await bumpSent(tx, conv, side);
        return 'Declined.';
      }),
  });

  const askOwner = outward<{ question: string }>({
    name: 'ask_owner',
    description: 'Ask your owner a question you cannot answer yourself. They get it at once; their answer comes back as guidance.',
    input: z.object({ question: z.string().min(1).max(500) }),
    act: async (input, ctx) =>
      send(ctx, async (tx, conv, side) => {
        if (side.owner_questions >= A2A_LIMITS.questionsPerSide) throw new Refusal('questions_per_side', 'No questions to your owner left in this conversation.', true);
        const body = text(input.question, 500);
        const m = await writeMessage(tx, d, { conv, from: side.agent_id, privateTo: side.agent_id, kind: 'question', body, turnKey: ctx.turnKey });
        await tx.query('UPDATE a2a_sides SET owner_questions = owner_questions + 1, awaiting_owner = true WHERE conversation_id = $1 AND agent_id = $2', [conv.id, side.agent_id]);
        // D4: one code-rendered line at once (purpose 'question', never budgeted).
        await queueNotice(tx, d, { id: `question:${m.id}`, agentId: side.agent_id, purpose: 'question', text: questionLine(ctx.parties, conv.topic, body), tainted: true });
        return `Asked ${ctx.parties.me.first}. Their answer will come as guidance.`;
      }),
  });

  const endConversation = outward<{ reason?: string | undefined }>({
    name: 'end_conversation',
    description: 'End the conversation (nothing more to sort out, or it is going nowhere).',
    input: z.object({ reason: z.string().max(300).optional() }),
    act: async (input, ctx) =>
      send(ctx, async (tx, conv, side) => {
        await closeInTx(tx, d, conv, { by: side.agent_id, reason: 'ended', body: input.reason ? text(input.reason, 300) : '', turnKey: ctx.turnKey });
        return 'Ended.';
      }),
  });

  return [checkAvailability, say, propose, accept, decline, askOwner, endConversation];
}
