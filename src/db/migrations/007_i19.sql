-- 007_i19: genuine approval deliveries (I19) and prompts held until the end of a Brain turn.
-- App code always supplies timestamps from its Clock; there are no time defaults.

-- One row per message the approvals service itself sent as the prompt of ONE approval: the
-- first delivery, a re-prompt, or a prompt re-sent under "Which one?". Whether an outbound
-- message is a genuine prompt is decided ONLY by this table (never by text, purpose or buttons).
CREATE TABLE approval_deliveries (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  approval_id text NOT NULL REFERENCES approvals(id),
  kind text NOT NULL CHECK (kind IN ('prompt', 'reprompt', 'which_one')),
  -- '<chat>:<message number>' once sent; NULL = claimed, not (yet) sent.
  transport_message_id text NULL,
  -- The owner message that caused a re-prompt / which-one (NULL for the first delivery).
  for_message_id text NULL,
  created_at timestamptz NOT NULL,
  -- At most one re-send per (owner message, approval), across hook retries and duplicate runs.
  UNIQUE (for_message_id, approval_id)
);
-- A message is a genuine delivery for exactly one approval.
CREATE UNIQUE INDEX approval_deliveries_message ON approval_deliveries (agent_id, transport_message_id) WHERE transport_message_id IS NOT NULL;
CREATE UNIQUE INDEX approval_deliveries_first ON approval_deliveries (approval_id) WHERE kind = 'prompt';

INSERT INTO approval_deliveries (id, agent_id, approval_id, kind, transport_message_id, for_message_id, created_at)
SELECT 'backfill:' || id, agent_id, id, 'prompt', prompt_transport_message_id, NULL, created_at
FROM approvals WHERE prompt_transport_message_id IS NOT NULL;

-- An approval requested inside a Brain turn is held (not delivered) until the turn has sent
-- its reply; the turn then delivers it. hold_until is the crash net: after it the sweep sends it.
ALTER TABLE approvals ADD COLUMN hold_until timestamptz NULL;
ALTER TABLE approvals ADD COLUMN turn_message_id text NULL;
CREATE INDEX approvals_turn ON approvals (agent_id, turn_message_id) WHERE turn_message_id IS NOT NULL;
