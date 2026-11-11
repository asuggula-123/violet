-- 002_approvals (M2): approvals, calendar writes, and the Brain's per-message turn memo.
-- App code always supplies timestamps from its Clock; there are no time defaults.

-- Arrival order of inbound events (principle 5): nextval is taken when ingest stores the
-- event, before its lane job runs, so it orders what the owner wrote against when a prompt
-- went out even for messages queued in the lane. Core inserts get it from the default.
ALTER TABLE inbound_events ADD COLUMN arrival_seq bigserial NOT NULL;

-- Per-agent approval reference counter (#1, #2, …), bumped atomically by an upsert.
CREATE TABLE approval_refs (
  agent_id text PRIMARY KEY REFERENCES agents(id),
  last_ref int NOT NULL
);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  ref int NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  -- One line, rendered by code from the stored payload (I13).
  prompt text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled', 'executed', 'failed')),
  group_id text NULL,
  -- Set once the prompt reached the owner; NULL = still to be sent (paused, or the send failed).
  prompt_transport_message_id text NULL,
  -- Delivery claim: whoever sets this (atomically) is the only sender until it lapses.
  prompt_sending_until timestamptz NULL,
  idempotency_key text NULL,
  -- Highest messages.seq of the agent when the approval was created: a message with a
  -- seq at or below it was sent before the approval existed and can never answer it.
  created_after_message_seq bigint NOT NULL,
  -- inbound_events.arrival_seq high-water mark (allocated values, committed or not) when the
  -- approval was created / when its prompt was recorded as delivered. An owner message whose
  -- event arrived at or below it was written before the approval existed / before the
  -- prompt reached the owner, so it never answers it (by ref / implicitly).
  created_after_arrival_seq bigint NOT NULL,
  prompt_sent_after_arrival_seq bigint NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  resolved_by_message_id text NULL,
  executed_at timestamptz NULL,
  error text NULL,
  UNIQUE (agent_id, ref),
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX approvals_pending ON approvals (agent_id, status, seq);
CREATE INDEX approvals_prompt ON approvals (agent_id, prompt_transport_message_id);

-- I6: every event CalendarWriter created, so it can be undone (compensation).
CREATE TABLE calendar_writes (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES owners(id),
  approval_id text NOT NULL REFERENCES approvals(id),
  event_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz NULL
);
CREATE INDEX calendar_writes_approval ON calendar_writes (approval_id, seq);

-- One Brain turn per owner message (router hooks run at least once per message).
CREATE TABLE brain_turns (
  message_id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  status text NOT NULL CHECK (status IN ('running', 'done')),
  outcome text NULL,
  created_at timestamptz NOT NULL,
  finished_at timestamptz NULL
);

-- Results of side-effecting Brain tool calls, so a retried turn does not repeat them.
CREATE TABLE brain_tool_memo (
  message_id text NOT NULL,
  tool text NOT NULL,
  input_hash text NOT NULL,
  occurrence int NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, tool, input_hash, occurrence)
);
