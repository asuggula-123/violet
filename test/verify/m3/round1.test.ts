/** Verifier (M3) round 1: adversarial tests for the Google providers, allow-list, tokens and OAuth. */
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAllowed } from '../../../src/google/allowlist.js';
import { eventIdFor } from '../../../src/google/calendar.js';
import { decryptToken, encryptToken, parseEncKey } from '../../../src/google/crypto.js';
import {
  GoogleAuthError,
  GoogleDeniedError,
  GoogleError,
  GoogleInvalidInputError,
  GoogleRateLimitedError,
  GoogleScopeMissingError,
} from '../../../src/google/errors.js';
import { bodyText, MAX_BODY_CHARS } from '../../../src/google/mime.js';
import { parseConfig } from '../../../src/config.js';
import { createGoogle } from '../../../src/google/services.js';
import {
  bearer,
  createGoogleWorld,
  ENC_KEY,
  expectRefresh,
  googleEnv,
  SECRETS,
  StubFetch,
  TOKEN_URL,
  type GoogleWorld,
} from '../../unit/google/helpers.js';

const A = 'https://www.googleapis.com/auth/';
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EV = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('verify M3 r1: allow-list cannot be defeated', () => {
  const forbidden: [string, string][] = [
    ['POST', `${G}/messages/send`],
    ['POST', `${G}/drafts/send`],
    ['POST', `${G}/drafts/abc/send`],
    ['POST', `${G}/messages/abc/send`],
    ['POST', `${G}/messages`],
    ['POST', `${G}/messages/import`],
    ['POST', `${G}/messages/batchModify`],
    ['POST', `${G}/settings/sendAs`],
    ['POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send'],
    ['POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts'],
    ['POST', 'https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media'],
    ['POST', 'https://www.googleapis.com/gmail/v1/users/me/messages/send'],
    ['POST', 'https://www.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com/batch/gmail/v1'],
    ['POST', 'https://www.googleapis.com/batch'],
    ['POST', 'https://www.googleapis.com/batch/calendar/v3'],
    ['POST', `${G}/drafts?uploadType=media`],
    ['POST', `${G}/drafts?alt=json`],
    ['POST', `${G}/drafts?%24.xgafv=2`],
    ['POST', `${G}/drafts?access_token=x`],
    ['POST', `${G}/drafts/`],
    ['POST', `${G}//drafts`],
    ['POST', `${G}/./drafts`],
    ['POST', `${G}/x/../drafts`],
    ['POST', `${G}/drafts/..%2Fmessages%2Fsend`],
    ['POST', `${G}/drafts%2Fsend`],
    ['POST', `${G}/drafts%2fsend`],
    ['POST', `${G}/%64rafts`],
    ['POST', `${G}/drafts#send`],
    ['POST', `${G}/drafts;send`],
    ['POST', `${G}/drafts:send`],
    ['POST', `${G}/messages:send`],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts\\send'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts\tx'],
    ['POST', 'https://GMAIL.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com./gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com:443/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com:8443/gmail/v1/users/me/drafts'],
    ['POST', 'https://user:pw@gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://evil.example@gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com.evil.example/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com。/gmail/v1/users/me/drafts'],
    ['POST', 'https://ｇmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'http://gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'HTTPS://gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', '//gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https:gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https:/gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com?/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com/GMAIL/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/ME/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/alex@example.test/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/someone/drafts'],
    ['GET', 'https://gmail.googleapis.com/gmail/v1/users/other/messages'],
    ['post', `${G}/drafts`],
    ['Post', `${G}/drafts`],
    ['PUT', `${G}/drafts/abc`],
    ['PATCH', `${EV}/abc`],
    ['PUT', `${EV}/abc`],
    ['POST', `${EV}/abc`],
    ['POST', `${EV}/import`],
    ['POST', `${EV}/quickAdd`],
    ['POST', `${EV}/watch`],
    ['POST', `${EV}/abc/move`],
    ['GET', `${EV}/abc/instances`],
    ['DELETE', EV],
    ['DELETE', `${EV}/abc/x`],
    ['DELETE', `${EV}/a.b`],
    ['DELETE', `${EV}/..`],
    ['GET', 'https://www.googleapis.com/calendar/v3/calendars/other@example.test/events'],
    ['GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList'],
    ['DELETE', 'https://www.googleapis.com/calendar/v3/calendars/primary'],
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/clear'],
    ['GET', 'https://oauth2.googleapis.com/token'],
    ['POST', 'https://oauth2.googleapis.com/revoke'],
    ['POST', 'https://oauth2.googleapis.com/token/'],
    ['POST', 'https://accounts.google.com/o/oauth2/token'],
    ['GET', 'https://evil.example/'],
    ['DELETE', `${G}/messages/abc`],
    ['DELETE', `${G}/drafts/abc`],
    ['POST', `${G}/messages/abc/trash`],
    ['POST', `${G}/messages/abc/modify`],
    ['GET', `${G}/messages/${'a'.repeat(1025)}`],
    ['GET', `${G}/messages?q=x&uploadType=media`],
    ['GET', `${G}/messages/abc?alt=media`],
    ['POST', `${EV}?sendUpdates=none&supportsAttachments=true`],
  ];

  it.each(forbidden)('denies %s %s before fetch and logs google.denied', async (method, u) => {
    const gw = await createGoogleWorld();
    try {
      await expect(gw.g.http.request({ method, url: u, ownerId: gw.w.alex.owner.id })).rejects.toBeInstanceOf(GoogleDeniedError);
      expect(gw.stub.calls).toEqual([]);
      const rows = await gw.w.db.query<{ action: string; agent_id: string | null }>("SELECT action, agent_id FROM action_log WHERE action = 'google.denied'");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.agent_id).toBe(gw.w.alex.agent.id);
    } finally {
      await gw.close();
    }
  });

  it('checkAllowed accepts the exact allowed set', () => {
    for (const [m, u] of [
      ['POST', 'https://oauth2.googleapis.com/token'],
      ['POST', 'https://www.googleapis.com/calendar/v3/freeBusy'],
      ['GET', `${EV}?timeMin=a&timeMax=b&singleEvents=true&orderBy=startTime&pageToken=p&maxResults=250`],
      ['POST', `${EV}?sendUpdates=none`],
      ['DELETE', `${EV}/abc123?sendUpdates=none`],
      ['GET', `${G}/profile`],
      ['GET', `${G}/messages?q=from%3Asam&maxResults=5`],
      ['GET', `${G}/messages/abc?format=full`],
      ['GET', `${G}/threads/abc?format=metadata`],
      ['POST', `${G}/drafts`],
    ] as const) {
      expect(() => checkAllowed(m, u), `${m} ${u}`).not.toThrow();
    }
  });

  it('a denied call logs neither the query string nor the token', async () => {
    const gw = await createGoogleWorld();
    try {
      await expect(
        gw.g.http.request({ method: 'POST', url: `${G}/messages/send?access_token=${SECRETS.accessToken}`, ownerId: gw.w.alex.owner.id, accessToken: SECRETS.accessToken }),
      ).rejects.toBeInstanceOf(GoogleDeniedError);
      const rows = await gw.w.db.query('SELECT detail FROM action_log');
      expect(JSON.stringify(rows.rows)).not.toContain(SECRETS.accessToken);
      expect(gw.logs.join('')).not.toContain(SECRETS.accessToken);
    } finally {
      await gw.close();
    }
  });
});

