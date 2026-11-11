-- 001_core: households, owners, agents, contacts, messages, jobs, flags, action_log.
-- App code always supplies timestamps from its Clock; there are no time defaults.
-- `seq` columns give a stable order to rows written at the same clock instant
-- (never read raw: bigint differs between drivers).

CREATE TABLE households (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE owners (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  name text NOT NULL,
  timezone text NOT NULL,
  digest_hour int NOT NULL DEFAULT 18 CHECK (digest_hour BETWEEN 0 AND 23),
  created_at timestamptz NOT NULL
);

CREATE TABLE agents (
  id text PRIMARY KEY,
  owner_id text NOT NULL UNIQUE REFERENCES owners(id),
  name text NOT NULL DEFAULT 'Violet',
  transport text NOT NULL,
  agent_address text NOT NULL,
  owner_address text NULL,
  pairing_code_hash text NULL,
  pairing_expires_at timestamptz NULL,
  paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (transport, agent_address)
);

CREATE TABLE contacts (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  transport text NOT NULL,
  address text NOT NULL,
  display_name text NULL,
  kind text NOT NULL CHECK (kind IN ('owner', 'stranger')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_canned_reply_at timestamptz NULL,
  UNIQUE (agent_id, transport, address)
);

CREATE TABLE contact_notes (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  contact_id text NULL REFERENCES contacts(id),
  subject text NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX contact_notes_agent ON contact_notes (agent_id, seq);

CREATE TABLE messages (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  thread text NOT NULL CHECK (thread IN ('owner', 'contact')),
  contact_id text NULL REFERENCES contacts(id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  body text NOT NULL,
  purpose text NULL,
  transport_message_id text NULL,
  reply_to_transport_message_id text NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX messages_agent_thread ON messages (agent_id, thread, seq);

CREATE TABLE inbound_events (
  id text PRIMARY KEY,
  transport text NOT NULL,
  transport_message_id text NOT NULL,
  agent_address text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz NULL,
  -- Steps of the routing flow already done, with their results. A retried
  -- inbound.process job skips them (I18: one event, one set of side effects).
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (transport, transport_message_id)
);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  type text NOT NULL,
  lane text NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL,
  run_at timestamptz NOT NULL,
  locked_at timestamptz NULL,
  last_error text NULL,
  dedupe_key text NULL UNIQUE,
  created_at timestamptz NOT NULL,
  finished_at timestamptz NULL
);
CREATE INDEX jobs_runnable ON jobs (run_at, seq) WHERE status IN ('queued', 'failed');
-- Lane order: an unfinished job holds back the newer jobs of its lane.
CREATE INDEX jobs_lane_unfinished ON jobs (lane, seq) WHERE status IN ('queued', 'failed', 'running');
-- Stale-running recovery (visibility timeout).
CREATE INDEX jobs_running_locked ON jobs (locked_at) WHERE status = 'running';
-- At most one running job per lane, enforced by the database.
CREATE UNIQUE INDEX jobs_one_running_per_lane ON jobs (lane) WHERE status = 'running' AND lane IS NOT NULL;

CREATE TABLE flags (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  kind text NOT NULL,
  urgency text NOT NULL CHECK (urgency IN ('now', 'digest')),
  text text NOT NULL,
  dedupe_key text NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'suppressed')),
  created_at timestamptz NOT NULL,
  delivered_at timestamptz NULL,
  digest_date date NULL,
  UNIQUE (agent_id, dedupe_key)
);
CREATE INDEX flags_pending ON flags (agent_id, status);

CREATE TABLE scheduler_state (
  name text NOT NULL,
  scope text NOT NULL,
  last_run_at timestamptz NOT NULL,
  PRIMARY KEY (name, scope)
);

CREATE TABLE action_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  agent_id text NULL,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX action_log_agent_action ON action_log (agent_id, action, id);
CREATE INDEX action_log_action ON action_log (action, id);

-- I15: action_log is append-only.
CREATE FUNCTION action_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'action_log is append-only (% blocked)', TG_OP;
END;
$$;

CREATE TRIGGER action_log_no_update_delete
  BEFORE UPDATE OR DELETE ON action_log
  FOR EACH ROW EXECUTE FUNCTION action_log_append_only();

CREATE TRIGGER action_log_no_truncate
  BEFORE TRUNCATE ON action_log
  FOR EACH STATEMENT EXECUTE FUNCTION action_log_append_only();
