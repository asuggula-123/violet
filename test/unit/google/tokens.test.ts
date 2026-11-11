import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleAuthError, GoogleError, GoogleNotConnectedError, GoogleRateLimitedError, GoogleScopeMissingError, GoogleTransientError } from '../../../src/google/errors.js';
import { capabilitiesOf, DEFAULT_SCOPES, parseScopes } from '../../../src/google/scopes.js';
import { REVOKED_FLAG_TEXT } from '../../../src/google/tokens.js';
import { bearer, createGoogleWorld, expectRefresh, SECRETS, TOKEN_URL, type GoogleWorld } from './helpers.js';

const A = 'https://www.googleapis.com/auth/';
const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

describe('scopes → capabilities', () => {
  it('defaults and GOOGLE_SCOPES parsing', () => {
    expect(parseScopes(undefined)).toEqual(DEFAULT_SCOPES);
    expect(parseScopes('  ')).toEqual(DEFAULT_SCOPES);
    expect(parseScopes(`${A}calendar.readonly  ${A}gmail.compose ${A}gmail.compose`)).toEqual([`${A}calendar.readonly`, `${A}gmail.compose`]);
  });

  it('the default grant gives every capability', () => {
    expect(capabilitiesOf(DEFAULT_SCOPES)).toEqual({ calendarFreeBusy: true, calendarRead: true, calendarWrite: true, gmailRead: true, gmailDraft: true });
  });

  it('partial grants give only what was granted', () => {
    expect(capabilitiesOf([`${A}calendar.freebusy`])).toEqual({
      calendarFreeBusy: true,
      calendarRead: false,
      calendarWrite: false,
      gmailRead: false,
      gmailDraft: false,
    });
    expect(capabilitiesOf([`${A}calendar.events.owned.readonly`, `${A}gmail.drafts.create`])).toEqual({
      calendarFreeBusy: false,
      calendarRead: true,
      calendarWrite: false,
      gmailRead: false,
      gmailDraft: true,
    });
    expect(capabilitiesOf([`${A}gmail.compose`]).gmailDraft).toBe(true);
    expect(capabilitiesOf([`${A}gmail.compose`]).gmailRead).toBe(false);
    expect(capabilitiesOf([`${A}gmail.metadata`]).gmailRead).toBe(false);
    expect(capabilitiesOf(['openid', 'email'])).toEqual({ calendarFreeBusy: false, calendarRead: false, calendarWrite: false, gmailRead: false, gmailDraft: false });
  });
});