describe('verify M3 r1: providers with hostile ids', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    await gw.connect(gw.w.alex.owner.id);
  });
  afterEach(async () => gw.close());

  it('deleteEvent never sends a sendUpdates value other than "none", whatever the event id', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'DELETE', url: () => true, respond: { status: 204 } });
    await gw.g.calendar.deleteEvent(gw.w.alex.owner.id, 'abc?sendUpdates=all&sendUpdates=').catch(() => undefined);
    const del = gw.stub.calls.find((c) => c.method === 'DELETE');
    if (del) expect(new URL(del.url).searchParams.getAll('sendUpdates')).toEqual(['none']);
  });

  it('getMessage with a path-traversal id makes no network call outside the allow-list', async () => {
    expectRefresh(gw.stub);
    await expect(gw.g.gmail.getMessage(gw.w.alex.owner.id, '../drafts/send')).rejects.toBeInstanceOf(GoogleError);
    expect(gw.stub.calls.filter((c) => c.method !== 'POST' || c.url !== TOKEN_URL)).toEqual([]);
  });
});

describe('verify M3 r1: tokens', () => {
  it('IVs are unique and ciphertexts differ for the same plaintext', () => {
    const key = parseEncKey(ENC_KEY);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const iv = encryptToken(key, 'same', 'aad').split('.')[1]!;
      expect(seen.has(iv)).toBe(false);
      seen.add(iv);
    }
  });

  it('every single-character tamper of the ciphertext is detected', () => {
    const key = parseEncKey(ENC_KEY);
    const sealed = encryptToken(key, SECRETS.refreshToken, 'aad');
    for (let i = 3; i < sealed.length; i += 1) {
      if (sealed[i] === '.') continue;
      const c = sealed[i] === 'A' ? 'B' : 'A';
      const bad = sealed.slice(0, i) + c + sealed.slice(i + 1);
      let out: string | undefined;
      try {
        out = decryptToken(key, bad, 'aad');
      } catch {
        out = undefined;
      }
      // base64url padding bits can make a change a no-op on the decoded bytes; then the plaintext is unchanged.
      if (out !== undefined) expect(out).toBe(SECRETS.refreshToken);
    }
  });

  it.each(['', '   ', 'abc', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), Buffer.alloc(32).toString('hex'), `${ENC_KEY}x`])(
    'rejects a malformed key %j',
    (k) => {
      expect(() => parseEncKey(k)).toThrow(/TOKEN_ENC_KEY/);
    },
  );

  it('a ciphertext copied to another owner does not decrypt', async () => {
    const gw = await createGoogleWorld();
    try {
      await gw.connect(gw.w.alex.owner.id);
      await gw.connect(gw.w.sam.owner.id);
      await gw.w.db.query(
        'UPDATE google_accounts SET refresh_token_enc = (SELECT refresh_token_enc FROM google_accounts WHERE owner_id = $1) WHERE owner_id = $2',
        [gw.w.alex.owner.id, gw.w.sam.owner.id],
      );
      await expect(gw.g.calendar.listEvents(gw.w.sam.owner.id, gw.w.clock.now(), gw.w.clock.now())).rejects.toThrow();
      expect(gw.stub.calls).toEqual([]);
    } finally {
      await gw.close();
    }
  });

  it('an undecryptable stored token surfaces as a typed GoogleError with a safe message', async () => {
    const gw = await createGoogleWorld();
    try {
      await gw.connect(gw.w.alex.owner.id);
      await gw.w.db.query("UPDATE google_accounts SET refresh_token_enc = 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'");
      const err = await gw.g.calendar.listEvents(gw.w.alex.owner.id, gw.w.clock.now(), gw.w.clock.now()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleError);
    } finally {
      await gw.close();
    }
  });

  it('the refresh token is never in the database in plaintext (any table)', async () => {
    const gw = await createGoogleWorld();
    try {
      await gw.connect(gw.w.alex.owner.id);
      const rows = await gw.w.db.query('SELECT * FROM google_accounts');
      expect(JSON.stringify(rows.rows)).not.toContain(SECRETS.refreshToken);
      const log = await gw.w.db.query('SELECT * FROM action_log');
      expect(JSON.stringify(log.rows)).not.toContain(SECRETS.refreshToken);
    } finally {
      await gw.close();
    }
  });
});

