import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/server.js';
import { DEFAULT_SCOPES } from '../../../src/google/scopes.js';
import { bearer, createGoogleWorld, SECRETS, TOKEN_URL, type GoogleWorld } from './helpers.js';

const A = 'https://www.googleapis.com/auth/';
const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

describe('Google OAuth connect', () => {
  let gw: GoogleWorld;
  let server: FastifyInstance;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    server = buildServer({ ...gw.w.app, deps: { ...gw.w.app.deps, calendar: gw.g.calendar, gmail: gw.g.gmail } });
  });
  afterEach(async () => {
    await server.close();
    await gw.close();
  });

  const owner = () => gw.w.alex.owner.id;
  const stateOf = (link: string) => new URL(link).searchParams.get('state')!;

  function expectExchange(scope: string, extra: Record<string, unknown> = {}) {
    gw.stub.expect({
      method: 'POST',
      url: TOKEN_URL,
      check: (init) => {
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
        const form = new URLSearchParams(String(init.body));
        expect(Object.fromEntries(form)).toEqual({
          grant_type: 'authorization_code',
          code: SECRETS.code,
          redirect_uri: 'https://violet.example/oauth/google/callback',
          client_id: 'client-id.apps.example',
          client_secret: SECRETS.clientSecret,
        });
        expect(bearer(init)).toBeUndefined();
      },
      respond: {
        json: { access_token: SECRETS.accessToken, expires_in: 3599, refresh_token: SECRETS.refreshToken, scope, token_type: 'Bearer', ...extra },
      },
    });
  }

  const callback = (state: string, code = SECRETS.code) =>
    server.inject({ method: 'GET', url: `/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}` });

  it('createConnectLink: single-use state, 15 minutes, only its hash stored', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    expect(link).toMatch(/^https:\/\/violet\.example\/oauth\/google\/start\?state=[A-Za-z0-9_-]{43}$/);
    const rows = await gw.w.db.query<{ state: string; owner_id: string; expires_at: Date; used_at: Date | null }>('SELECT * FROM oauth_states');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.state).not.toBe(stateOf(link));
    expect(rows.rows[0]).toMatchObject({ owner_id: owner(), used_at: null });
    expect(rows.rows[0]!.expires_at.getTime() - gw.w.clock.now().getTime()).toBe(15 * 60_000);
    await expect(gw.g.oauth.createConnectLink('no-such-owner')).rejects.toThrow(/Unknown owner/);
  });

  it('GET /oauth/google/start redirects to Google consent with the right parameters', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    const res = await server.inject({ method: 'GET', url: new URL(link).pathname + new URL(link).search });
    expect(res.statusCode).toBe(302);
    const target = new URL(res.headers.location as string);
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: 'client-id.apps.example',
      redirect_uri: 'https://violet.example/oauth/google/callback',
      response_type: 'code',
      scope: DEFAULT_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: stateOf(link),
    });
    expect(gw.stub.calls).toEqual([]);
  });

  it('start refuses unknown, malformed, expired and used states', async () => {
    for (const s of ['', 'nope', 'x'.repeat(43)]) {
      const res = await server.inject({ method: 'GET', url: `/oauth/google/start?state=${s}` });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('expired or was already used');
    }
    const link = await gw.g.oauth.createConnectLink(owner());
    gw.w.clock.advance({ minutes: 15 });
    expect((await server.inject({ method: 'GET', url: `/oauth/google/start?state=${stateOf(link)}` })).statusCode).toBe(400);
  });

  it('callback happy path: exchanges the code, reads email, stores encrypted token, logs google.connected', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    expectExchange(DEFAULT_SCOPES.join(' '));
    gw.stub.expect({
      method: 'GET',
      url: PROFILE,
      check: (init) => expect(bearer(init)).toBe(`Bearer ${SECRETS.accessToken}`),
      respond: { json: { emailAddress: 'alex@example.test', messagesTotal: 3 } },
    });
    const res = await callback(stateOf(link));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toContain('Connected. You can close this tab.');
    const account = await gw.g.tokens.account(owner());
    expect(account).toMatchObject({ email: 'alex@example.test', scopes: [...DEFAULT_SCOPES], revokedAt: null });
    const connected = await gw.w.actions({ action: 'google.connected' });
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ agent_id: gw.w.alex.agent.id, detail: { ownerId: owner(), capabilities: { gmailRead: true } } });
    // The access token from the exchange is cached: the next call does not refresh.
    gw.stub.expect({ method: 'POST', url: (u) => u.pathname.endsWith('/freeBusy'), respond: { json: { calendars: { primary: { busy: [] } } } } });
    expect(await gw.g.calendar.freeBusy(owner(), gw.w.clock.now(), gw.w.clock.now())).toEqual([]);
    expect(gw.stub.pending).toBe(0);
  });

  it('a state can be used only once', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    expectExchange(`${A}calendar.freebusy`);
    expect((await callback(stateOf(link))).statusCode).toBe(200);
    const again = await callback(stateOf(link));
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain('expired or was already used');
    expect(gw.stub.calls).toHaveLength(1);
  });

  it('concurrent callbacks with one state: exactly one wins', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    expectExchange(`${A}calendar.freebusy`);
    const results = await Promise.all([1, 2, 3].map(() => gw.g.oauth.callback({ state: stateOf(link), code: SECRETS.code })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(gw.stub.calls).toHaveLength(1);
  });

  it('expired, unknown or missing state → plain error page, no exchange', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    gw.w.clock.advance({ minutes: 15, seconds: 1 });
    expect((await callback(stateOf(link))).statusCode).toBe(400);
    expect((await callback('A'.repeat(43))).statusCode).toBe(400);
    const missing = await server.inject({ method: 'GET', url: `/oauth/google/callback?code=${SECRETS.code}` });
    expect(missing.statusCode).toBe(400);
    expect(gw.stub.calls).toEqual([]);
    expect(await gw.w.actions({ action: 'google.connect_failed' })).toHaveLength(3);
  });

  it('partial grant: no Gmail read → no profile call, email null, capabilities follow the grant', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    expectExchange(`${A}calendar.freebusy ${A}gmail.drafts.create`);
    expect((await callback(stateOf(link))).statusCode).toBe(200);
    const account = await gw.g.tokens.account(owner());
    expect(account?.email).toBeNull();
    expect(account?.capabilities).toEqual({ calendarFreeBusy: true, calendarRead: false, calendarWrite: false, gmailRead: false, gmailDraft: true });
    expect(gw.stub.calls).toHaveLength(1);
  });

  it('user cancelled at Google → state consumed, cancelled page', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    const res = await server.inject({ method: 'GET', url: `/oauth/google/callback?state=${stateOf(link)}&error=access_denied` });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('cancelled');
    expect((await callback(stateOf(link))).statusCode).toBe(400);
    expect(gw.stub.calls).toEqual([]);
  });

  it('Google refusing the code or omitting the refresh token → plain failure page without internals', async () => {
    const link = await gw.g.oauth.createConnectLink(owner());
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } } });
    const res = await callback(stateOf(link));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Couldn't connect Google.");
    expect(res.body).not.toMatch(/invalid_grant|Bad Request|Error|stack/);

    const link2 = await gw.g.oauth.createConnectLink(owner());
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { json: { access_token: SECRETS.accessToken, expires_in: 3599, scope: `${A}calendar.freebusy` } } });
    expect((await callback(stateOf(link2))).statusCode).toBe(400);
    expect(await gw.g.tokens.account(owner())).toBeNull();
    const failed = await gw.w.actions({ action: 'google.connect_failed' });
    expect(failed.map((r) => r.detail.reason)).toEqual(['auth', 'no_refresh_token']);
  });

  it('routes are not registered when Google is not configured', async () => {
    const plain = buildServer(gw.w.app);
    const res = await plain.inject({ method: 'GET', url: '/oauth/google/start?state=x' });
    expect(res.statusCode).toBe(404);
    await plain.close();
  });
});
