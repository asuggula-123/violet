import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addMs } from '../clock.js';
import { isoInstant } from '../brain/time.js';
import type { ApprovalKind, ApprovalRow } from '../approvals/types.js';
import { sanitize } from '../core/sanitize.js';
import { NOT_CONFIGURED_REASON } from '../google/unconfigured.js';
import { closeInTx, AFTER_JOB } from './conversations.js';
import type { A2ADeps } from './deps.js';
import { bookedLine, bookingFailedLine, noAnswerLine, outcomePrompt, outcomePromptFits, saidNoLine, undoPendingLine } from './render.js';
import { a2aRepo, firstName, queueNotice, writeMessage } from './repo.js';
import type { ConversationRow, ProposalPayload } from './types.js';

export const OUTCOME_KIND = 'a2a_outcome';
export const SLOT_GONE = 'that time is no longer free';
export const SLOT_GONE_SYSTEM = 'That time is no longer free, so nothing was booked.';
const NOT_ACCEPTED = "a calendar didn't accept it";

/**
 * The reason both owners are told for a failed booking. Only reasons true for both of them are
 * named: the slot is gone, or Google is not configured on this server (production without
 * Google: nothing is ever written); anything else about one owner's calendar stays generic.
 */
export function failureWhy(reasons: Array<string | null | undefined>): string {
  if (reasons.includes(SLOT_GONE)) return SLOT_GONE;
  if (reasons.includes(NOT_CONFIGURED_REASON)) return NOT_CONFIGURED_REASON;
  return NOT_ACCEPTED;
}
const CLAIM_MS = 120_000;

export const outcomePayload = z.object({
  conversationId: z.string().min(1).max(100),
  proposalSeq: z.number().int().min(1),
  groupId: z.string().min(1).max(100),
  /** The other owner's first name. */
  peer: z.string().min(1).max(60),
  summary: z.string().max(500),
  events: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        start: isoInstant,
        end: isoInstant,
        location: z.string().max(200).optional(),
        /** Booked on this owner's calendar. */
        mine: z.boolean(),
      }),
    )
    .max(5),
});
export type OutcomePayload = z.infer<typeof outcomePayload>;

class OutcomeRefused extends Error {
  constructor(readonly ownerMessage: string) {
    super(ownerMessage);
  }
}

const BOOKABLE = ['approved', 'executed', 'failed'];

/**
 * `a2a_outcome` (I5–I7): one approval per owner per accepted proposal, same group id. Booking
 * happens only once BOTH are approved, by whichever owner's yes came second: one atomic
 * claim on the conversation (both approvals bookable, outcome not yet claimed) picks the
 * booker; the guard re-checks the sibling, the accepted proposal and a fresh free/busy right
 * before CalendarWriter writes. A failure on the second calendar undoes the first.
 */