describe('verify M3 r1: invalid_grant is flagged exactly once', () => {
  it('concurrent calls in one process: one refresh, one flag, all fail typed', async () => {
    const gw = await createGoogleWorld();
    try {
      const owner = gw.w.alex.owner.id;
      await gw.connect(owner);
      gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant', error_description: `Token ${SECRETS.refreshToken} has been expired or revoked.` } } });
      const results = await Promise.allSettled([
        gw.g.calendar.listEvents(owner, gw.w.clock.now(), gw.w.clock.now()),
        gw.g.gmail.search(owner, 'x', 3),
        gw.g.calendar.freeBusy(owner, gw.w.clock.now(), gw.w.clock.now()),
      ]);
      expect(results.every((r) => r.status === 'rejected' && r.reason instanceof GoogleAuthError)).toBe(true);
      expect(gw.stub.calls).toHaveLength(1);
      // Later calls: no network, still typed, still one flag.
      await expect(gw.g.gmail.search(owner, 'x', 3)).rejects.toBeInstanceOf(GoogleAuthError);
      expect(gw.stub.calls).toHaveLength(1);
      const flags = await gw.w.db.query<{ urgency: string; text: string }>("SELECT urgency, text FROM flags WHERE kind = 'google.revoked'");
      expect(flags.rows).toEqual([{ urgency: 'now', text: 'Google access expired — reconnect needed.' }]);
      const all = JSON.stringify((await gw.w.db.query('SELECT * FROM action_log')).rows) + JSON.stringify((await gw.w.db.query('SELECT * FROM flags')).rows);
      expect(all).not.toContain(SECRETS.refreshToken);
      expect(gw.logs.join('')).not.toContain(SECRETS.refreshToken);
      for (const r of results) if (r.status === 'rejected') expect(String((r.reason as Error).message)).not.toContain(SECRETS.refreshToken);
    } finally {
      await gw.close();
    }
  });

  it('two processes (two service instances on one DB) racing invalid_grant: still one flag', async () => {
    const gw = await createGoogleWorld();
    try {
      const owner = gw.w.alex.owner.id;
      await gw.connect(owner);
      const stub2 = new StubFetch();
      const g2 = createGoogle({ config: parseConfig(googleEnv()), db: gw.w.db, clock: gw.w.clock, log: pino({ level: 'silent' }), fetch: stub2.fetch });
      g2.bindFlags(gw.w.app.flags);
      const bad = { status: 400, json: { error: 'invalid_grant' } };
      gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: bad });
      stub2.expect({ method: 'POST', url: TOKEN_URL, respond: bad });
      const r = await Promise.allSettled([
        gw.g.calendar.listEvents(owner, gw.w.clock.now(), gw.w.clock.now()),
        g2.calendar.listEvents(owner, gw.w.clock.now(), gw.w.clock.now()),
      ]);
      expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
      const flags = await gw.w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM flags WHERE kind = 'google.revoked'");
      expect(flags.rows[0]!.n).toBe(1);
    } finally {
      await gw.close();
    }
  });
});

