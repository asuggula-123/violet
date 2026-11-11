/** Verifier (M3) round 2: adversarial tests re-checking the round-1 fixes and new edges. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config.js';
import { checkAllowed } from '../../../src/google/allowlist.js';
import { eventIdFor } from '../../../src/google/calendar.js';
import { decryptToken, encryptToken, parseEncKey } from '../../../src/google/crypto.js';
import { buildRawDraft } from '../../../src/google/draft.js';
import {
  GoogleAuthError,
  GoogleDeniedError,
  GoogleError,
  GoogleInvalidInputError,
  GoogleNotConnectedError,
  GoogleRequestError,
  GoogleScopeMissingError,
  GoogleTransientError,
} from '../../../src/google/errors.js';
import { bodyText, htmlToText, MAX_BODY_CHARS } from '../../../src/google/mime.js';
import { createGoogle } from '../../../src/google/services.js';
import { dateInZone, dateTimeInZone } from '../../../src/google/time.js';
import { createGoogleWorld, ENC_KEY, expectRefresh, googleEnv, SECRETS, StubFetch, TOKEN_URL, type GoogleWorld } from '../../unit/google/helpers.js';

const A = 'https://www.googleapis.com/auth/';
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EV = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('verify M3 r2: allow-list', () => {
  const forbidden: [string, string][] = [
    // method case and unlisted methods
    ['post', `${G}/drafts`],
    ['Post', `${G}/drafts`],
    ['get', `${G}/messages`],
    ['delete', `${EV}/abcde`],
    ['PUT', `${EV}/abcde`],
    ['PATCH', `${EV}/abcde`],
    ['GET', `${EV}/abcde`],
    ['HEAD', `${G}/messages`],
    ['OPTIONS', `${G}/drafts`],
    ['DELETE', EV],
    ['DELETE', `${EV}/abcde/`],
    ['DELETE', `${G}/messages/abc`],
    ['DELETE', `${G}/drafts/abc`],
    ['PUT', `${G}/drafts/abc`],
    ['GET', `${G}/drafts`],
    ['GET', `${G}/drafts/abc`],
    // calendar paths not on the list
    ['POST', `${EV}/import`],
    ['POST', `${EV}/quickAdd?text=x`],
    ['POST', `${EV}/watch`],
    ['POST', `${EV}/abcde/move?destination=x`],
    ['GET', `${EV}/abcde/instances`],
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/other/events'],
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/Primary/events'],
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/primary%40x/events'],
    ['POST', 'https://www.googleapis.com/calendar/v3/users/me/calendarList'],
    ['DELETE', 'https://www.googleapis.com/calendar/v3/calendars/primary'],
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/clear'],
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/acl'],
    // gmail paths not on the list
    ['GET', 'https://gmail.googleapis.com/gmail/v1/users/alex/messages'],
    ['GET', 'https://gmail.googleapis.com/gmail/v1/users/ME/messages'],
    ['GET', 'https://gmail.googleapis.com/gmail/v1/users/me%20/messages'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/someone/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v2/users/me/drafts'],
    ['POST', `${G}/messages/abc/trash`],
    ['POST', `${G}/messages/abc/modify`],
    ['POST', `${G}/threads/abc/trash`],
    ['POST', `${G}/settings/forwardingAddresses`],
    ['PUT', `${G}/settings/autoForwarding`],
    ['POST', `${G}/settings/filters`],
    ['POST', `${G}/stop`],
    ['POST', `${G}/watch`],
    ['GET', `${G}/messages/abc/attachments/def`],
    // OAuth host variants
    ['POST', 'https://oauth2.googleapis.com/revoke'],
    ['POST', 'https://oauth2.googleapis.com/token/'],
    ['POST', 'https://oauth2.googleapis.com/Token'],
    ['GET', 'https://oauth2.googleapis.com/token'],
    ['POST', 'https://accounts.google.com/o/oauth2/token'],
    ['POST', 'https://www.googleapis.com/oauth2/v4/token'],
    ['POST', 'https://oauth2.googleapis.com/token?access_type=offline'],
    // hosts
    ['POST', 'https://142.250.0.1/gmail/v1/users/me/drafts'],
    ['POST', 'https://[::1]/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com%2e/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail%2egoogleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https:/gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https:///gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'HTTPS://gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', ' https://gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts '],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts\r\n'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/dr\u0000afts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts­'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drаfts'], // Cyrillic a
    ['POST', '//gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', '/gmail/v1/users/me/drafts'],
    // query smuggling / pinned values
    ['POST', `${EV}?sendUpdates=all`],
    ['POST', `${EV}?sendUpdates=externalOnly`],
    ['POST', `${EV}?sendUpdates=NONE`],
    ['POST', `${EV}?sendUpdates=none&sendUpdates=all`],
    ['POST', `${EV}?sendUpdates=none%26sendUpdates%3Dall`],
    ['POST', `${EV}?sendUpdates=`],
    ['POST', `${EV}?sendNotifications=true`],
    ['POST', `${EV}?conferenceDataVersion=1`],
    ['POST', `${EV}?supportsAttachments=true`],
    ['DELETE', `${EV}/abcde?sendUpdates=all`],
    ['DELETE', `${EV}/abcde?sendUpdates=none&sendUpdates=all`],
    ['DELETE', `${EV}/abcde?sendNotifications=true`],
    ['GET', `${EV}?q=x&fields=items`],
    ['GET', `${EV}?key=x`],
    ['GET', `${G}/messages?q=x&includeSpamTrash=true&userId=other`],
    ['GET', `${G}/messages/abc?format=raw&access_token=x`],
    ['POST', `${G}/drafts?prettyPrint=false`],
    ['POST', `${G}/drafts?quotaUser=x`],
    // ids
    ['DELETE', `${EV}/${'a'.repeat(1025)}`],
    ['GET', `${G}/messages/a.b`],
    ['GET', `${G}/messages/a~b`],
    ['GET', `${G}/messages/${encodeURIComponent('../drafts/send')}`],
    ['GET', `${G}/messages/${encodeURIComponent('abc?x=1')}`],
  ];

  it.each(forbidden)('%s %s is denied', (method, url) => {
    expect(() => checkAllowed(method, url)).toThrow(GoogleDeniedError);
  });

  it('denied calls through GoogleHttp never reach fetch and each writes one google.denied row', async () => {
    const gw = await createGoogleWorld();
    try {
      let n = 0;
      for (const [method, url] of forbidden.filter(([, u]) => !u.includes('\u0000'))) {
        await expect(gw.g.http.request({ method, url, ownerId: gw.w.alex.owner.id, accessToken: SECRETS.accessToken })).rejects.toBeInstanceOf(GoogleDeniedError);
        n += 1;
      }
      expect(gw.stub.calls).toEqual([]);
      const rows = await gw.w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM action_log WHERE action = 'google.denied'");
      expect(rows.rows[0]!.n).toBe(n);
      const dump = JSON.stringify((await gw.w.db.query('SELECT * FROM action_log')).rows) + gw.logs.join('');
      expect(dump).not.toContain(SECRETS.accessToken);
    } finally {
      await gw.close();
    }
  });

  it('a denied URL containing a NUL is still a GoogleDeniedError and still audited (I15)', async () => {
    const gw = await createGoogleWorld();
    try {
      const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send\u0000';
      await expect(gw.g.http.request({ method: 'POST', url, ownerId: gw.w.alex.owner.id })).rejects.toBeInstanceOf(GoogleDeniedError);
      expect(gw.stub.calls).toEqual([]);
      const rows = await gw.w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM action_log WHERE action = 'google.denied'");
      expect(rows.rows[0]!.n).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it('allowed calls pass with the exact sendUpdates=none value', () => {
    expect(() => checkAllowed('POST', `${EV}?sendUpdates=none`)).not.toThrow();
    expect(() => checkAllowed('DELETE', `${EV}/abcde?sendUpdates=none`)).not.toThrow();
    expect(() => checkAllowed('DELETE', `${EV}/abc_20261111T100000Z?sendUpdates=none`)).not.toThrow();
  });
});

describe('verify M3 r2: providers with hostile ids reach nothing', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    await gw.connect(gw.w.alex.owner.id);
  });
  afterEach(async () => gw.close());
  const o = () => gw.w.alex.owner.id;
  const nonToken = () => gw.stub.calls.filter((c) => c.url !== TOKEN_URL);

  it.each([['../drafts/send'], ['abc/send'], ['abc?format=raw'], ['abc#x'], ['abc/../../drafts'], ['']])(
    'createDraft replying to %j makes no draft and no off-list call',
    async (id) => {
      expectRefresh(gw.stub);
      const err = await gw.g.gmail.createDraft(o(), { to: ['sam@example.test'], subject: 'Re', body: 'b', replyToMessageId: id }).catch((e: unknown) => e);
      // '' is falsy and means "not a reply": then exactly one drafts POST is fine.
      if (id === '') return;
      expect(err).toBeInstanceOf(GoogleError);
      expect(nonToken()).toEqual([]);
    },
  );

  it.each([['abc/send'], ['abc?sendUpdates=all'], ['..'], ['abc%2Fsend']])('deleteEvent(%j) is denied, nothing sent', async (id) => {
    expectRefresh(gw.stub);
    await expect(gw.g.calendar.deleteEvent(o(), id)).rejects.toBeInstanceOf(GoogleDeniedError);
    expect(nonToken()).toEqual([]);
  });
});

describe('verify M3 r2: tokens', () => {
  it('ciphertext format: version prefix, part count and tag are all enforced', () => {
    const key = parseEncKey(ENC_KEY);
    const sealed = encryptToken(key, 'tok', 'aad');
    const [, iv, ct, tag] = sealed.split('.');
    for (const bad of [`v2.${iv}.${ct}.${tag}`, `V1.${iv}.${ct}.${tag}`, `v1.${iv}.${ct}`, `v1.${iv}.${ct}.${tag}.x`, `v1..${ct}.${tag}`, `v1.${iv}.${ct}.`, '', 'tok']) {
      expect(() => decryptToken(key, bad, 'aad')).toThrow();
    }
    expect(() => decryptToken(key, sealed, 'other')).toThrow();
    expect(decryptToken(key, sealed, 'aad')).toBe('tok');
  });

  it.each([[undefined], [''], ['  '], [Buffer.alloc(31).toString('base64')], [Buffer.alloc(33).toString('base64')], [Buffer.alloc(32).toString('hex')], ['not base64!!']])(
    'TOKEN_ENC_KEY %j is refused with a clear error',
    (raw) => {
      expect(() => parseEncKey(raw)).toThrow(/TOKEN_ENC_KEY/);
    },
  );

  it('createGoogle refuses a malformed key instead of running unencrypted', () => {
    expect(() =>
      createGoogle({ config: parseConfig(googleEnv({ TOKEN_ENC_KEY: 'short' })), db: null as never, clock: null as never, log: pino({ level: 'silent' }) }),
    ).toThrow(/TOKEN_ENC_KEY/);
  });

  it('an undecryptable token, called repeatedly, raises exactly one flag and makes no Google call', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o);
      await gw.w.db.query("UPDATE google_accounts SET refresh_token_enc = 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'");
      for (let i = 0; i < 4; i += 1) {
        const err = await gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(GoogleAuthError);
        expect((err as GoogleAuthError).safeMessage).toMatch(/reconnect/);
      }
      expect(gw.stub.calls).toEqual([]);
      const f = await gw.w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM flags');
      expect(f.rows[0]!.n).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it('invalid_grant: one flag per connection; a reconnect then a second revocation raises a second flag', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o);
      gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant' } } });
      await expect(gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now())).rejects.toBeInstanceOf(GoogleAuthError);
      // Revoked: further calls fail typed without any Google call and without new flags.
      await expect(gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now())).rejects.toBeInstanceOf(GoogleAuthError);
      expect(gw.stub.calls).toHaveLength(1);
      let f = await gw.w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM flags WHERE kind = 'google.revoked'");
      expect(f.rows[0]!.n).toBe(1);
      gw.w.clock.advance(60_000);
      await gw.connect(o);
      gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant' } } });
      await expect(gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now())).rejects.toBeInstanceOf(GoogleAuthError);
      f = await gw.w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM flags WHERE kind = 'google.revoked'");
      expect(f.rows[0]!.n).toBe(2);
    } finally {
      await gw.close();
    }
  });

  it('access token cache honours the Clock and refreshes once per expiry window', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o);
      expectRefresh(gw.stub, 3600, 'access-1');
      const list = (token: string) =>
        gw.stub.expect({ method: 'GET', url: () => true, check: (init) => expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`), respond: { json: { items: [] } } });
      list('access-1');
      list('access-1');
      await Promise.all([gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now()), gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now())]);
      gw.w.clock.advance(3600_000 - 61_000);
      list('access-1');
      await gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now());
      gw.w.clock.advance(2_000);
      expectRefresh(gw.stub, 3600, 'access-2');
      list('access-2');
      await gw.g.calendar.listEvents(o, gw.w.clock.now(), gw.w.clock.now());
      expect(gw.stub.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
      expect(gw.stub.pending).toBe(0);
    } finally {
      await gw.close();
    }
  });

  it('no account → GoogleNotConnectedError with a safe message, no network call', async () => {
    const gw = await createGoogleWorld();
    try {
      const err = await gw.g.gmail.search(gw.w.sam.owner.id, 'x', 5).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleNotConnectedError);
      expect((err as GoogleError).safeMessage).not.toMatch(/owner|sam/i);
      expect(gw.stub.calls).toEqual([]);
    } finally {
      await gw.close();
    }
  });
});

describe('verify M3 r2: OAuth', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
  });
  afterEach(async () => gw.close());
  const stateOf = (link: string) => new URL(link).searchParams.get('state')!;

  it('two service instances racing one state on the same DB: exactly one exchange', async () => {
    const link = await gw.g.oauth.createConnectLink(gw.w.alex.owner.id);
    const state = stateOf(link);
    const stub2 = new StubFetch();
    const g2 = createGoogle({ config: parseConfig(googleEnv()), db: gw.w.db, clock: gw.w.clock, log: pino({ level: 'silent' }), fetch: stub2.fetch });
    const ok = { json: { access_token: SECRETS.accessToken, refresh_token: SECRETS.refreshToken, expires_in: 3600, scope: `${A}calendar.freebusy` } };
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: ok });
    stub2.expect({ method: 'POST', url: TOKEN_URL, respond: ok });
    const rs = await Promise.all([
      gw.g.oauth.callback({ state, code: SECRETS.code }),
      g2.oauth.callback({ state, code: SECRETS.code }),
      gw.g.oauth.callback({ state, code: SECRETS.code }),
      g2.oauth.callback({ state, code: SECRETS.code }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(gw.stub.calls.length + stub2.calls.length).toBe(1);
  });

  it('a state is bound to its owner: the callback connects that owner only', async () => {
    const link = await gw.g.oauth.createConnectLink(gw.w.sam.owner.id);
    gw.stub.expect({
      method: 'POST',
      url: TOKEN_URL,
      respond: { json: { access_token: SECRETS.accessToken, refresh_token: SECRETS.refreshToken, expires_in: 3600, scope: `${A}calendar.freebusy` } },
    });
    expect(await gw.g.oauth.callback({ state: stateOf(link), code: SECRETS.code })).toEqual({ ok: true, ownerId: gw.w.sam.owner.id });
    expect(await gw.g.tokens.account(gw.w.alex.owner.id)).toBeNull();
    const acct = await gw.g.tokens.account(gw.w.sam.owner.id);
    expect(acct?.capabilities).toEqual({ calendarFreeBusy: true, calendarRead: false, calendarWrite: false, gmailRead: false, gmailDraft: false });
    expect(acct?.email).toBeNull();
  });

  it('an invented state of the right shape is refused without a code exchange', async () => {
    const fake = 'A'.repeat(43);
    expect(await gw.g.oauth.consentUrl(fake)).toBeNull();
    expect(await gw.g.oauth.callback({ state: fake, code: SECRETS.code })).toEqual({ ok: false, reason: 'bad_state' });
    expect(gw.stub.calls).toEqual([]);
  });

  it('the scope request is exactly the configured scopes and the redirect never goes elsewhere', async () => {
    const custom = await createGoogleWorld({ GOOGLE_SCOPES: `${A}calendar.freebusy  ${A}gmail.readonly` });
    try {
      const link = await custom.g.oauth.createConnectLink(custom.w.alex.owner.id);
      const c = new URL((await custom.g.oauth.consentUrl(stateOf(link)))!);
      expect(c.host).toBe('accounts.google.com');
      expect(c.searchParams.get('scope')).toBe(`${A}calendar.freebusy ${A}gmail.readonly`);
      expect(c.searchParams.get('client_secret')).toBeNull();
      expect(c.toString()).not.toContain(SECRETS.clientSecret);
    } finally {
      await custom.close();
    }
  });
});

describe('verify M3 r2: calendar', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    await gw.connect(gw.w.alex.owner.id);
  });
  afterEach(async () => gw.close());
  const o = () => gw.w.alex.owner.id;

  it('event ids follow Google rules for any key (a–v, 0–9, 5–1024 chars)', () => {
    for (const k of ['', 'x', 'ü🎉', 'a'.repeat(10_000), '\u0000', 'Alex/Sam dinner']) {
      const id = eventIdFor(k);
      expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
      expect(() => checkAllowed('DELETE', `${EV}/${id}?sendUpdates=none`)).not.toThrow();
    }
  });

  it('pagination passes the previous page token and keeps all items in order', async () => {
    expectRefresh(gw.stub);
    const page = (token: string | null, items: unknown[], next?: string) =>
      gw.stub.expect({
        method: 'GET',
        url: (u) => u.searchParams.get('pageToken') === token && u.searchParams.get('singleEvents') === 'true' && u.searchParams.get('orderBy') === 'startTime',
        respond: { json: { timeZone: 'UTC', items, ...(next ? { nextPageToken: next } : {}) } },
      });
    const ev = (id: string) => ({ id, status: 'confirmed', start: { dateTime: '2026-11-11T10:00:00Z' }, end: { dateTime: '2026-11-11T11:00:00Z' } });
    page(null, [ev('a')], 'p2');
    page('p2', [ev('b'), { id: 'x', status: 'cancelled' }], 'p3');
    page('p3', [ev('c')]);
    const evs = await gw.g.calendar.listEvents(o(), gw.w.clock.now(), gw.w.clock.now());
    expect(evs.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('attendees: only emails, rooms dropped; missing start/end skipped; no title placeholder', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({
      method: 'GET',
      url: () => true,
      respond: {
        json: {
          timeZone: 'Europe/Berlin',
          items: [
            {
              id: 'a',
              status: 'confirmed',
              start: { dateTime: '2026-11-11T10:00:00+01:00' },
              end: { dateTime: '2026-11-11T11:00:00+01:00' },
              attendees: [{ email: 'sam@example.test', displayName: 'Sam' }, { email: 'room@resource.example.test', resource: true }, { displayName: 'no email' }],
            },
            { id: 'b', status: 'confirmed', start: { dateTime: '2026-11-11T10:00:00Z' } },
            { id: 'c', status: 'tentative', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
          ],
        },
      },
    });
    const evs = await gw.g.calendar.listEvents(o(), gw.w.clock.now(), gw.w.clock.now());
    expect(evs.map((e) => e.id)).toEqual(['a', 'c']);
    expect(evs[0]!.attendees).toEqual(['sam@example.test']);
    expect(evs[0]!.start.toISOString()).toBe('2026-11-11T09:00:00.000Z');
    expect(evs[1]!.start.toISOString()).toBe('2026-11-11T23:00:00.000Z');
    expect(evs[1]!.end.toISOString()).toBe('2026-11-12T23:00:00.000Z');
  });

  // Chile (America/Santiago) and Cuba (America/Havana) move clocks forward at local
  // midnight, so that day starts at 01:00 local, i.e. at the transition instant.
  it.each([
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z'],
    ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z'],
  ])('an all-day date in %s on a midnight DST gap starts at the transition, not in the previous day', (zone, date, expected) => {
    expect(dateInZone(date, zone)!.toISOString()).toBe(expected);
  });

  it('a floating wall time inside a DST gap resolves forward (as the code comment promises)', () => {
    // 02:30 does not exist in New York on 2026-03-08; forward resolution gives 03:30 EDT = 07:30Z.
    expect(dateTimeInZone('2026-03-08T02:30:00', 'America/New_York')!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('createEvent posts the derived id and no attendees; a 409 returns that same id without another call', async () => {
    expectRefresh(gw.stub);
    const id = eventIdFor('key-1');
    gw.stub.expect({
      method: 'POST',
      url: `${EV}?sendUpdates=none`,
      check: (init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.id).toBe(id);
        expect(body).not.toHaveProperty('attendees');
      },
      respond: { status: 409, json: { error: { errors: [{ reason: 'duplicate' }], code: 409 } } },
    });
    const res = await gw.g.calendar.createEvent(o(), { title: 'Dinner', start: gw.w.clock.now(), end: gw.w.clock.now() }, 'key-1');
    expect(res).toEqual({ eventId: id });
    expect(gw.stub.pending).toBe(0);
  });

  it('deleteEvent: 410 is done; 500 is a typed transient error after exactly one call', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'DELETE', url: `${EV}/abcde?sendUpdates=none`, respond: { status: 410, json: {} } });
    await gw.g.calendar.deleteEvent(o(), 'abcde');
    gw.stub.expect({ method: 'DELETE', url: `${EV}/abcde?sendUpdates=none`, respond: { status: 503, json: {} } });
    await expect(gw.g.calendar.deleteEvent(o(), 'abcde')).rejects.toBeInstanceOf(GoogleTransientError);
    expect(gw.stub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('a calendar-write grant without read cannot list; a read grant cannot create or delete', async () => {
    const w2 = await createGoogleWorld();
    try {
      await w2.connect(w2.w.alex.owner.id, [`${A}calendar.events.readonly`]);
      await expect(w2.g.calendar.createEvent(w2.w.alex.owner.id, { title: 't', start: w2.w.clock.now(), end: w2.w.clock.now() }, 'k')).rejects.toBeInstanceOf(
        GoogleScopeMissingError,
      );
      await expect(w2.g.calendar.deleteEvent(w2.w.alex.owner.id, 'abcde')).rejects.toBeInstanceOf(GoogleScopeMissingError);
      await expect(w2.g.calendar.freeBusy(w2.w.alex.owner.id, w2.w.clock.now(), w2.w.clock.now())).rejects.toBeInstanceOf(GoogleScopeMissingError);
      await expect(w2.g.gmail.createDraft(w2.w.alex.owner.id, { to: ['sam@example.test'], subject: 's', body: 'b' })).rejects.toBeInstanceOf(GoogleScopeMissingError);
      expect(w2.stub.calls).toEqual([]);
    } finally {
      await w2.close();
    }
  });
});

describe('verify M3 r2: gmail bodies', () => {
  const textPart = (s: string, extra: Record<string, unknown> = {}) => ({ mimeType: 'text/plain', body: { data: b64(s) }, ...extra });

  it.each([
    ['<script>' + '</'.repeat(400_000)],
    ['<a'.repeat(400_000) + '>'],
    ['</'.repeat(400_000)],
    ['<!'.repeat(400_000)],
    ['&#x'.repeat(300_000)],
    ['<br>'.repeat(200_000)],
    [' \n'.repeat(400_000)],
    ['<script></scrip '.repeat(50_000)],
    [('<' + 'a'.repeat(1000) + ' ').repeat(800)],
    ['<title>' + '<'.repeat(400_000)],
  ])('hostile HTML #%# is stripped quickly', (html) => {
    const t = performance.now();
    htmlToText(html);
    bodyText({ mimeType: 'text/html', body: { data: b64(html) } });
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it('many large text/plain parts are bounded in time and output', () => {
    const big = 'x'.repeat(100_000);
    const payload = { mimeType: 'multipart/mixed', parts: Array.from({ length: 200 }, () => textPart(big)) };
    const t = performance.now();
    const out = bodyText(payload);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 20);
  });

  it('a deeply nested multipart does not crash with an untyped RangeError', () => {
    let p: Record<string, unknown> = textPart('deep');
    for (let i = 0; i < 20_000; i += 1) p = { mimeType: 'multipart/mixed', parts: [p] };
    let result: unknown;
    try {
      result = bodyText(p);
    } catch (err) {
      result = err;
    }
    // Either the text, or a typed GoogleError — never a stack overflow escaping the provider.
    if (result instanceof Error) expect(result).toBeInstanceOf(GoogleError);
    else expect(typeof result).toBe('string');
  });

  it('charset handling: latin-1 decoded, unknown charset falls back, attachments ignored, uppercase mime type', () => {
    const latin1 = Buffer.from('café', 'latin1').toString('base64url');
    expect(bodyText({ mimeType: 'TEXT/PLAIN', headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }], body: { data: latin1 } })).toBe('café');
    expect(bodyText({ mimeType: 'text/plain', headers: [{ name: 'content-type', value: 'text/plain; charset=x-bogus' }], body: { data: b64('hello') } })).toBe('hello');
    expect(
      bodyText({
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', filename: 'secret.txt', body: { data: b64('ATTACHED') } },
          { mimeType: 'text/plain', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { data: b64('ATTACHED2') } },
          { mimeType: 'text/html', body: { data: b64('<p>Hi <b>Alex</b></p><script>evil()</script>') } },
        ],
      }),
    ).toBe('Hi Alex');
  });
});

describe('verify M3 r2: drafts', () => {
  const head = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0]!;

  it('RFC 5322: no header line longer than 998 characters, even replying to a long hostile References chain', () => {
    const refs = Array.from({ length: 500 }, (_, i) => `<id${i}.aaaaaaaaaaaaaaaaaaaaaaa@mail.example.test>`).join(' ');
    const raw = buildRawDraft({ to: ['sam@example.test'], subject: 'Re: hi', body: 'x', reply: { messageId: '<orig@mail.example.test>', references: refs } });
    for (const l of head(raw).split('\r\n')) expect(l.length).toBeLessThanOrEqual(998);
  });

  it('RFC 5322: 20 long recipients do not produce a To line over 998 characters', () => {
    const to = Array.from({ length: 20 }, (_, i) => `${'a'.repeat(60)}${i}@${'b'.repeat(60)}.example.test`);
    const raw = buildRawDraft({ to, subject: 'x', body: 'x' });
    for (const l of head(raw).split('\r\n')) expect(l.length).toBeLessThanOrEqual(998);
  });

  it('a long non-ASCII subject round-trips through RFC 2047 with every encoded word ≤ 75 chars', () => {
    const subject = 'Dîner 🎉 avec Sam — '.repeat(10);
    const h = head(buildRawDraft({ to: ['sam@example.test'], subject, body: 'x' }));
    const subj = h.split('\r\n').filter((l, i, all) => l.startsWith('Subject:') || (i > 0 && /^\s/.test(l) && all.slice(0, i).some((x) => x.startsWith('Subject:'))));
    const words = subj.join('').match(/=\?UTF-8\?B\?[^?]*\?=/g)!;
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(subject);
  });

  it.each([[['sam@example.test', 'sam@example.test\r\n']], [['a@b.example.test', '']], [Array.from({ length: 21 }, (_, i) => `p${i}@example.test`)]])(
    'invalid recipient list %# is refused',
    (to) => {
      expect(() => buildRawDraft({ to, subject: 's', body: 'b' })).toThrow(GoogleInvalidInputError);
    },
  );
});

describe('verify M3 r2: source discipline', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  const src = files(join(__dirname, '../../../src'));

  it('no source file names a Gmail send, import or insert endpoint, in any spelling', () => {
    for (const f of src) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/(messages|drafts)\s*[/:'"`+,]+\s*['"`]?\s*send\b/i);
      expect(text, f).not.toMatch(/messages\/(import|insert)\b/);
      expect(text, f).not.toMatch(/\/upload\/gmail/);
    }
  });

  // The Telegram transport (M6) is the other network door: its default fetch binding
  // talks to api.telegram.org only and never to a Google host.
  it('only the Google door (http.ts, services.ts binding) and the Telegram transport binding touch fetch', () => {
    for (const f of src) {
      const text = readFileSync(f, 'utf8');
      if (/globalThis\.fetch|\bfetch\s*\(/.test(text.replace(/this\.fetch\(|deps\.fetch\(|async fetch\(/g, ''))) {
        expect(f.replace(/\\/g, '/')).toMatch(/src\/(google\/(services|http)|transport\/telegram\/transport)\.ts$/);
      }
      expect(text, f).not.toMatch(/from ['"](node-fetch|undici|axios|googleapis|node:https?)['"]/);
    }
  });

  it('no Date.now() or argument-less new Date() outside src/clock.ts', () => {
    for (const f of src) {
      if (f.replace(/\\/g, '/').endsWith('src/clock.ts')) continue;
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/Date\.now\(\)|new Date\(\s*\)/);
    }
  });
});

describe('verify M3 r2: typed errors carry safe messages', () => {
  it('every Google error class has a short safeMessage with no ids, URLs or secrets', () => {
    const errs: GoogleError[] = [
      new GoogleDeniedError('google call denied: POST https://gmail.googleapis.com/x'),
      new GoogleNotConnectedError('owner-123'),
      new GoogleAuthError('x', 'invalid_grant', 400),
      new GoogleScopeMissingError('x', 'gmailDraft'),
      new GoogleRequestError('x', 400),
      new GoogleTransientError('x', 503),
      new GoogleInvalidInputError('That email address is not valid.'),
    ];
    for (const e of errs) {
      expect(e.safeMessage.length).toBeGreaterThan(0);
      expect(e.safeMessage.length).toBeLessThan(160);
      expect(e.safeMessage).not.toMatch(/https?:|owner-123|googleapis|token/i);
    }
  });
});
