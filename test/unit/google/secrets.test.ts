import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/server.js';
import { DEFAULT_SCOPES } from '../../../src/google/scopes.js';
import { createGoogleWorld, SECRETS, TOKEN_URL, type GoogleWorld } from './helpers.js';

describe('no token, secret or code leaks (I16)', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
  });
  afterEach(async () => gw.close());

  it('across connect, refresh, API errors, denial and revocation', async () => {
    const owner = gw.w.alex.owner.id;
    const server = buildServer({ ...gw.w.app, deps: { ...gw.w.app.deps, calendar: gw.g.calendar, gmail: gw.g.gmail } });
    const bodies: string[] = [];
    const errors: unknown[] = [];
    const attempt = (p: Promise<unknown>) => p.catch((e: unknown) => void errors.push(e));

    // Connect (code exchange + profile).
    const link = await gw.g.oauth.createConnectLink(owner);
    const state = new URL(link).searchParams.get('state')!;
    gw.stub.expect({
      method: 'POST',
      url: TOKEN_URL,
      respond: { json: { access_token: SECRETS.accessToken, refresh_token: SECRETS.refreshToken, expires_in: 3600, scope: DEFAULT_SCOPES.join(' ') } },
    });
    gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/profile'), respond: { json: { emailAddress: 'alex@example.test' } } });
    bodies.push((await server.inject({ method: 'GET', url: `/oauth/google/callback?state=${state}&code=${SECRETS.code}` })).body);
    // Reusing the code fails without echoing it.
    bodies.push((await server.inject({ method: 'GET', url: `/oauth/google/callback?state=${state}&code=${SECRETS.code}` })).body);

    // API error whose body echoes secrets back.
    gw.stub.expect({
      method: 'GET',
      url: (u) => u.pathname.endsWith('/messages'),
      respond: { status: 400, json: { error: { code: 400, message: `bad token ${SECRETS.accessToken} ${SECRETS.refreshToken}`, status: 'INVALID_ARGUMENT' } } },
    });
    await attempt(gw.g.gmail.search(owner, 'x', 1));

    // Denied call carrying a token in its query.
    await attempt(gw.g.http.request({ method: 'GET', url: `https://gmail.googleapis.com/gmail/v1/users/me/profile?access_token=${SECRETS.accessToken}`, ownerId: owner }));

    // Expire the cached token, then the refresh is refused: revoked.
    gw.w.clock.advance({ hours: 2 });
    gw.stub.expect({
      method: 'POST',
      url: TOKEN_URL,
      respond: { status: 400, json: { error: 'invalid_grant', error_description: `refresh ${SECRETS.refreshToken} revoked` } },
    });
    await attempt(gw.g.calendar.listEvents(owner, gw.w.clock.now(), gw.w.clock.now()));
    expect(gw.stub.pending).toBe(0);
    expect(errors).toHaveLength(3);

    const actions = JSON.stringify(await gw.w.actions());
    const flags = JSON.stringify(await gw.w.app.repos.flags.listByAgent(gw.w.alex.agent.id));
    const db = JSON.stringify((await gw.w.db.query('SELECT * FROM google_accounts')).rows) + JSON.stringify((await gw.w.db.query('SELECT * FROM oauth_states')).rows);
    const errorText = errors.map((e) => `${(e as Error).message} ${(e as { safeMessage?: string }).safeMessage} ${(e as Error).stack}`).join('\n');
    const texts = JSON.stringify(gw.w.transport.sent);
    expect(gw.logs.length).toBeGreaterThan(0);
    for (const [name, secret] of Object.entries(SECRETS)) {
      for (const [where, text] of Object.entries({ logs: gw.logs.join('\n'), actions, flags, db, html: bodies.join('\n'), errors: errorText, texts })) {
        expect(text.includes(secret), `${name} found in ${where}`).toBe(false);
      }
    }
    expect(db).not.toContain(state);
    await server.close();
  });
});