describe('verify M3 r1: error mapping, no blind retries', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    await gw.connect(gw.w.alex.owner.id);
  });
  afterEach(async () => gw.close());
  const owner = () => gw.w.alex.owner.id;

  it('429 → rate limited, exactly one API call', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'GET', url: () => true, respond: { status: 429, headers: { 'retry-after': '7' }, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } } });
    const err = await gw.g.gmail.search(owner(), 'x', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleRateLimitedError);
    expect((err as GoogleRateLimitedError).retryAfterSec).toBe(7);
    expect(gw.stub.calls).toHaveLength(2);
  });

  it('401 twice → one fresh-token retry only, then GoogleAuthError', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'GET', url: () => true, respond: { status: 401, json: { error: { code: 401, status: 'UNAUTHENTICATED' } } } });
    expectRefresh(gw.stub, 3600, 'second-token');
    gw.stub.expect({ method: 'GET', url: () => true, check: (init) => expect(bearer(init)).toBe('Bearer second-token'), respond: { status: 401, json: {} } });
    await expect(gw.g.gmail.search(owner(), 'x', 1)).rejects.toBeInstanceOf(GoogleAuthError);
    expect(gw.stub.calls).toHaveLength(4);
    expect(gw.stub.pending).toBe(0);
  });

  it('403 insufficient scope from Google → GoogleScopeMissingError with capability', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({
      method: 'POST',
      url: () => true,
      respond: { status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } },
    });
    const err = await gw.g.gmail.createDraft(owner(), { to: ['sam@example.test'], subject: 'Hi', body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleScopeMissingError);
    expect((err as GoogleScopeMissingError).capability).toBe('gmailDraft');
  });

  it('token endpoint error echoing secrets never leaks them into errors, logs or action_log', async () => {
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_request', error_description: `bad ${SECRETS.refreshToken} ${SECRETS.clientSecret}` } } });
    const err = (await gw.g.gmail.search(owner(), 'secret search', 1).catch((e: unknown) => e)) as GoogleError;
    expect(err).toBeInstanceOf(GoogleError);
    const all = `${err.message} ${err.safeMessage} ${gw.logs.join('')} ${JSON.stringify((await gw.w.db.query('SELECT * FROM action_log')).rows)}`;
    for (const s of [SECRETS.refreshToken, SECRETS.clientSecret, SECRETS.accessToken]) expect(all).not.toContain(s);
  });

  it('search query text is not put in error messages or logs', async () => {
    expectRefresh(gw.stub);
    gw.stub.expect({ method: 'GET', url: () => true, respond: { status: 500, json: {} } });
    const err = (await gw.g.gmail.search(owner(), 'PRIVATE-QUERY-TEXT', 1).catch((e: unknown) => e)) as GoogleError;
    expect(err.message).not.toContain('PRIVATE-QUERY-TEXT');
    expect(gw.logs.join('')).not.toContain('PRIVATE-QUERY-TEXT');
  });
});

