import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { expect } from 'vitest';
import { parseConfig } from '../../../src/config.js';
import { createGoogle, type GoogleServices } from '../../../src/google/services.js';
import { DEFAULT_SCOPES } from '../../../src/google/scopes.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

export interface StubResponse {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export interface Expectation {
  method: string;
  /** Exact URL, or a predicate on the parsed URL. */
  url: string | ((u: URL) => boolean);
  check?: (init: RequestInit, u: URL) => void;
  respond: StubResponse | (() => StubResponse | Promise<StubResponse>);
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that serves expectations in order and fails the test on anything else. */
export class StubFetch {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Expectation[] = [];

  expect(e: Expectation): this {
    this.queue.push(e);
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : undefined;
    this.calls.push({ method, url: input, headers, body });
    const next = this.queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${method} ${input}`);
    const u = new URL(input);
    expect(method).toBe(next.method);
    if (typeof next.url === 'string') expect(input).toBe(next.url);
    else expect(next.url(u), `url ${input}`).toBe(true);
    next.check?.(init, u);
    const r = typeof next.respond === 'function' ? await next.respond() : next.respond;
    const status = r.status ?? 200;
    const text = r.json === undefined ? '' : JSON.stringify(r.json);
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
}

export const SECRETS = {
  clientSecret: 'client-secret-SHOULD-NOT-LEAK',
  refreshToken: 'refresh-token-SHOULD-NOT-LEAK',
  accessToken: 'access-token-SHOULD-NOT-LEAK',
  code: 'auth-code-SHOULD-NOT-LEAK',
};

export const ENC_KEY = randomBytes(32).toString('base64');

export interface GoogleWorld {
  w: TestWorld;
  g: GoogleServices;
  stub: StubFetch;
  /** Every pino line written. */
  logs: string[];
  /** Stores a connected account for an owner, as the callback would. */
  connect(ownerId: string, scopes?: readonly string[], email?: string | null): Promise<void>;
  close(): Promise<void>;
}

export function googleEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    TRANSPORT: 'fake',
    GOOGLE_CLIENT_ID: 'client-id.apps.example',
    GOOGLE_CLIENT_SECRET: SECRETS.clientSecret,
    GOOGLE_REDIRECT_URI: 'https://violet.example/oauth/google/callback',
    TOKEN_ENC_KEY: ENC_KEY,
    PUBLIC_BASE_URL: 'https://violet.example',
    ...extra,
  };
}

export async function createGoogleWorld(env: Record<string, string> = {}): Promise<GoogleWorld> {
  const w = await createTestWorld();
  const stub = new StubFetch();
  const logs: string[] = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => void logs.push(s) });
  const g = createGoogle({ config: parseConfig(googleEnv(env)), db: w.db, clock: w.clock, log, fetch: stub.fetch });
  g.bindFlags(w.app.flags);
  return {
    w,
    g,
    stub,
    logs,
    async connect(ownerId, scopes = DEFAULT_SCOPES, email = 'alex@example.test') {
      await g.tokens.save(ownerId, { email, refreshToken: SECRETS.refreshToken, scopes: [...scopes] });
    },
    close: () => w.close(),
  };
}

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Expect one refresh-token grant answered with SECRETS.accessToken. */
export function expectRefresh(stub: StubFetch, expiresIn = 3600, token = SECRETS.accessToken): void {
  stub.expect({
    method: 'POST',
    url: TOKEN_URL,
    check: (init) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe(SECRETS.refreshToken);
      expect(form.get('client_secret')).toBe(SECRETS.clientSecret);
    },
    respond: { json: { access_token: token, expires_in: expiresIn, token_type: 'Bearer' } },
  });
}

export function bearer(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>).authorization;
}