describe('TokenStore', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
  });
  afterEach(async () => gw.close());

  const owner = () => gw.w.alex.owner.id;
  const profile = () => gw.g.gmail.search(owner(), 'x', 0);

  it('stores the refresh token encrypted', async () => {
    await gw.connect(owner());
    const row = await gw.w.db.query<{ refresh_token_enc: string; scopes: string; email: string }>('SELECT * FROM google_accounts');
    expect(row.rows[0]!.refresh_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify(row.rows)).not.toContain(SECRETS.refreshToken);
    expect(row.rows[0]!.scopes).toBe(DEFAULT_SCOPES.join(' '));
    expect((await gw.g.tokens.account(owner()))?.capabilities.gmailDraft).toBe(true);
  });

  it('refreshes once, caches until expiry (Clock), then refreshes again', async () => {
    await gw.connect(owner());
    expectRefresh(gw.stub, 3600);
    expect(await gw.g.tokens.accessToken(owner())).toBe(SECRETS.accessToken);
    expect(await gw.g.tokens.accessToken(owner())).toBe(SECRETS.accessToken);
    expect(gw.stub.calls).toHaveLength(1);
    gw.w.clock.advance({ minutes: 58 });
    expect(await gw.g.tokens.accessToken(owner())).toBe(SECRETS.accessToken);
    expect(gw.stub.calls).toHaveLength(1);
    gw.w.clock.advance({ minutes: 1, seconds: 1 }); // inside the 60 s safety margin
    expectRefresh(gw.stub, 3600, 'second-token');
    expect(await gw.g.tokens.accessToken(owner())).toBe('second-token');
    expect(gw.stub.calls).toHaveLength(2);
  });

  it('single-flight: concurrent callers share one refresh per owner', async () => {
    await gw.connect(owner());
    await gw.connect(gw.w.sam.owner.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: async () => (await gate, { json: { access_token: 'alex-token', expires_in: 3600 } }) });
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { json: { access_token: 'sam-token', expires_in: 3600 } } });
    const alex = Promise.all([1, 2, 3, 4, 5].map(() => gw.g.tokens.accessToken(owner())));
    await new Promise((r) => setTimeout(r, 10));
    const sam = await gw.g.tokens.accessToken(gw.w.sam.owner.id);
    release();
    expect(await alex).toEqual(Array(5).fill('alex-token'));
    expect(sam).toBe('sam-token');
    expect(gw.stub.calls).toHaveLength(2);
  });

  it('a failed refresh is not cached and is not retried blindly', async () => {
    await gw.connect(owner());
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 503, json: { error: 'temporarily_unavailable' } } });
    const err = await gw.g.tokens.accessToken(owner()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleTransientError);
    expect((err as GoogleError).retryable).toBe(true);
    expect(gw.stub.calls).toHaveLength(1);
    expectRefresh(gw.stub);
    expect(await gw.g.tokens.accessToken(owner())).toBe(SECRETS.accessToken);
  });

  it('invalid_grant → account revoked, exactly one now-flag, typed GoogleAuthError', async () => {
    await gw.connect(owner());
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } });
    const results = await Promise.all([1, 2, 3].map(() => gw.g.tokens.accessToken(owner()).catch((e: unknown) => e)));
    for (const r of results) {
      expect(r).toBeInstanceOf(GoogleAuthError);
      expect((r as GoogleAuthError).safeMessage).toBe('Google access expired — reconnect needed.');
    }
    // Later calls fail fast without touching Google, and raise nothing new.
    await expect(gw.g.calendar.listEvents(owner(), gw.w.clock.now(), gw.w.clock.now())).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(gw.g.tokens.accessToken(owner())).rejects.toBeInstanceOf(GoogleAuthError);
    expect(gw.stub.calls).toHaveLength(1);
    expect((await gw.g.tokens.account(owner()))?.revokedAt).toEqual(gw.w.clock.now());
    expect(gw.w.textsTo(gw.w.alex.address)).toEqual([REVOKED_FLAG_TEXT]);
    const flags = await gw.w.app.repos.flags.listByAgent(gw.w.alex.agent.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'google.revoked', urgency: 'now', status: 'sent' });
    expect(await gw.w.actions({ action: 'google.revoked' })).toHaveLength(1);
  });

  it('an undecryptable refresh token → typed GoogleAuthError, one flag, no Google call, account not revoked', async () => {
    await gw.connect(owner());
    await gw.w.db.query("UPDATE google_accounts SET refresh_token_enc = 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'");
    for (let i = 0; i < 3; i += 1) {
      const err = await gw.g.calendar.listEvents(owner(), gw.w.clock.now(), gw.w.clock.now()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleAuthError);
      expect(err).toMatchObject({ code: 'auth', reason: 'undecryptable', safeMessage: 'Google access expired — reconnect needed.' });
    }
    expect(gw.stub.calls).toEqual([]);
    // Not revoked: restoring the right TOKEN_ENC_KEY recovers the account.
    expect((await gw.g.tokens.account(owner()))?.revokedAt).toBeNull();
    expect(gw.w.textsTo(gw.w.alex.address)).toEqual([REVOKED_FLAG_TEXT]);
    const flags = await gw.w.app.repos.flags.listByAgent(gw.w.alex.agent.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'google.undecryptable', urgency: 'now' });
  });

  it('a reconnect clears the revocation and a later revocation flags again', async () => {
    await gw.connect(owner());
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant' } } });
    await gw.g.tokens.accessToken(owner()).catch(() => undefined);
    gw.w.clock.advance({ days: 1 });
    await gw.connect(owner());
    expect((await gw.g.tokens.account(owner()))?.revokedAt).toBeNull();
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant' } } });
    await gw.g.tokens.accessToken(owner()).catch(() => undefined);
    expect(gw.w.textsTo(gw.w.alex.address)).toEqual([REVOKED_FLAG_TEXT, REVOKED_FLAG_TEXT]);
  });

  it('no account → GoogleNotConnectedError with a safe message', async () => {
    const err = await gw.g.calendar.freeBusy(owner(), gw.w.clock.now(), gw.w.clock.now()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleNotConnectedError);
    expect((err as GoogleError).code).toBe('not_connected');
    expect((err as GoogleError).safeMessage).toBe("Google isn't connected yet. Ask me for a connect link.");
    expect(gw.stub.calls).toEqual([]);
  });

  it('missing capability → GoogleScopeMissingError before any network call', async () => {
    await gw.connect(owner(), [`${A}calendar.freebusy`]);
    for (const call of [
      () => gw.g.calendar.listEvents(owner(), gw.w.clock.now(), gw.w.clock.now()),
      () => gw.g.calendar.createEvent(owner(), { title: 't', start: gw.w.clock.now(), end: gw.w.clock.now() }, 'k'),
      () => gw.g.calendar.deleteEvent(owner(), 'abcde'),
      () => gw.g.gmail.getMessage(owner(), 'abc'),
      () => gw.g.gmail.createDraft(owner(), { to: ['sam@example.test'], subject: 's', body: 'b' }),
      profile,
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleScopeMissingError);
      expect((err as GoogleError).safeMessage).toMatch(/^Google didn't give me permission to .+\. Reconnect Google and allow it\.$/);
    }
    expect(gw.stub.calls).toEqual([]);
  });

  it('a 403 insufficient-scope answer maps to GoogleScopeMissingError with the capability', async () => {
    await gw.connect(owner());
    expectRefresh(gw.stub);
    gw.stub.expect({
      method: 'GET',
      url: (u) => u.pathname.endsWith('/messages'),
      respond: { status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } },
    });
    const err = (await profile().catch((e: unknown) => e)) as GoogleScopeMissingError;
    expect(err).toBeInstanceOf(GoogleScopeMissingError);
    expect(err.capability).toBe('gmailRead');
  });

  it('a 401 drops the cached token and retries exactly once with a fresh one', async () => {
    await gw.connect(owner());
    expectRefresh(gw.stub, 3600, 'stale');
    gw.stub.expect({ method: 'GET', url: PROFILE.replace('profile', 'messages?q=x&maxResults=1'), check: (i) => expect(bearer(i)).toBe('Bearer stale'), respond: { status: 401, json: { error: { code: 401, status: 'UNAUTHENTICATED' } } } });
    expectRefresh(gw.stub, 3600, 'fresh');
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/messages'), check: (i) => expect(bearer(i)).toBe('Bearer fresh'), respond: { json: {} } });
    expect(await profile()).toEqual([]);
    expect(gw.stub.pending).toBe(0);

    // Two 401s in a row: GoogleAuthError, no third attempt.
    gw.g.tokens.invalidate(owner(), 'fresh');
    expectRefresh(gw.stub, 3600, 'a');
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/messages'), respond: { status: 401, json: {} } });
    expectRefresh(gw.stub, 3600, 'b');
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/messages'), respond: { status: 401, json: {} } });
    await expect(profile()).rejects.toBeInstanceOf(GoogleAuthError);
    expect(gw.stub.pending).toBe(0);
  });

  it('429 → GoogleRateLimitedError with Retry-After, and no retry', async () => {
    await gw.connect(owner());
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/messages'), respond: { status: 429, headers: { 'retry-after': '30' }, json: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } });
    const err = (await profile().catch((e: unknown) => e)) as GoogleRateLimitedError;
    expect(err).toBeInstanceOf(GoogleRateLimitedError);
    expect(err.retryAfterSec).toBe(30);
    expect(err.retryable).toBe(true);
    expect(gw.stub.pending).toBe(0);
    expect(gw.stub.calls).toHaveLength(2);
  });

  it('403 userRateLimitExceeded is rate limiting too; network failure is transient', async () => {
    await gw.connect(owner());
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/messages'), respond: { status: 403, json: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } });
    await expect(profile()).rejects.toBeInstanceOf(GoogleRateLimitedError);
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/messages'), respond: () => Promise.reject(new Error('ECONNRESET')) });
    await expect(profile()).rejects.toBeInstanceOf(GoogleTransientError);
  });
});
