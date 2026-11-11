import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { FlagService } from '../core/flags.js';
import type { Queryable } from '../db/db.js';
import { decryptToken, encryptToken, TokenDecryptError } from './crypto.js';
import { GoogleAuthError, GoogleNotConnectedError, GoogleRequestError } from './errors.js';
import type { GoogleHttp } from './http.js';
import { capabilitiesOf, type Capabilities } from './scopes.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Refresh this long before Google's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;
export const REVOKED_FLAG_TEXT = 'Google access expired — reconnect needed.';

export interface GoogleAccount {
  ownerId: string;
  email: string | null;
  scopes: string[];
  capabilities: Capabilities;
  connectedAt: Date;
  revokedAt: Date | null;
}

interface AccountRow {
  owner_id: string;
  email: string | null;
  refresh_token_enc: string;
  scopes: string;
  connected_at: Date;
  revoked_at: Date | null;
}

export interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface TokenStoreDeps {
  db: Queryable;
  clock: Clock;
  http: GoogleHttp;
  actionLog: ActionLog;
  log: Logger;
  key: Buffer;
  clientId: string;
  clientSecret: string;
  agentOf(ownerId: string): Promise<string | null>;
  /** Bound once the app exists (see googleModule); revocation flags need it. */
  flags(): FlagService | null;
}

const aad = (ownerId: string) => `violet.google.refresh:${ownerId}`;

/**
 * google_accounts store (I16: refresh tokens encrypted) plus an in-memory access-token
 * cache that honours expiry via the Clock, with one refresh in flight per owner.
 */
