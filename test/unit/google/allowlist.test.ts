import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAllowed } from '../../../src/google/allowlist.js';
import { GoogleDeniedError } from '../../../src/google/errors.js';
import { GoogleHttp } from '../../../src/google/http.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { StubFetch } from './helpers.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';

const ALLOWED: [string, string][] = [
  ['POST', 'https://oauth2.googleapis.com/token'],
  ['POST', `${CAL}/freeBusy`],
  ['GET', `${CAL}/calendars/primary/events?timeMin=2026-11-11T00%3A00%3A00.000Z&singleEvents=true&orderBy=startTime&pageToken=abc`],
  ['POST', `${CAL}/calendars/primary/events?sendUpdates=none`],
  ['DELETE', `${CAL}/calendars/primary/events/abc123_20261111T100000Z?sendUpdates=none`],
  ['GET', `${GM}/profile`],
  ['GET', `${GM}/messages?q=from%3Asam+dinner&maxResults=10`],
  ['GET', `${GM}/messages/18c2f0a1b2?format=full`],
  ['GET', `${GM}/messages/18c2f0a1b2?format=metadata&metadataHeaders=From&metadataHeaders=To`],
  ['GET', `${GM}/threads/18c2f0a1b2?format=metadata`],
  ['POST', `${GM}/drafts`],
];

const FORBIDDEN: [string, string][] = [
  // Sending, in every spelling.
  ['POST', `${GM}/messages/send`],
  ['POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send'],
  ['POST', `${GM}/drafts/send`],
  ['POST', 'https://www.googleapis.com/gmail/v1/users/me/messages/send'],
  ['POST', `${GM}/messages`],
  ['POST', `${GM}/messages/import`],
  ['POST', `${GM}/messages/abc/modify`],
  ['DELETE', `${GM}/messages/abc`],
  ['POST', 'https://www.googleapis.com/batch/gmail/v1'],
  // Wrong method on an allowed path.
  ['PUT', `${CAL}/calendars/primary/events/abc`],
  ['PATCH', `${CAL}/calendars/primary/events/abc`],
  ['GET', 'https://oauth2.googleapis.com/token'],
  ['POST', `${GM}/profile`],
  ['DELETE', `${CAL}/calendars/primary/events`],
  ['get', `${GM}/profile`],
  // Other calendars / users.
  ['POST', `${CAL}/calendars/someone%40example.test/events`],
  ['GET', `${CAL}/calendars/other/events`],
  ['GET', 'https://gmail.googleapis.com/gmail/v1/users/someone@example.test/messages'],
  ['GET', 'https://gmail.googleapis.com/gmail/v1/users/ME/profile'],
  ['GET', 'https://gmail.googleapis.com/gmail/v1/users/me%40/profile'],
  // Path tricks.
  ['GET', `${GM}/messages/..%2Fdrafts%2Fsend`],
  ['POST', `${GM}/drafts/../messages/send`],
  ['POST', `${GM}/drafts/./`],
  ['POST', `${GM}/drafts/`],
  ['POST', `${GM}//drafts`],
  ['POST', `${GM}/drafts%2Fsend`],
  ['POST', `${GM}/drafts%2fsend`],
  ['POST', `${GM}/%64rafts`],
  ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts\\send'],
  ['GET', `${GM}/messages/abc/../../drafts`],
  ['GET', `${GM}/messages/abc%2F..%2Fsend`],
  ['GET', `${GM}/messages/a.b`],
  ['GET', `${GM}/messages/ab c`],
  ['POST', `${GM}/drafts;send`],
  ['POST', `${GM}/drafts:send`],
  // Query smuggling / unknown parameters.
  ['POST', `${GM}/drafts?send=true`],
  ['POST', `${GM}/drafts?$method=send`],
  ['POST', `${GM}/drafts?uploadType=media`],
  ['GET', `${GM}/profile?access_token=x`],
  ['POST', `${CAL}/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`],
  // sendUpdates is pinned to "none" (no invitation or cancellation emails), every value.
  ['POST', `${CAL}/calendars/primary/events?sendUpdates=all`],
  ['POST', `${CAL}/calendars/primary/events?sendUpdates=externalOnly`],
  ['DELETE', `${CAL}/calendars/primary/events/abc123?sendUpdates=all`],
  ['DELETE', `${CAL}/calendars/primary/events/abc123?sendUpdates=all&sendUpdates=none`],
  ['DELETE', `${CAL}/calendars/primary/events/abc123?sendUpdates=none&sendUpdates=`],
  ['GET', `${GM}/messages?q=x&alt=media`],
  ['POST', `${GM}/drafts#send`],
  // Host and scheme tricks.
  ['POST', 'http://gmail.googleapis.com/gmail/v1/users/me/drafts'],
  ['POST', 'https://gmail.googleapis.com.evil.example/gmail/v1/users/me/drafts'],
  ['POST', 'https://evil.example/gmail.googleapis.com/gmail/v1/users/me/drafts'],
  ['POST', 'https://user@gmail.googleapis.com/gmail/v1/users/me/drafts'],
  ['POST', 'https://gmail.googleapis.com@evil.example/gmail/v1/users/me/drafts'],
  ['POST', 'https://gmail.googleapis.com:443/gmail/v1/users/me/drafts'],
  ['POST', 'https://gmail.googleapis.com:8443/gmail/v1/users/me/drafts'],
  ['POST', 'https://GMAIL.googleapis.com/gmail/v1/users/me/drafts'],
  ['POST', 'https://gmail.googleapis.com./gmail/v1/users/me/drafts'],
  ['POST', 'https://www.googleapis.com/gmail/v1/users/me/drafts'],
  ['POST', 'https://oauth2.googleapis.com/revoke'],
  ['POST', 'https://accounts.google.com/o/oauth2/token'],
  ['GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList'],
  ['POST', ' https://gmail.googleapis.com/gmail/v1/users/me/drafts'],
  ['POST', 'https://gmail.googleapis.com'],
  ['POST', 'not a url'],
];

