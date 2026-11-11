import type { TransportName } from '../transport/types.js';

/** Rows as stored. Column names stay snake_case to match the SQL. */

export interface HouseholdRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface OwnerRow {
  id: string;
  household_id: string;
  name: string;
  timezone: string;
  digest_hour: number;
  created_at: Date;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  transport: TransportName;
  agent_address: string;
  owner_address: string | null;
  pairing_code_hash: string | null;
  pairing_expires_at: Date | null;
  paused: boolean;
  paused_at: Date | null;
  created_at: Date;
}

export type ContactKind = 'owner' | 'stranger';

export interface ContactRow {
  id: string;
  agent_id: string;
  transport: TransportName;
  address: string;
  display_name: string | null;
  kind: ContactKind;
  first_seen_at: Date;
  last_seen_at: Date;
  last_canned_reply_at: Date | null;
}

export interface ContactNoteRow {
  id: string;
  agent_id: string;
  contact_id: string | null;
  subject: string | null;
  body: string;
  created_at: Date;
}

export type Thread = 'owner' | 'contact';
export type Direction = 'in' | 'out';

export interface MessageRow {
  id: string;
  agent_id: string;
  thread: Thread;
  contact_id: string | null;
  direction: Direction;
  body: string;
  purpose: string | null;
  transport_message_id: string | null;
  reply_to_transport_message_id: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
}

export interface InboundEventRow {
  id: string;
  transport: TransportName;
  transport_message_id: string;
  agent_address: string;
  payload: Record<string, unknown>;
  received_at: Date;
  processed_at: Date | null;
  /** Routing steps already done → their results (see Router.process). */
  progress: Record<string, unknown>;
}

export type FlagUrgency = 'now' | 'digest';
export type FlagStatus = 'pending' | 'sent' | 'suppressed';

export interface FlagRow {
  id: string;
  agent_id: string;
  kind: string;
  urgency: FlagUrgency;
  text: string;
  dedupe_key: string | null;
  status: FlagStatus;
  created_at: Date;
  delivered_at: Date | null;
  digest_date: string | null;
}