describe('verify M3 r1: scope enforcement per call', () => {
  it('freebusy-only grant: list/create/delete/gmail all refused before any network call', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o, [`${A}calendar.freebusy`], null);
      const now = gw.w.clock.now();
      // Thunks, not eager promises: awaiting eagerly-created promises one by one leaves later
      // rejections unhandled for a while, which Node/vitest report as unhandled rejections.
      for (const call of [
        () => gw.g.calendar.listEvents(o, now, now),
        () => gw.g.calendar.createEvent(o, { title: 't', start: now, end: now }, 'k'),
        () => gw.g.calendar.deleteEvent(o, 'abc'),
        () => gw.g.gmail.search(o, 'x', 1),
        () => gw.g.gmail.getMessage(o, 'abc'),
        () => gw.g.gmail.createDraft(o, { to: ['sam@example.test'], subject: 's', body: 'b' }),
      ]) {
        const err = await (call() as Promise<unknown>).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(GoogleScopeMissingError);
        expect((err as GoogleError).safeMessage.length).toBeLessThan(120);
      }
      expect(gw.stub.calls).toEqual([]);
    } finally {
      await gw.close();
    }
  });
});

describe('verify M3 r1: calendar', () => {
  it('event ids are valid base32hex, 52 chars, deterministic and distinct', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = eventIdFor(`key-${i}`);
      expect(id).toMatch(/^[0-9a-v]{52}$/);
      expect(eventIdFor(`key-${i}`)).toBe(id);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
    expect(eventIdFor('')).toMatch(/^[0-9a-v]{52}$/);
    expect(eventIdFor('ü'.repeat(5000))).toMatch(/^[0-9a-v]{52}$/);
  });

  it('all-day events on a DST-change date in the calendar zone; floating dateTime in the event zone', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o);
      expectRefresh(gw.stub);
      gw.stub.expect({
        method: 'GET',
        url: () => true,
        respond: {
          json: {
            timeZone: 'America/New_York',
            items: [
              { id: 'a', status: 'confirmed', summary: 'DST day', start: { date: '2026-03-08' }, end: { date: '2026-03-09' } },
              { id: 'b', status: 'confirmed', summary: 'Tokyo', start: { dateTime: '2026-03-08T09:00:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-03-08T10:00:00', timeZone: 'Asia/Tokyo' } },
              { id: 'c', status: 'cancelled', start: { date: '2026-03-08' }, end: { date: '2026-03-09' } },
              { id: 'd', status: 'confirmed', start: { dateTime: '2026-03-08T01:30:00-05:00' }, end: { dateTime: '2026-03-08T03:30:00-04:00' } },
            ],
          },
        },
      });
      const evs = await gw.g.calendar.listEvents(o, new Date('2026-03-07T00:00:00Z'), new Date('2026-03-10T00:00:00Z'));
      expect(evs.map((e) => e.id)).toEqual(['a', 'b', 'd']);
      expect(evs[0]!.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
      expect(evs[0]!.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
      expect(evs[0]!.allDay).toBe(true);
      expect(evs[1]!.start.toISOString()).toBe('2026-03-08T00:00:00.000Z');
      expect(evs[2]!.end.getTime() - evs[2]!.start.getTime()).toBe(3600_000);
    } finally {
      await gw.close();
    }
  });

  it('createEvent: 409 on retry returns the same id; body sends no attendees and sendUpdates=none', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o);
      const id = eventIdFor('book-1');
      expectRefresh(gw.stub);
      gw.stub.expect({
        method: 'POST',
        url: (u) => u.searchParams.get('sendUpdates') === 'none',
        check: (init) => expect(JSON.parse(String(init.body)).id).toBe(id),
        respond: { status: 409, json: { error: { code: 409, errors: [{ reason: 'duplicate' }] } } },
      });
      const now = gw.w.clock.now();
      expect(await gw.g.calendar.createEvent(o, { title: 'Lunch', start: now, end: now }, 'book-1')).toEqual({ eventId: id });
    } finally {
      await gw.close();
    }
  });

  it('listEvents does not silently drop events after the page cap', async () => {
    const gw = await createGoogleWorld();
    try {
      const o = gw.w.alex.owner.id;
      await gw.connect(o);
      expectRefresh(gw.stub);
      for (let p = 0; p < 21; p += 1) {
        gw.stub.expect({
          method: 'GET',
          url: () => true,
          respond: {
            json: {
              timeZone: 'UTC',
              items: [{ id: `e${p}`, status: 'confirmed', start: { dateTime: '2026-01-01T10:00:00Z' }, end: { dateTime: '2026-01-01T11:00:00Z' } }],
              ...(p < 20 ? { nextPageToken: `t${p + 1}` } : {}),
            },
          },
        });
      }
      const res = await gw.g.calendar.listEvents(o, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z')).then(
        (evs) => evs.length,
        (e: unknown) => (e instanceof GoogleError ? 'typed-error' : 'other-error'),
      );
      expect([21, 'typed-error']).toContain(res);
    } finally {
      await gw.close();
    }
  });
});