describe('allow-list (I8)', () => {
  it.each(ALLOWED)('allows %s %s', (method, url) => {
    expect(() => checkAllowed(method, url)).not.toThrow();
  });

  it.each(FORBIDDEN)('denies %s %s', (method, url) => {
    expect(() => checkAllowed(method, url)).toThrow(GoogleDeniedError);
  });
});

describe('GoogleHttp denial', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  it('rejects every forbidden call before fetch is invoked and logs it as denied', async () => {
    const stub = new StubFetch();
    const http = new GoogleHttp({
      fetch: stub.fetch,
      actionLog: w.app.actionLog,
      log: pino({ level: 'silent' }),
      agentOf: async () => w.alex.agent.id,
    });
    for (const [method, url] of FORBIDDEN) {
      const err = await http.request({ method, url, ownerId: w.alex.owner.id, accessToken: 'tok' }).catch((e: unknown) => e);
      expect(err, `${method} ${url}`).toBeInstanceOf(GoogleDeniedError);
      expect((err as GoogleDeniedError).safeMessage).toBe("That Google action isn't allowed.");
    }
    expect(stub.calls).toEqual([]);
    const denied = await w.actions({ action: 'google.denied' });
    expect(denied).toHaveLength(FORBIDDEN.length);
    expect(denied[0]).toMatchObject({ agent_id: w.alex.agent.id, detail: { method: 'POST', ownerId: w.alex.owner.id } });
    // The query is never logged (it could carry anything).
    expect(JSON.stringify(denied)).not.toContain('access_token=');
  });

  it('a denied URL with control characters or lone surrogates is still denied and audited (jsonb-safe)', async () => {
    const stub = new StubFetch();
    const http = new GoogleHttp({ fetch: stub.fetch, actionLog: w.app.actionLog, log: pino({ level: 'silent' }), agentOf: async () => w.alex.agent.id });
    const urls = [`${GM}/messages/send\u0000`, `${GM}/messages/\ud800x`, `${GM}/messages/a\u001f\u007f`];
    for (const url of urls) {
      await expect(http.request({ method: 'POST', url, ownerId: w.alex.owner.id })).rejects.toBeInstanceOf(GoogleDeniedError);
    }
    expect(stub.calls).toEqual([]);
    const denied = await w.actions({ action: 'google.denied' });
    expect(denied).toHaveLength(urls.length);
    expect(JSON.stringify(denied)).toContain('send\\\\x00');
  });

  it('an action-log failure never masks the denial', async () => {
    const stub = new StubFetch();
    const failing = { write: async () => Promise.reject(new Error('db down')) } as unknown as typeof w.app.actionLog;
    const http = new GoogleHttp({ fetch: stub.fetch, actionLog: failing, log: pino({ level: 'silent' }), agentOf: async () => null });
    await expect(http.request({ method: 'POST', url: `${GM}/messages/send` })).rejects.toBeInstanceOf(GoogleDeniedError);
    expect(stub.calls).toEqual([]);
  });
});