export function createOutcomes(d: A2ADeps) {
  const repo = a2aRepo(d.db);

  async function sibling(a: Pick<ApprovalRow, 'group_id' | 'agent_id'>): Promise<ApprovalRow | null> {
    const res = await d.db.query<{ id: string }>(`SELECT id FROM approvals WHERE group_id = $1 AND kind = $2 AND agent_id <> $3`, [a.group_id, OUTCOME_KIND, a.agent_id]);
    return res.rows[0] ? d.approvals.get(res.rows[0].id) : null;
  }

  async function ownerOf(agentId: string) {
    const agent = await d.repos.agents.get(agentId);
    const owner = agent ? await d.repos.owners.get(agent.owner_id) : null;
    if (!agent || !owner) throw new Error(`a2a: no owner for agent ${agentId}`);
    return { agent, owner };
  }

  /** Job on each owner's lane after an accept: that owner's prompt, rendered from the stored proposal. */
  async function request(job: { conversationId: string; agentId: string; groupId: string }): Promise<void> {
    const conv = await repo.conversation(job.conversationId);
    if (!conv || conv.outcome_group_id !== job.groupId || conv.status !== 'awaiting_approval' || conv.accepted_proposal_seq === null) return;
    const proposal = (await repo.message(conv.id, conv.accepted_proposal_seq))!.payload as unknown as ProposalPayload;
    const parties = await repo.parties(conv, job.agentId);
    const payload: OutcomePayload = {
      conversationId: conv.id,
      proposalSeq: conv.accepted_proposal_seq,
      groupId: job.groupId,
      peer: parties.peer.first,
      summary: proposal.summary,
      events: proposal.events.map((e) => ({
        title: e.title,
        start: e.start,
        end: e.end,
        ...(e.location ? { location: e.location } : {}),
        mine: e.agents.includes(job.agentId),
      })),
    };
    // I5/I13, fail closed: propose and accept refuse what cannot be shown whole, so this only
    // trips if something changed since (e.g. the owner's time zone). Nobody is asked then.
    if (!outcomePromptFits(payload, (await ownerOf(job.agentId)).owner.timezone)) {
      await d.db.tx(async (tx) => {
        const locked = await a2aRepo(tx).lock(conv.id);
        if (!locked || locked.outcome_group_id !== job.groupId || locked.status !== 'awaiting_approval') return;
        await reopen(tx, locked, 'The proposal is too long to show the owners whole, so nobody was asked. Propose fewer events or shorter titles.', [locked.initiator_agent_id, locked.responder_agent_id]);
        await d.actionLog.write({ agentId: job.agentId, actor: 'system', action: 'a2a.limit', detail: { conversationId: conv.id, limit: 'prompt_too_long' } }, tx);
      });
      const pending = await d.db.query<{ id: string }>(`SELECT id FROM approvals WHERE group_id = $1 AND status = 'pending' ORDER BY seq`, [job.groupId]);
      for (const a of pending.rows) await d.approvals.cancel(a.id, 'the proposal could not be shown whole');
      return;
    }
    const approval = await d.approvals.request(job.agentId, { kind: OUTCOME_KIND, payload, groupId: job.groupId, idempotencyKey: `a2a-outcome:${job.groupId}` });
    await d.actionLog.write({ agentId: job.agentId, actor: 'system', action: 'a2a.outcome_requested', detail: { conversationId: conv.id, approvalId: approval.id, groupId: job.groupId } });
    // Raced with a "no" on the other side that already moved the conversation on.
    if ((await repo.conversation(conv.id))?.outcome_group_id !== job.groupId) await d.approvals.cancel(approval.id, 'the other owner said no');
  }

  async function guard(approval: ApprovalRow): Promise<void> {
    const p = outcomePayload.parse(approval.payload);
    const conv = await repo.conversation(p.conversationId);
    if (!conv || conv.outcome_group_id !== approval.group_id || conv.accepted_proposal_seq !== p.proposalSeq || conv.outcome_state !== 'booking') {
      throw new OutcomeRefused('the proposal is no longer the accepted one');
    }
    // Ended by an owner while booking: nothing more is written; what was written is undone.
    if (conv.status === 'closed') throw new OutcomeRefused('the conversation was ended');
    const other = await sibling(approval);
    if (!other || !['approved', 'executed'].includes(other.status)) throw new OutcomeRefused('the other owner has not approved it');
    const mine = p.events.filter((e) => e.mine);
    const written = await d.db.query('SELECT 1 FROM calendar_writes WHERE approval_id = $1', [approval.id]);
    if (mine.length === 0 || written.rows.length > 0) return; // a retry after a partial write: our own event is the "busy"
    const { agent } = await ownerOf(approval.agent_id);
    if (!(await slotsFree(d, agent.owner_id, mine))) throw new OutcomeRefused(SLOT_GONE);
  }

  /** "no" or expiry: the other prompt is cancelled, its owner told once, the conversation reopens for the owner who said no. */
  async function rejected(approval: ApprovalRow, how: 'no' | 'expired'): Promise<void> {
    const p = outcomePayload.parse(approval.payload);
    const other = await sibling(approval);
    const { owner } = await ownerOf(approval.agent_id);
    const otherOwner = other ? (await ownerOf(other.agent_id)).owner : null;
    await d.db.tx(async (tx) => {
      const conv = await a2aRepo(tx).lock(p.conversationId);
      if (!conv || conv.outcome_group_id !== approval.group_id || conv.status !== 'awaiting_approval') return;
      await reopen(tx, conv, how === 'no' ? 'The proposal was not approved, so nothing was booked.' : 'No answer in time, so nothing was booked.', []);
      await tx.query('UPDATE a2a_sides SET awaiting_owner = true WHERE conversation_id = $1 AND agent_id = $2', [conv.id, approval.agent_id]);
      if (other && otherOwner) {
        const who = firstName(owner.name);
        const text = how === 'no' ? saidNoLine(who, p, otherOwner.timezone) : noAnswerLine(who, p, otherOwner.timezone);
        await queueNotice(tx, d, { id: `outcome-${how}:${approval.id}`, agentId: other.agent_id, purpose: 'reply', text, tainted: true });
      }
    });
    if (other?.status === 'pending') await d.approvals.cancel(other.id, how === 'no' ? 'the other owner said no' : 'the other owner did not answer');
  }

  /** Back to open: no live or accepted proposal, a system message (delivered to `deliverTo`). */
  async function reopen(tx: Parameters<Parameters<typeof d.db.tx>[0]>[0], conv: ConversationRow, body: string, deliverTo: string[]): Promise<void> {
    await tx.query(
      `UPDATE a2a_conversations SET status = 'open', live_proposal_seq = NULL, accepted_proposal_seq = NULL, outcome_group_id = NULL,
         outcome_state = NULL, outcome_claimed_until = NULL, outcome_claimed_by = NULL WHERE id = $1`,
      [conv.id],
    );
    await writeMessage(tx, d, { conv, from: null, kind: 'system', body, deliverTo });
  }

  /**
   * The booking claim (one booker per group). `claimant` is the approval whose yes is booking
   * (a retry of that same hook takes the claim over at once), or a sweep run (only after the
   * lease ran out). Requires both approvals to be bookable.
   */
  async function claim(conversationId: string, groupId: string, claimant: string): Promise<boolean> {
    const now = d.clock.now();
    const res = await d.db.query(
      `UPDATE a2a_conversations SET outcome_state = 'booking', outcome_claimed_until = $3, outcome_claimed_by = $7
       WHERE id = $1 AND outcome_group_id = $2
         AND (status = 'awaiting_approval' OR (status = 'closed' AND outcome_state = 'booking'))
         AND (outcome_state IS NULL OR (outcome_state = 'booking' AND (outcome_claimed_until <= $4 OR outcome_claimed_by = $7)))
         AND (SELECT count(*) FROM approvals WHERE group_id = $2 AND kind = $5 AND status = ANY($6::text[])) = 2`,
      [conversationId, groupId, addMs(now, CLAIM_MS), now, OUTCOME_KIND, BOOKABLE, claimant],
    );
    return res.rowCount === 1;
  }

  /** The line for an owner whose yes did not claim the booking (also what a retried hook returns). */
  async function settledLine(approval: ApprovalRow, other: ApprovalRow, p: OutcomePayload, timezone: string): Promise<string | undefined> {
    const conv = await repo.conversation(p.conversationId);
    if (conv?.outcome_group_id === approval.group_id && conv.outcome_state === 'booked') return bookedLine(p, timezone);
    // Someone else holds the booking: its result reaches this owner as a notice.
    if (conv?.outcome_group_id === approval.group_id && (conv.status === 'awaiting_approval' || conv.outcome_state === 'booking')) {
      return "Booking it now. I'll tell you when it's done.";
    }
    const errors = [(await d.approvals.get(approval.id))?.error, (await d.approvals.get(other.id))?.error];
    return bookingFailedLine(p, timezone, failureWhy(errors));
  }

  /** Calendar event rows of these approvals that are still on a calendar (written, not undone). */
  async function liveWriters(approvalIds: string[]): Promise<Set<string>> {
    const res = await d.db.query<{ agent_id: string }>(
      `SELECT DISTINCT a.agent_id FROM calendar_writes w JOIN approvals a ON a.id = w.approval_id
       WHERE w.approval_id = ANY($1::text[]) AND w.deleted_at IS NULL`,
      [approvalIds],
    );
    return new Set(res.rows.map((r) => r.agent_id));
  }

  type Settle = { kind: 'booked' } | { kind: 'failed'; why: string } | { kind: 'undo_pending'; why: string; booked: Set<string> };

  /**
   * I7, resumable: every step is idempotent and derived from the approvals' own state
   * (executed / failed / approved) and calendar_writes, so a retry, or the sweep after a
   * crash, picks up exactly where the last attempt stopped. Never half-booked: if either side
   * failed, whatever is on either calendar is undone; an undo that fails leaves the group in
   * 'booking' for the sweep to finish.
   */
  async function runBooking(a: ApprovalRow, b: ApprovalRow): Promise<Settle> {
    const ra = await d.approvals.calendar.executeApproved(a.id);
    const rb = ra.ok ? await d.approvals.calendar.executeApproved(b.id) : null;
    if (ra.ok && rb?.ok) return { kind: 'booked' };
    const why = failureWhy([ra.ok ? null : ra.reason, rb && !rb.ok ? rb.reason : null]);
    for (const id of [a.id, b.id]) {
      try {
        await d.approvals.calendar.undo(id);
      } catch (err) {
        d.log.warn({ approvalId: id, err: err instanceof Error ? err.message : String(err) }, 'a2a: undo failed; the sweep retries it');
      }
    }
    const booked = await liveWriters([a.id, b.id]);
    return booked.size > 0 ? { kind: 'undo_pending', why, booked } : { kind: 'failed', why };
  }

  /**
   * Records the result (once: only while the group is still 'booking') and tells the owners.
   * `replyTo` is the approval whose owner gets the line as the hook's reply (null: the sweep,
   * which tells both owners by notice). Returns the line for `replyTo`'s owner.
   */
  async function settle(a: ApprovalRow, b: ApprovalRow, result: Settle, replyTo: string | null): Promise<string | undefined> {
    const people = await Promise.all(
      [a, b].map(async (x) => ({ approval: x, p: outcomePayload.parse(x.payload), ...(await ownerOf(x.agent_id)) })),
    );
    const lineFor = (who: (typeof people)[number]): string => {
      if (result.kind === 'booked') return bookedLine(who.p, who.owner.timezone);
      if (result.kind === 'failed') return bookingFailedLine(who.p, who.owner.timezone, result.why);
      const where = [...result.booked].map((id) => (id === who.approval.agent_id ? 'your' : `${sanitize(who.p.peer, 60)}'s`)).join(' and ');
      return undoPendingLine(who.p, who.owner.timezone, where);
    };
    let mine: string | undefined;
    await d.db.tx(async (tx) => {
      const conv = await a2aRepo(tx).lock(a.payload.conversationId as string);
      if (!conv || conv.outcome_group_id !== a.group_id || conv.outcome_state !== 'booking') return;
      for (const who of people) {
        const line = lineFor(who);
        if (who.approval.id === replyTo) {
          mine = line;
          continue;
        }
        const id = result.kind === 'undo_pending' ? `outcome-undo-pending:${who.approval.id}` : `outcome-result:${who.approval.id}`;
        await queueNotice(tx, d, { id, agentId: who.approval.agent_id, purpose: 'reply', text: line, tainted: true });
      }
      // Ended by an owner while the booking was being settled (I7): it is already closed, so
      // it is only settled here, never reopened.
      const ended = conv.status === 'closed';
      if (result.kind === 'booked') {
        await tx.query(`UPDATE a2a_conversations SET outcome_state = 'booked' WHERE id = $1`, [conv.id]);
        if (!ended) await closeInTx(tx, d, conv, { by: null, reason: 'booked', body: 'Both owners approved it, and it is booked.' });
        await d.jobs.enqueue(AFTER_JOB, { conversationId: conv.id, event: 'booked' }, { dedupeKey: `a2a:after:${conv.id}:booked`, tx });
      } else if (result.kind === 'failed' && ended) {
        await tx.query(`UPDATE a2a_conversations SET outcome_state = 'failed', outcome_claimed_until = NULL, outcome_claimed_by = NULL WHERE id = $1`, [conv.id]);
      } else if (result.kind === 'failed') {
        const slotGone = result.why === SLOT_GONE;
        await reopen(tx, conv, slotGone ? SLOT_GONE_SYSTEM : 'The booking failed, so nothing was booked.', slotGone ? [conv.initiator_agent_id, conv.responder_agent_id] : []);
      } else {
        // Still 'booking': the lease is released so the next sweep retries the undo.
        await tx.query('UPDATE a2a_conversations SET outcome_claimed_until = $2, outcome_claimed_by = NULL WHERE id = $1', [conv.id, d.clock.now()]);
      }
      await d.actionLog.write(
        {
          agentId: a.agent_id,
          actor: replyTo ? 'system' : 'scheduler',
          action: result.kind === 'booked' ? 'a2a.booked' : 'a2a.booking_failed',
          detail: { conversationId: conv.id, groupId: a.group_id, ...(result.kind === 'booked' ? {} : { slotGone: result.why === SLOT_GONE, undoPending: result.kind === 'undo_pending' }) },
        },
        tx,
      );
    });
    return mine;
  }

  async function approved(approval: ApprovalRow, timezone: string): Promise<string | undefined> {
    const p = outcomePayload.parse(approval.payload);
    const other = await sibling(approval);
    if (!other) return "That one isn't open any more.";
    if (other.status === 'pending') return `Waiting for ${p.peer}.`;
    if (!BOOKABLE.includes(other.status)) return "That one isn't open any more.";
    if (!(await claim(p.conversationId, approval.group_id!, approval.id))) return settledLine(approval, other, p, timezone);
    // An unexpected error escapes: the job retries this hook, which takes its own claim over
    // and resumes; if it never comes back, the sweep resumes once the lease has run out.
    const result = await runBooking(approval, other);
    return (await settle(approval, other, result, approval.id)) ?? settledLine(approval, other, p, timezone);
  }

  /**
   * Scheduler (I7): finishes every booking whose claim lapsed — a worker that died between
   * the two writes, a hook that gave up, an undo that failed. Returns how many it settled.
   */
  async function resumeBookings(): Promise<number> {
    const due = await d.db.query<{ id: string; outcome_group_id: string; outcome_claimed_by: string | null }>(
      `SELECT id, outcome_group_id, outcome_claimed_by FROM a2a_conversations
       WHERE status IN ('awaiting_approval', 'closed') AND outcome_state = 'booking' AND outcome_claimed_until <= $1 ORDER BY seq`,
      [d.clock.now()],
    );
    let n = 0;
    for (const c of due.rows) {
      try {
        const rows = await d.db.query<{ id: string }>(`SELECT id FROM approvals WHERE group_id = $1 AND kind = $2 ORDER BY seq`, [c.outcome_group_id, OUTCOME_KIND]);
        const approvals = (await Promise.all(rows.rows.map((r) => d.approvals.get(r.id)))).filter((x): x is ApprovalRow => x !== null);
        if (approvals.length !== 2) continue;
        const [a, b] = approvals[1]!.id === c.outcome_claimed_by ? [approvals[1]!, approvals[0]!] : [approvals[0]!, approvals[1]!];
        if (!(await claim(c.id, c.outcome_group_id, `sweep:${randomUUID()}`))) continue;
        await settle(a, b, await runBooking(a, b), null);
        n += 1;
      } catch (err) {
        d.log.warn({ conversationId: c.id, err: err instanceof Error ? err.message : String(err) }, 'a2a: booking resume failed; retried at the next sweep');
      }
    }
    return n;
  }

  const kind: ApprovalKind<OutcomePayload> = {
    schema: outcomePayload,
    quotesThirdParty: true,
    render: (p, { timezone }) => outcomePrompt(p, timezone),
    // Once the first event has started a yes is too late (zero events: the default expiry).
    latestExpiry: (p) => new Date(Math.min(...p.events.map((e) => Date.parse(e.start)), 8.64e15)),
    calendarEvents: (p) =>
      p.events.filter((e) => e.mine).map((e) => ({ title: e.title, start: new Date(e.start), end: new Date(e.end), ...(e.location ? { location: e.location } : {}) })),
    guard,
    onApproved: async ({ approval, owner }) => approved(approval, owner.timezone),
    onDenied: async ({ approval }) => {
      await rejected(approval, 'no');
      return 'Okay, nothing is booked. Tell me if the other Violet should hear something else.';
    },
    onExpired: async ({ approval }) => rejected(approval, 'expired'),
  };

  return { kind, request, resumeBookings };
}

/** Whether every event is free on the owner's calendar right now (busy intervals only). */
export async function slotsFree(d: { calendar: Pick<A2ADeps['calendar'], 'freeBusy'> }, ownerId: string, events: Array<{ start: string; end: string }>): Promise<boolean> {
  if (events.length === 0) return true;
  const from = new Date(Math.min(...events.map((e) => Date.parse(e.start))));
  const to = new Date(Math.max(...events.map((e) => Date.parse(e.end))));
  const busy = await d.calendar.freeBusy(ownerId, from, to);
  return events.every((e) => busy.every((b) => b.end.getTime() <= Date.parse(e.start) || b.start.getTime() >= Date.parse(e.end)));
}