describe('verify M3 r1: gmail bodies and drafts', () => {
  it('a hostile HTML body (many unclosed "<") is stripped in bounded time', () => {
    const html = '<'.repeat(100_000);
    const t0 = performance.now();
    const out = bodyText({ mimeType: 'text/html', filename: '', body: { data: b64(html) } });
    const ms = performance.now() - t0;
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 20);
    expect(ms).toBeLessThan(2000);
  });

  it('a hostile HTML body (many unclosed comments / scripts) is stripped in bounded time', () => {
    for (const html of ['<!--'.repeat(50_000), '<script>'.repeat(30_000)]) {
      const t0 = performance.now();
      bodyText({ mimeType: 'text/html', filename: '', body: { data: b64(html) } });
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });

  it('a large text/plain body is capped', () => {
    const out = bodyText({ mimeType: 'text/plain', filename: '', body: { data: b64('x'.repeat(3_000_000)) } });
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 20);
  });

  describe('drafts', () => {
    let gw: GoogleWorld;
    beforeEach(async () => {
      gw = await createGoogleWorld();
      await gw.connect(gw.w.alex.owner.id);
    });
    afterEach(async () => gw.close());
    const o = () => gw.w.alex.owner.id;

    it.each([
      ['sam@example.test\r\nBcc: x@evil.example'],
      ['sam@example.test\nBcc: x@evil.example'],
      ['sam@example.test, x@evil.example'],
      ['Sam <sam@example.test>'],
      ['sam@example.test\u0000'],
      ['sam@exa mple.test'],
      ['@example.test'],
      ['sam@'],
      ['sam@example.test Bcc: x@evil.example'],
      ['sam@example.test\u0085'],
      ['sam@-example.test'],
    ])('rejects recipient %j before any network call', async (to) => {
      await expect(gw.g.gmail.createDraft(o(), { to: [to], subject: 'Hi', body: 'b' })).rejects.toBeInstanceOf(GoogleInvalidInputError);
      expect(gw.stub.calls).toEqual([]);
    });

    it.each([['Hi\r\nBcc: x@evil.example'], ['Hi\nBcc: x'], ['Hi\rBcc: x'], ['Hi\u0000'], ['Hi\tthere']])('rejects subject %j', async (subject) => {
      await expect(gw.g.gmail.createDraft(o(), { to: ['sam@example.test'], subject, body: 'b' })).rejects.toBeInstanceOf(GoogleInvalidInputError);
      expect(gw.stub.calls).toEqual([]);
    });

    it('unicode line separators in the subject cannot create header lines', async () => {
      expectRefresh(gw.stub);
      let raw = '';
      gw.stub.expect({ method: 'POST', url: `${G}/drafts`, check: (init) => void (raw = JSON.parse(String(init.body)).message.raw), respond: { json: { id: 'd1' } } });
      await gw.g.gmail.createDraft(o(), { to: ['sam@example.test'], subject: 'Hi Bcc: x@evil.example\u0085Cc: y@evil.example', body: 'b' });
      const head = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0]!;
      const names = head.split('\r\n').filter((l) => !/^\s/.test(l)).map((l) => l.split(':')[0]);
      expect(names).toEqual(['To', 'Subject', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
      expect(head).not.toMatch(/evil/);
    });

    it('a reply to a hostile message cannot inject headers via Message-ID or References', async () => {
      expectRefresh(gw.stub);
      gw.stub.expect({
        method: 'GET',
        url: (u) => u.pathname.endsWith('/messages/m1'),
        respond: {
          json: {
            id: 'm1',
            threadId: 't1',
            payload: {
              headers: [
                { name: 'Message-ID', value: '<a@b>\r\nBcc: x@evil.example' },
                { name: 'References', value: '<r1@b>\r\nBcc: y@evil.example <r2@b>' },
              ],
            },
          },
        },
      });
      let body: { message: { raw: string; threadId?: string } } | undefined;
      gw.stub.expect({ method: 'POST', url: `${G}/drafts`, check: (init) => void (body = JSON.parse(String(init.body))), respond: { json: { id: 'd1' } } });
      await gw.g.gmail.createDraft(o(), { to: ['sam@example.test'], subject: 'Re: hi', body: 'ok', replyToMessageId: 'm1' });
      const head = Buffer.from(body!.message.raw, 'base64url').toString('utf8').split('\r\n\r\n')[0]!;
      expect(head).not.toMatch(/evil|Bcc/i);
      for (const l of head.split('\r\n')) expect(l).toMatch(/^(To|Subject|In-Reply-To|References|MIME-Version|Content-Type|Content-Transfer-Encoding): /);
      expect(body!.message.threadId).toBe('t1');
    });

    it('a body full of header-looking lines and a lone "." stays in the body', async () => {
      expectRefresh(gw.stub);
      let raw = '';
      gw.stub.expect({ method: 'POST', url: `${G}/drafts`, check: (init) => void (raw = JSON.parse(String(init.body)).message.raw), respond: { json: { id: 'd1' } } });
      await gw.g.gmail.createDraft(o(), { to: ['sam@example.test'], subject: 'x', body: '\r\n\r\nBcc: x@evil.example\r\n.\r\n' });
      const head = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0]!;
      expect(head).not.toContain('evil');
    });
  });
});

