-- 004_a2a (M4): agent-to-agent conversations over the internal channel (DB + job queue).
-- App code always supplies timestamps from its Clock; there are no time defaults.

CREATE TABLE a2a_conversations (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  household_id text NOT NULL REFERENCES households(id),
  initiator_agent_id text NOT NULL REFERENCES agents(id),
  responder_agent_id text NOT NULL REFERENCES agents(id),
  topic text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'awaiting_approval', 'closed')),
  -- Set by the initiator's owner (≤ 31 days); the responder may read free/busy in its first 7 days (I10).
  window_start timestamptz NULL,
  window_end timestamptz NULL,
  -- Highest a2a_messages.seq so far: bumped under the row lock, so messages never reorder.
  last_seq int NOT NULL DEFAULT 0,
  -- The latest proposal that can still be accepted or declined.
  live_proposal_seq int NULL,
  -- The accepted proposal waiting for both owners, its approvals' group id and booking state.
  accepted_proposal_seq int NULL,
  outcome_group_id text NULL,
  outcome_state text NULL CHECK (outcome_state IN ('booking', 'booked', 'failed')),
  outcome_claimed_until timestamptz NULL,
  -- Who holds the booking claim (an approval id for the owner's yes hook, or a sweep run):
  -- a retry of the same hook takes it over; anyone may once the lease has run out.
  outcome_claimed_by text NULL,
  -- Idempotency key of the release that opened it (a Brain call key or an approval).
  open_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz NULL,
  close_reason text NULL,
  CHECK (initiator_agent_id <> responder_agent_id)
);
CREATE INDEX a2a_conversations_pair ON a2a_conversations (initiator_agent_id, responder_agent_id, status);
CREATE INDEX a2a_conversations_idle ON a2a_conversations (status, updated_at);

CREATE TABLE a2a_sides (
  conversation_id text NOT NULL REFERENCES a2a_conversations(id),
  agent_id text NOT NULL REFERENCES agents(id),
  role text NOT NULL CHECK (role IN ('initiator', 'responder')),
  -- The owner's released brief; NULL = the default posture written by code.
  brief text NULL,
  availability_calls int NOT NULL DEFAULT 0,
  messages_sent int NOT NULL DEFAULT 0,
  owner_questions int NOT NULL DEFAULT 0,
  awaiting_owner boolean NOT NULL DEFAULT false,
  stalled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, agent_id)
);

-- Every message, stored verbatim; never edited or deleted (trigger below).
-- `private_to` set = only that side sees it (its owner's guidance, its questions to its owner).
CREATE TABLE a2a_messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES a2a_conversations(id),
  seq int NOT NULL,
  from_agent_id text NULL REFERENCES agents(id),
  private_to text NULL REFERENCES agents(id),
  kind text NOT NULL CHECK (kind IN ('open', 'text', 'proposal', 'accept', 'decline', 'system', 'close', 'question', 'guidance')),
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The Envoy turn (or release) that wrote it: one outward act per turn, ever.
  turn_key text NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE FUNCTION a2a_messages_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a2a_messages is append-only';
END;
$$;
CREATE TRIGGER a2a_messages_no_update BEFORE UPDATE OR DELETE ON a2a_messages
  FOR EACH ROW EXECUTE FUNCTION a2a_messages_append_only();
CREATE TRIGGER a2a_messages_no_truncate BEFORE TRUNCATE ON a2a_messages
  FOR EACH STATEMENT EXECUTE FUNCTION a2a_messages_append_only();

-- One Envoy turn per delivery (conversation, receiving agent, message seq).
CREATE TABLE a2a_turns (
  turn_key text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES a2a_conversations(id),
  agent_id text NOT NULL REFERENCES agents(id),
  trigger_seq int NOT NULL,
  -- waiting = the agent was paused; onResume re-queues it.
  status text NOT NULL CHECK (status IN ('running', 'waiting', 'done')),
  requeues int NOT NULL DEFAULT 0,
  outcome text NULL,
  created_at timestamptz NOT NULL,
  finished_at timestamptz NULL
);
CREATE INDEX a2a_turns_waiting ON a2a_turns (agent_id, status);

-- Code-rendered lines for an owner (questions, releases, outcomes), sent by a job on the
-- owner's lane; held while the agent is paused and re-queued on resume.
CREATE TABLE a2a_notices (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  purpose text NOT NULL CHECK (purpose IN ('reply', 'question')),
  text text NOT NULL,
  tainted boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'waiting', 'sent')),
  requeues int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  sent_at timestamptz NULL
);
CREATE INDEX a2a_notices_agent ON a2a_notices (agent_id, status);

-- I7 (M4): CalendarWriter records the write intent BEFORE calling the provider, so an event
-- the provider made but whose response was lost (or a crash before the id was stored) can
-- still be found by its idempotency key and undone. event_id NULL = not yet confirmed.
ALTER TABLE calendar_writes ALTER COLUMN event_id DROP NOT NULL;
