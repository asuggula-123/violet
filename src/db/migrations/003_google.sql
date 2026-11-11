-- 003_google: Google accounts (encrypted refresh tokens, I16) and OAuth connect states.

CREATE TABLE google_accounts (
  owner_id text PRIMARY KEY REFERENCES owners(id),
  -- Gmail address; null when Gmail read was not granted.
  email text NULL,
  -- AES-256-GCM, `v1.<iv>.<ciphertext>.<tag>` (src/google/crypto.ts).
  refresh_token_enc text NOT NULL,
  -- Space-separated scopes Google actually granted.
  scopes text NOT NULL,
  connected_at timestamptz NOT NULL,
  revoked_at timestamptz NULL
);

CREATE TABLE oauth_states (
  -- sha256 hex of the state value; the value itself is never stored.
  state text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Set when the callback consumes the state (single use).
  used_at timestamptz NULL
);
CREATE INDEX oauth_states_owner ON oauth_states (owner_id);