describe('verify M3 r1: OAuth', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
  });
  afterEach(async () => gw.close());

  function expectExchange(scope: string) {
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { json: { access_token: SECRETS.accessToken, refresh_token: SECRETS.refreshToken, expires_in: 3600, scope } } });
  }

  it('concurrent callbacks with the same state: exactly one succeeds, one code exchange', async () => {
    const link = await gw.g.oauth.createConnectLink(gw.w.alex.owner.id);
    const state = new URL(link).searchParams.get('state')!;
    expectExchange(`${A}calendar.freebusy`);
    const rs = await Promise.all(Array.from({ length: 6 }, () => gw.g.oauth.callback({ state, code: SECRETS.code })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && r.reason === 'bad_state')).toHaveLength(5);
    expect(gw.stub.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('the consent URL is exactly Google with the expected parameters, and the state expires at 15 minutes', async () => {
    const link = await gw.g.oauth.createConnectLink(gw.w.alex.owner.id);
    const state = new URL(link).searchParams.get('state')!;
    const c = new URL((await gw.g.oauth.consentUrl(state))!);
    expect(c.origin + c.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(c.searchParams)).toMatchObject({
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      redirect_uri: 'https://violet.example/oauth/google/callback',
      state,
    });
    gw.w.clock.advance(15 * 60_000);
    expect(await gw.g.oauth.consentUrl(state)).toBeNull();
    expect(await gw.g.oauth.callback({ state, code: SECRETS.code })).toEqual({ ok: false, reason: 'bad_state' });
    expect(gw.stub.calls).toEqual([]);
  });

  it('nothing secret ends up in action_log or logs across link, callback and failures', async () => {
    const link = await gw.g.oauth.createConnectLink(gw.w.alex.owner.id);
    const state = new URL(link).searchParams.get('state')!;
    gw.stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant', error_description: SECRETS.code } } });
    expect((await gw.g.oauth.callback({ state, code: SECRETS.code })).ok).toBe(false);
    const all = JSON.stringify((await gw.w.db.query('SELECT * FROM action_log')).rows) + JSON.stringify((await gw.w.db.query('SELECT * FROM oauth_states')).rows) + gw.logs.join('');
    for (const s of [SECRETS.code, SECRETS.clientSecret, state]) expect(all).not.toContain(s);
  });
});
