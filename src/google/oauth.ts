import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { addMs, type Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { Queryable } from '../db/db.js';
import { url } from './api.js';
import { GoogleError } from './errors.js';
import type { GoogleHttp } from './http.js';
import { capabilitiesOf } from './scopes.js';
import { TOKEN_URL, type TokenResponse, type TokenStore } from './tokens.js';

export const CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const STATE_TTL_MS = 15 * 60_000;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicBaseUrl: string | undefined;
  scopes: readonly string[];
}

export interface OAuthDeps {
  db: Queryable;
  clock: Clock;
  http: GoogleHttp;
  tokens: TokenStore;
  actionLog: ActionLog;
  log: Logger;
  config: OAuthConfig;
  agentOf(ownerId: string): Promise<string | null>;
}

export type CallbackResult = { ok: true; ownerId: string } | { ok: false; reason: string };

/** Only the hash of a state is stored: a leaked table cannot complete someone's connect. */
const hashState = (state: string) => createHash('sha256').update(state, 'utf8').digest('hex');
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export class GoogleOAuth {
  constructor(private readonly deps: OAuthDeps) {}

  /** A single-use link, valid 15 minutes, that starts the consent flow for this owner. */
  async createConnectLink(ownerId: string): Promise<string> {
    const { db, clock, config } = this.deps;
    if (!config.publicBaseUrl) throw new Error('PUBLIC_BASE_URL is required to create a Google connect link');
    const owner = await db.query('SELECT 1 FROM owners WHERE id = $1', [ownerId]);
    if (owner.rowCount === 0) throw new Error(`Unknown owner: ${ownerId}`);
    const state = randomBytes(32).toString('base64url');
    const now = clock.now();
    await db.query('INSERT INTO oauth_states (state, owner_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      hashState(state),
      ownerId,
      now,
      addMs(now, STATE_TTL_MS),
    ]);
    await this.log(ownerId, 'google.link_created', {});
    return `${config.publicBaseUrl.replace(/\/+$/, '')}/oauth/google/start?state=${state}`;
  }

  /** Google's consent URL for a valid, unused, unexpired state; null otherwise. */
  async consentUrl(state: string): Promise<string | null> {
    if (!STATE_FORMAT.test(state)) return null;
    const res = await this.deps.db.query('SELECT 1 FROM oauth_states WHERE state = $1 AND used_at IS NULL AND expires_at > $2', [
      hashState(state),
      this.deps.clock.now(),
    ]);
    if (res.rowCount === 0) return null;
    const c = this.deps.config;
    return url(CONSENT_URL, {
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: c.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      state,
    });
  }

  async callback(q: { state?: string; code?: string; error?: string }): Promise<CallbackResult> {
    const ownerId = q.state && STATE_FORMAT.test(q.state) ? await this.consume(q.state) : null;
    if (!ownerId) {
      await this.log(null, 'google.connect_failed', { reason: 'bad_state' });
      return { ok: false, reason: 'bad_state' };
    }
    if (q.error || !q.code) {
      const reason = q.error === 'access_denied' ? 'access_denied' : 'no_code';
      await this.log(ownerId, 'google.connect_failed', { reason });
      return { ok: false, reason };
    }
    try {
      return await this.connect(ownerId, q.code);
    } catch (err) {
      const reason = err instanceof GoogleError ? err.code : 'error';
      this.deps.log.warn({ ownerId, reason }, 'google connect failed');
      await this.log(ownerId, 'google.connect_failed', { reason });
      return { ok: false, reason };
    }
  }

  private async connect(ownerId: string, code: string): Promise<CallbackResult> {
    const { http, tokens, config } = this.deps;
    const token = await http.request<TokenResponse>({
      method: 'POST',
      url: TOKEN_URL,
      ownerId,
      form: { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, client_secret: config.clientSecret },
    });
    if (!token.refresh_token || !token.access_token) {
      await this.log(ownerId, 'google.connect_failed', { reason: 'no_refresh_token' });
      return { ok: false, reason: 'no_refresh_token' };
    }
    const scopes = (token.scope ?? '').split(/\s+/).filter((s) => s !== '');
    const capabilities = capabilitiesOf(scopes);
    let email: string | null = null;
    if (capabilities.gmailRead) {
      const profile = await http.request<{ emailAddress?: string }>({ method: 'GET', url: PROFILE_URL, ownerId, accessToken: token.access_token });
      email = typeof profile.emailAddress === 'string' ? profile.emailAddress : null;
    }
    await tokens.save(ownerId, { email, refreshToken: token.refresh_token, scopes });
    tokens.remember(ownerId, token);
    await this.log(ownerId, 'google.connected', { scopes, capabilities });
    return { ok: true, ownerId };
  }

  /** Atomically marks the state used; null if unknown, expired or already used. */
  private async consume(state: string): Promise<string | null> {
    const now = this.deps.clock.now();
    const res = await this.deps.db.query<{ owner_id: string }>(
      'UPDATE oauth_states SET used_at = $2 WHERE state = $1 AND used_at IS NULL AND expires_at > $2 RETURNING owner_id',
      [hashState(state), now],
    );
    return res.rows[0]?.owner_id ?? null;
  }

  private async log(ownerId: string | null, action: string, detail: Record<string, unknown>): Promise<void> {
    const agentId = ownerId ? await this.deps.agentOf(ownerId) : null;
    await this.deps.actionLog.write({ agentId, actor: 'system', action, detail: { ...(ownerId ? { ownerId } : {}), ...detail } });
  }
}