export class TokenStore {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly deps: TokenStoreDeps) {}

  async save(ownerId: string, a: { email: string | null; refreshToken: string; scopes: string[] }): Promise<void> {
    const sealed = encryptToken(this.deps.key, a.refreshToken, aad(ownerId));
    await this.deps.db.query(
      `INSERT INTO google_accounts (owner_id, email, refresh_token_enc, scopes, connected_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (owner_id) DO UPDATE SET email = EXCLUDED.email, refresh_token_enc = EXCLUDED.refresh_token_enc,
         scopes = EXCLUDED.scopes, connected_at = EXCLUDED.connected_at, revoked_at = NULL`,
      [ownerId, a.email, sealed, a.scopes.join(' '), this.deps.clock.now()],
    );
    this.cache.delete(ownerId);
  }

  async account(ownerId: string): Promise<GoogleAccount | null> {
    const row = await this.row(ownerId);
    if (!row) return null;
    const scopes = row.scopes.split(' ').filter((s) => s !== '');
    return {
      ownerId,
      email: row.email,
      scopes,
      capabilities: capabilitiesOf(scopes),
      connectedAt: row.connected_at,
      revokedAt: row.revoked_at,
    };
  }

  /** The connected, non-revoked account, or a typed error. */
  async active(ownerId: string): Promise<GoogleAccount> {
    const a = await this.account(ownerId);
    if (!a) throw new GoogleNotConnectedError(ownerId);
    if (a.revokedAt) throw new GoogleAuthError(`google account of owner ${ownerId} is revoked`, 'revoked');
    return a;
  }

  /** Seeds the cache with the access token from the code exchange. */
  remember(ownerId: string, token: TokenResponse): void {
    if (token.access_token && token.expires_in) {
      this.cache.set(ownerId, { token: token.access_token, expiresAt: this.deps.clock.now().getTime() + token.expires_in * 1000 });
    }
  }

  /** Forget a cached token Google refused (401), so the next call refreshes. */
  invalidate(ownerId: string, token: string): void {
    if (this.cache.get(ownerId)?.token === token) this.cache.delete(ownerId);
  }

  async accessToken(ownerId: string): Promise<string> {
    const hit = this.cache.get(ownerId);
    if (hit && this.deps.clock.now().getTime() < hit.expiresAt - EXPIRY_MARGIN_MS) return hit.token;
    const running = this.inflight.get(ownerId);
    if (running) return running;
    const p = this.refresh(ownerId).finally(() => this.inflight.delete(ownerId));
    this.inflight.set(ownerId, p);
    return p;
  }

  private async refresh(ownerId: string): Promise<string> {
    const row = await this.row(ownerId);
    if (!row) throw new GoogleNotConnectedError(ownerId);
    if (row.revoked_at) throw new GoogleAuthError(`google account of owner ${ownerId} is revoked`, 'revoked');
    let refreshToken: string;
    try {
      refreshToken = decryptToken(this.deps.key, row.refresh_token_enc, aad(ownerId));
    } catch (err) {
      if (!(err instanceof TokenDecryptError)) throw err;
      // Wrong/rotated TOKEN_ENC_KEY or a corrupt row. Not marked revoked (restoring the key
      // recovers it), but the owner is told once per connection that a reconnect is needed.
      this.deps.log.error({ ownerId }, 'google refresh token failed to decrypt');
      await this.raiseReconnectFlag(row, 'google.undecryptable');
      throw new GoogleAuthError(`google refresh token of owner ${ownerId} failed to decrypt`, 'undecryptable');
    }
    let res: TokenResponse;
    try {
      res = await this.deps.http.request<TokenResponse>({
        method: 'POST',
        url: TOKEN_URL,
        ownerId,
        form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.deps.clientId, client_secret: this.deps.clientSecret },
      });
    } catch (err) {
      if (err instanceof GoogleAuthError && err.reason === 'invalid_grant') await this.revoke(row);
      throw err;
    }
    if (!res.access_token || !res.expires_in) throw new GoogleRequestError('google token refresh: response without access_token');
    this.remember(ownerId, res);
    return res.access_token;
  }

  /** invalid_grant: the owner revoked access or the grant expired. One flag per connection. */
  private async revoke(row: AccountRow): Promise<void> {
    const { db, clock, actionLog } = this.deps;
    const now = clock.now();
    const changed = await db.query(
      'UPDATE google_accounts SET revoked_at = $2 WHERE owner_id = $1 AND connected_at = $3 AND revoked_at IS NULL',
      [row.owner_id, now, row.connected_at],
    );
    this.cache.delete(row.owner_id);
    if (changed.rowCount === 0) return;
    const agentId = await this.deps.agentOf(row.owner_id);
    await actionLog.write({ agentId, actor: 'system', action: 'google.revoked', detail: { ownerId: row.owner_id } });
    await this.raiseReconnectFlag(row, 'google.revoked', agentId);
  }

  /** One 'now' flag per connection and kind (dedupe key); failures are logged, never thrown. */
  private async raiseReconnectFlag(row: AccountRow, kind: 'google.revoked' | 'google.undecryptable', agent?: string | null): Promise<void> {
    const { log } = this.deps;
    try {
      const agentId = agent === undefined ? await this.deps.agentOf(row.owner_id) : agent;
      const flags = this.deps.flags();
      if (!agentId || !flags) {
        log.warn({ ownerId: row.owner_id, kind }, 'google reconnect needed; no flag service to tell the owner');
        return;
      }
      await flags.raise(agentId, {
        kind,
        urgency: 'now',
        text: REVOKED_FLAG_TEXT,
        dedupeKey: `${kind}:${row.owner_id}:${row.connected_at.toISOString()}`,
      });
    } catch (err) {
      // The typed auth error the caller gets is what matters; the flag is best effort.
      log.warn({ ownerId: row.owner_id, kind, err }, 'google reconnect flag not raised');
    }
  }

  private async row(ownerId: string): Promise<AccountRow | null> {
    const res = await this.deps.db.query<AccountRow>(
      'SELECT owner_id, email, refresh_token_enc, scopes, connected_at, revoked_at FROM google_accounts WHERE owner_id = $1',
      [ownerId],
    );
    return res.rows[0] ?? null;
  }
}
