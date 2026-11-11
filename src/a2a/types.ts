import type { AgentRow, OwnerRow } from '../core/types.js';

/** I10, I12: every limit is enforced in code and each refusal is logged (`a2a.limit`). */
export const A2A_LIMITS = Object.freeze({
  openPerPair: 3,
  newPerPairPerDay: 10,
  messagesPerSide: 12,
  questionsPerSide: 2,
  availabilityPerSide: 8,
  /** Window the own owner may set (talk_to_agent). */
  ownWindowDays: 31,
  /** How much of a window declared by the peer the responder may read. */
  peerWindowDays: 7,
  maxEvents: 5,
  idleMs: 24 * 3_600_000,
});

export const DAY_MS = 86_400_000;

export type ConversationStatus = 'open' | 'awaiting_approval' | 'closed';
export type OutcomeState = 'booking' | 'booked' | 'failed';

export interface ConversationRow {
  id: string;
  household_id: string;
  initiator_agent_id: string;
  responder_agent_id: string;
  topic: string;
  status: ConversationStatus;
  window_start: Date | null;
  window_end: Date | null;
  last_seq: number;
  live_proposal_seq: number | null;
  accepted_proposal_seq: number | null;
  outcome_group_id: string | null;
  outcome_state: OutcomeState | null;
  open_key: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
}

export interface SideRow {
  conversation_id: string;
  agent_id: string;
  role: 'initiator' | 'responder';
  brief: string | null;
  availability_calls: number;
  messages_sent: number;
  owner_questions: number;
  awaiting_owner: boolean;
  stalled: boolean;
}

export type MessageKind = 'open' | 'text' | 'proposal' | 'accept' | 'decline' | 'system' | 'close' | 'question' | 'guidance';

export interface A2AMessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  from_agent_id: string | null;
  private_to: string | null;
  kind: MessageKind;
  body: string;
  payload: Record<string, unknown>;
  turn_key: string | null;
  created_at: Date;
}

export type CalendarsChoice = 'both' | 'mine' | 'theirs';

/** A proposed event as stored: `agents` = whose calendars it goes on (resolved by code at propose time). */
export interface ProposalEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  calendars: CalendarsChoice;
  agents: string[];
}

export interface ProposalPayload {
  summary: string;
  events: ProposalEvent[];
}

/** One side of a conversation, as seen from `me`. */
export interface Party {
  agent: AgentRow;
  owner: OwnerRow;
  /** The owner's first name (sanitized). */
  first: string;
}

export interface Parties {
  me: Party;
  peer: Party;
  /** How `me`'s owner names the other agent: `Sam's Violet`. */
  peerLabel: string;
}

export interface ConversationSummary {
  id: string;
  peer: string;
  topic: string;
  status: ConversationStatus;
  openedByMe: boolean;
}

export interface A2AService {
  /** Open conversations of an agent (not closed), oldest first. */
  listConversations(agentId: string, includeClosed?: boolean): Promise<ConversationSummary[]>;
  /** The full verbatim transcript as code-rendered lines, for `agentId`'s owner. */
  transcript(agentId: string, conversationId: string): Promise<string>;
  /** Idle conversations → expired. Returns how many closed. */
  sweep(): Promise<number>;
}
