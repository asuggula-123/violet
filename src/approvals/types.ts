import type { z } from 'zod';
import type { AgentRow, OwnerRow } from '../core/types.js';
import type { NewCalendarEvent } from '../google/types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'executed' | 'failed';

export interface ApprovalRow {
  id: string;
  agent_id: string;
  ref: number;
  kind: string;
  payload: Record<string, unknown>;
  prompt: string;
  status: ApprovalStatus;
  group_id: string | null;
  prompt_transport_message_id: string | null;
  idempotency_key: string | null;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
  resolved_by_message_id: string | null;
  executed_at: Date | null;
  error: string | null;
  /**
   * (P4, migration 008) Requested inside a tainted Brain turn: its text may carry third-party
   * words, so every delivery and every resolver line quoting it is stored tainted, and while it
   * is pending the Brain sees it only as untrusted data (and the turn is tainted).
   */
  tainted: boolean;
}

/** What render and booked get: the owner's zone and the current time (the year rule of exactRange). */
export interface RenderContext {
  timezone: string;
  now: Date;
}

export interface KindContext {
  approval: ApprovalRow;
  agent: AgentRow;
  owner: OwnerRow;
  calendar: CalendarWriter;
  now: Date;
}

/**
 * One kind of approval. The prompt is rendered by code from the stored payload; the
 * service makes it one sanitized line: `#<ref> <render(...)> Reply yes or no.` (I13).
 * onApproved / onDenied return the short reply the owner gets (a default is sent otherwise).
 */
export interface ApprovalKind<P = any> {
  schema: z.ZodType<P>;
  render(payload: P, ctx: RenderContext): string;
  onApproved?(ctx: KindContext): Promise<string | void>;
  onDenied?(ctx: KindContext): Promise<string | void>;
  onExpired?(ctx: KindContext): Promise<void>;
  /** The events CalendarWriter books for an approved approval, built from the stored payload (I6). */
  calendarEvents?(payload: P): NewCalendarEvent[];
  /**
   * One line for the digest's 'Booked' section once CalendarWriter has booked it (raised as
   * a 'booked' digest flag, made one line with no number sign by code). Omit for no line.
   */
  booked?(payload: P, ctx: RenderContext): string;
  /** The latest the approval may stay open (e.g. an event's start): caps expiresAt. */
  latestExpiry?(payload: P): Date;
  /** Runs inside CalendarWriter before any write. Throw (ideally with `ownerMessage`) to refuse. */
  guard?(approval: ApprovalRow): Promise<void>;
  /**
   * The prompt quotes third-party text (e.g. another agent's proposal, M4). The stored
   * prompt message is marked tainted and the Brain sees it only as untrusted data.
   */
  quotesThirdParty?: boolean;
  /**
   * (P13) A yes books only together with another owner's yes (I7, a2a_outcome): while one is
   * pending, request_calendar_event refuses a time that overlaps one of its events.
   */
  jointBooking?: boolean;
  /**
   * (P13) For a jointBooking approval this owner already approved: whether its plan is still
   * open (waits for the other owner's yes or is being booked). While it is, the same refusal holds.
   */
  jointOpen?(approval: ApprovalRow): Promise<boolean>;
}

export interface ApprovalRequest {
  kind: string;
  payload: unknown;
  groupId?: string;
  /** Default: 24 h from now. */
  expiresAt?: Date;
  /** The same key for the same agent returns the approval already created. */
  idempotencyKey?: string;
}

/** `held` (F2): refused because the owner is paused before anything was written; the approval stays `approved`. */
export type ExecuteResult = { ok: true; eventIds: string[] } | { ok: false; reason: string; held?: true };

/** I6: the only code that writes the calendar. */
export interface CalendarWriter {
  /** Books the events of an `approved` approval from its stored payload; marks it executed (or failed). */
  executeApproved(approvalId: string): Promise<ExecuteResult>;
  /** Deletes the events recorded for the approval (compensation). Returns how many. */
  undo(approvalId: string): Promise<number>;
}

export interface ApprovalService {
  registerKind<P>(kind: string, def: ApprovalKind<P>): void;
  /**
   * Validates, stores and sends the prompt at once (unless paused: then it is sent on resume).
   * Inside a Brain turn (turn.ts) the prompt is held instead: the turn delivers it after its reply.
   */
  request(agentId: string, req: ApprovalRequest): Promise<ApprovalRow>;
  /** S2: start of an attempt of the Brain turn of `messageId`: its unsent prompts are held for TURN_HOLD_MS again. */
  holdTurn(agentId: string, messageId: string): Promise<void>;
  /** End of the Brain turn of `messageId`: delivers that turn's unsent prompts in creation order. */
  deliverTurn(agentId: string, messageId: string): Promise<void>;
  get(id: string): Promise<ApprovalRow | null>;
  listPending(agentId: string): Promise<ApprovalRow[]>;
  /** pending → cancelled. Returns false if it was no longer pending. */
  cancel(id: string, reason: string): Promise<boolean>;
  /** Sends pending prompts that have not reached the owner yet. */
  sendUnsent(agentId: string): Promise<void>;
  /** pending past expires_at → expired (+ onExpired, + a digest flag). Returns how many. */
  expireDue(agentId: string): Promise<number>;
  /** Whether prompts of this kind quote third-party text (ApprovalKind.quotesThirdParty). */
  quotesThirdParty(kind: string): boolean;
  /** Whether the Brain may see this approval's text only as untrusted data: quotesThirdParty(kind) or approval.tainted (P4). */
  untrusted(approval: Pick<ApprovalRow, 'kind' | 'tainted'>): boolean;
  /**
   * (P13) The events (this owner's) of open approvals of jointBooking kinds, with their refs:
   * pending ones, and approved ones whose plan is still open (jointOpen). `answered`: the owner said yes already.
   */
  pendingJointEvents(agentId: string): Promise<Array<{ ref: number; start: Date; end: Date; answered: boolean }>>;
  readonly calendar: CalendarWriter;
}
