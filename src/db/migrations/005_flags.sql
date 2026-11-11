-- 005_flags (M5): urgent-flag policy markers (I17) and the daily digest (8.5).
-- A flag is a digest item while status = 'pending' and (urgency = 'digest' or
-- overflowed_at is set). digest_id ties an item to the one digest that carries it.
ALTER TABLE flags ADD COLUMN held_until timestamptz NULL;     -- 'now' flag held for quiet hours
ALTER TABLE flags ADD COLUMN budget_date date NULL;           -- owner-local date whose budget it uses
ALTER TABLE flags ADD COLUMN attempt_at timestamptz NULL;     -- send in flight (lease) since then
ALTER TABLE flags ADD COLUMN overflowed_at timestamptz NULL;  -- 'now' flag turned into a digest item
ALTER TABLE flags ADD COLUMN digest_id text NULL;
ALTER TABLE flags ADD COLUMN retry_at timestamptz NULL;       -- release task backs off a failed send until then
ALTER TABLE flags ADD COLUMN send_failures int NOT NULL DEFAULT 0;

CREATE INDEX flags_now_pending ON flags (seq) WHERE status = 'pending' AND urgency = 'now' AND overflowed_at IS NULL;
CREATE INDEX flags_budget ON flags (agent_id, budget_date) WHERE budget_date IS NOT NULL;
CREATE INDEX flags_digest ON flags (digest_id) WHERE digest_id IS NOT NULL;

-- One row per (agent, owner-local date): the date is closed once a row exists.
-- status: 'sending' (body stored, not yet delivered), 'sent', 'empty' (nothing to say),
-- 'rolled_over' (not delivered before the date ended: its items went back to the pool).
CREATE TABLE digests (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  local_date date NOT NULL,
  body text NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'empty', 'rolled_over')),
  item_count int NOT NULL,
  left_out int NOT NULL,
  created_at timestamptz NOT NULL,
  lease_until timestamptz NULL,
  sent_at timestamptz NULL,
  send_failures int NOT NULL DEFAULT 0,
  UNIQUE (agent_id, local_date)
);

ALTER TABLE flags ADD CONSTRAINT flags_digest_fk FOREIGN KEY (digest_id) REFERENCES digests(id);
