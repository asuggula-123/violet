-- M6: Telegram long-polling offset, one row per bot (bot id = agents.agent_address).
-- updated_at: when the last update was ingested. After about a week without updates
-- Telegram may restart update ids at a random (lower) value, so a stale offset is dropped.
CREATE TABLE telegram_state (
  bot_id text PRIMARY KEY,
  last_update_id bigint NOT NULL,
  updated_at timestamptz NOT NULL
);
