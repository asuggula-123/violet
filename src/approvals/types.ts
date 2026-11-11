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
}

export interface KindContext {
  approval: ApprovalRow;
  agent: AgentRow;
  owner: OwnerRow;
  calendar: CalendarWriter;
}

/**
 * One kind of approval. The prompt is rendered by code from the stored payload; the
 * service makes it one sanitized line: `#<ref> <render(...)> Reply yes or no.` (I13).
 * onApproved / onDenied return the short reply the owner gets (a default is sent otherwise).
 */
export interface ApprovalKind<P = any> {
  schema: z.ZodType<P>;
  render(payload: P, ctx: { timezone: string }): string;
  onApproved?(ctx: KindContext): Promise<string | void>;
  onDenied?(ctx: KindContext): Promise<string | void>;
  onExpired?(ctx: KindContext): Promise<void>;
  /** The events CalendarWriter books for an approved approval, built from the stored payload (I6). */
  calendarEvents?(payload: P): NewCalendarEvent[];
  /**
   * One line for the digest's 'Booked' section once CalendarWriter has booked it (raised as
   * a 'booked' digest flag, made one line with no number sign by code). Omit for no line.
   */
  booked?(payload: P, ctx: { timezone: string }): string;
  /** The latest the approval may stay open (e.g. an event's start): caps expiresAt. */
  latestExpiry?(payload: P): Date;
  /** Runs inside CalendarWriter before any write. Throw (ideally with `ownerMessage`) to refuse. */
  guard?(approval: ApprovalRow): Promise<void>;
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

export type ExecuteResult = { ok: true; eventIds: string[] } | { ok: false; reason: string };

/** I6: the only code that writes the calendar. */
export interface CalendarWriter {
  /** Books the events of an `approved` approval from its stored payload; marks it executed (or failed). */
  executeApproved(approvalId: string): Promise<ExecuteResult>;
  /** Deletes the events recorded for the approval (compensation). Returns how many. */
  undo(approvalId: string): Promise<number>;
}

export interface ApprovalService {
  registerKind<P>(kind: string, def: ApprovalKind<P>): void;
  /** Validates, stores and sends the prompt at once (unless paused: then it is sent on resume). */
  request(agentId: string, req: ApprovalRequest): Promise<ApprovalRow>;
  get(id: string): Promise<ApprovalRow | null>;
  listPending(agentId: string): Promise<ApprovalRow[]>;
  /** pending → cancelled. Returns false if it was no longer pending. */
  cancel(id: string, reason: string): Promise<boolean>;
  /** Sends pending prompts that have not reached the owner yet. */
  sendUnsent(agentId: string): Promise<void>;
  /** pending past expires_at → expired (+ onExpired, + a digest flag). Returns how many. */
  expireDue(agentId: string): Promise<number>;
  readonly calendar: CalendarWriter;
}
