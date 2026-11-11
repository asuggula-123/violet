import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventIdFor } from '../../../src/google/calendar.js';
import { GoogleNotFoundError, GoogleRequestError, GoogleTransientError } from '../../../src/google/errors.js';
import { zonedToUtc } from '../../../src/google/time.js';
import { bearer, createGoogleWorld, expectRefresh, SECRETS, type GoogleWorld } from './helpers.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const EVENTS = `${CAL}/calendars/primary/events`;
const from = new Date('2026-11-11T00:00:00.000Z');
const to = new Date('2026-11-18T00:00:00.000Z');

describe('eventIdFor', () => {
  it("is valid per Google's rules (base32hex a–v0–9, 5–1024 chars) and deterministic", () => {
    for (const key of ['a', 'approval:42:alex', '', 'ünïcødé', 'x'.repeat(5000)]) {
      const id = eventIdFor(key);
      expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
      expect(id).toHaveLength(52);
      expect(eventIdFor(key)).toBe(id);
    }
    expect(eventIdFor('k1')).not.toBe(eventIdFor('k2'));
  });

  it('is the base32hex encoding of sha256 (known vector)', () => {
    // sha256('') = e3 b0 …: bits 11100 01110 … → 28 's', 14 'e'
    expect(eventIdFor('').slice(0, 2)).toBe('se');
  });
});

describe('zonedToUtc', () => {
  it('handles offsets and DST', () => {
    expect(zonedToUtc('America/New_York', 2026, 11, 11).toISOString()).toBe('2026-11-11T05:00:00.000Z');
    expect(zonedToUtc('America/New_York', 2026, 7, 1).toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(zonedToUtc('Asia/Kolkata', 2026, 1, 1, 9, 30).toISOString()).toBe('2026-01-01T04:00:00.000Z');
    expect(zonedToUtc('UTC', 2026, 3, 8, 12).toISOString()).toBe('2026-03-08T12:00:00.000Z');
    // US DST start day: 02:30 does not exist; midnight is still EST.
    expect(zonedToUtc('America/New_York', 2026, 3, 8).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedToUtc('America/New_York', 2026, 3, 9).toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('resolves a DST gap forward and an overlap to the earlier instant', () => {
    // 02:30 does not exist in New York on 2026-03-08 → 03:30 EDT.
    expect(zonedToUtc('America/New_York', 2026, 3, 8, 2, 30).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedToUtc('America/New_York', 2026, 3, 8, 3).toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(zonedToUtc('Europe/London', 2026, 3, 29, 1, 30).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 01:30 happens twice on 2026-11-01 → the first (EDT).
    expect(zonedToUtc('America/New_York', 2026, 11, 1, 1, 30).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // Midnight skipped: the day starts at the transition (01:00 local), not in the previous day.
    expect(zonedToUtc('America/Santiago', 2026, 9, 6).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(zonedToUtc('America/Havana', 2026, 3, 8).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('GoogleCalendar', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    await gw.connect(gw.w.alex.owner.id);
    expectRefresh(gw.stub);
  });
  afterEach(async () => gw.close());

  const owner = () => gw.w.alex.owner.id;

  it('freeBusy posts the window for primary and maps busy intervals', async () => {
    gw.stub.expect({
      method: 'POST',
      url: `${CAL}/freeBusy`,
      check: (init) => {
        expect(bearer(init)).toBe(`Bearer ${SECRETS.accessToken}`);
        expect(JSON.parse(String(init.body))).toEqual({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] });
      },
      respond: {
        json: {
          kind: 'calendar#freeBusy',
          calendars: { primary: { busy: [{ start: '2026-11-12T15:00:00Z', end: '2026-11-12T16:00:00Z' }, { start: '2026-11-13T10:00:00-05:00', end: '2026-11-13T11:30:00-05:00' }] } },
        },
      },
    });
    expect(await gw.g.calendar.freeBusy(owner(), from, to)).toEqual([
      { start: new Date('2026-11-12T15:00:00Z'), end: new Date('2026-11-12T16:00:00Z') },
      { start: new Date('2026-11-13T15:00:00Z'), end: new Date('2026-11-13T16:30:00Z') },
    ]);
  });

  it('freeBusy with a per-calendar error is an error, not "free"', async () => {
    gw.stub.expect({ method: 'POST', url: `${CAL}/freeBusy`, respond: { json: { calendars: { primary: { errors: [{ reason: 'backendError' }] } } } } });
    await expect(gw.g.calendar.freeBusy(owner(), from, to)).rejects.toBeInstanceOf(GoogleRequestError);
  });

  it('listEvents: query, pagination, cancelled skipped, all-day, time zones, attendees', async () => {
    gw.stub.expect({
      method: 'GET',
      url: (u) => u.origin + u.pathname === EVENTS && !u.searchParams.has('pageToken'),
      check: (_i, u) => {
        expect(Object.fromEntries(u.searchParams)).toEqual({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '250',
        });
      },
      respond: {
        json: {
          timeZone: 'America/New_York',
          nextPageToken: 'page-2',
          items: [
            {
              id: 'ev1',
              status: 'confirmed',
              summary: 'Dentist',
              location: 'Main St',
              description: 'Bring card',
              start: { dateTime: '2026-11-12T09:00:00-05:00', timeZone: 'America/New_York' },
              end: { dateTime: '2026-11-12T10:00:00-05:00', timeZone: 'America/New_York' },
              attendees: [{ email: 'alex@example.test', self: true }, { email: 'sam@example.test' }, { email: 'room@resource.example', resource: true }, { displayName: 'no email' }],
            },
            { id: 'gone', status: 'cancelled' },
            { id: 'allday', summary: 'Trip', start: { date: '2026-11-14' }, end: { date: '2026-11-16' } },
          ],
        },
      },
    });
    gw.stub.expect({
      method: 'GET',
      url: (u) => u.searchParams.get('pageToken') === 'page-2',
      respond: {
        json: {
          timeZone: 'America/New_York',
          items: [
            // No offset: wall time in the event's own zone.
            { id: 'tokyo', summary: 'Call', start: { dateTime: '2026-11-15T09:00:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-11-15T09:30:00', timeZone: 'Asia/Tokyo' } },
            { id: 'utc', start: { dateTime: '2026-11-16T12:00:00Z' }, end: { dateTime: '2026-11-16T13:00:00Z' } },
            { id: 'broken', start: { dateTime: 'not a date' }, end: { dateTime: 'x' } },
          ],
        },
      },
    });
    const events = await gw.g.calendar.listEvents(owner(), from, to);
    expect(events).toEqual([
      {
        id: 'ev1',
        title: 'Dentist',
        start: new Date('2026-11-12T14:00:00Z'),
        end: new Date('2026-11-12T15:00:00Z'),
        location: 'Main St',
        description: 'Bring card',
        attendees: ['alex@example.test', 'sam@example.test'],
      },
      { id: 'allday', title: 'Trip', start: new Date('2026-11-14T05:00:00Z'), end: new Date('2026-11-16T05:00:00Z'), allDay: true },
      { id: 'tokyo', title: 'Call', start: new Date('2026-11-15T00:00:00Z'), end: new Date('2026-11-15T00:30:00Z') },
      { id: 'utc', title: '(no title)', start: new Date('2026-11-16T12:00:00Z'), end: new Date('2026-11-16T13:00:00Z') },
    ]);
    expect(gw.stub.pending).toBe(0);
  });

  it('all-day events use the calendar zone; an unknown zone falls back to UTC', async () => {
    gw.stub.expect({
      method: 'GET',
      url: (u) => u.pathname.endsWith('/events'),
      respond: { json: { timeZone: 'Not/AZone', items: [{ id: 'a', summary: 'Holiday', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }] } },
    });
    expect(await gw.g.calendar.listEvents(owner(), from, to)).toEqual([
      { id: 'a', title: 'Holiday', start: new Date('2026-11-20T00:00:00Z'), end: new Date('2026-11-21T00:00:00Z'), allDay: true },
    ]);
  });

  it('pagination is bounded, and hitting the bound is a typed error, not a partial list', async () => {
    for (let i = 0; i < 20; i += 1) {
      gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/events'), respond: { json: { items: [], nextPageToken: `p${i}` } } });
    }
    await expect(gw.g.calendar.listEvents(owner(), from, to)).rejects.toMatchObject({ code: 'request' });
    expect(gw.stub.pending).toBe(0);
    expect(gw.stub.calls).toHaveLength(21);
  });

  it('exactly 20 pages, the last without nextPageToken, is a complete list', async () => {
    for (let i = 0; i < 20; i += 1) {
      const items = [{ id: `e${i}`, status: 'confirmed', start: { dateTime: '2026-11-12T10:00:00Z' }, end: { dateTime: '2026-11-12T11:00:00Z' } }];
      gw.stub.expect({ method: 'GET', url: (u) => u.pathname.endsWith('/events'), respond: { json: { items, ...(i < 19 ? { nextPageToken: `p${i}` } : {}) } } });
    }
    expect(await gw.g.calendar.listEvents(owner(), from, to)).toHaveLength(20);
  });

  it('createEvent: client id from the idempotency key, sendUpdates=none, exact body', async () => {
    const id = eventIdFor('approval-7');
    const start = new Date('2026-11-13T19:00:00Z');
    const end = new Date('2026-11-13T20:30:00Z');
    gw.stub.expect({
      method: 'POST',
      url: `${EVENTS}?sendUpdates=none`,
      check: (init) => {
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({
          id,
          summary: 'Dinner',
          start: { dateTime: '2026-11-13T19:00:00.000Z' },
          end: { dateTime: '2026-11-13T20:30:00.000Z' },
          location: 'Home',
        });
      },
      respond: { json: { id, status: 'confirmed' } },
    });
    expect(await gw.g.calendar.createEvent(owner(), { title: 'Dinner', start, end, location: 'Home' }, 'approval-7')).toEqual({ eventId: id });
  });

  it('createEvent: 409 means already created — same id returned (idempotency)', async () => {
    const id = eventIdFor('approval-7');
    const ev = { title: 'Dinner', start: new Date('2026-11-13T19:00:00Z'), end: new Date('2026-11-13T20:30:00Z') };
    gw.stub.expect({ method: 'POST', url: `${EVENTS}?sendUpdates=none`, respond: { json: { id } } });
    gw.stub.expect({
      method: 'POST',
      url: `${EVENTS}?sendUpdates=none`,
      check: (init) => expect(JSON.parse(String(init.body)).id).toBe(id),
      respond: { status: 409, json: { error: { code: 409, errors: [{ reason: 'duplicate' }] } } },
    });
    expect(await gw.g.calendar.createEvent(owner(), ev, 'approval-7')).toEqual({ eventId: id });
    expect(await gw.g.calendar.createEvent(owner(), ev, 'approval-7')).toEqual({ eventId: id });
  });

  it('createEvent: a 5xx is a retryable typed error, not retried here', async () => {
    gw.stub.expect({ method: 'POST', url: `${EVENTS}?sendUpdates=none`, respond: { status: 503, json: { error: { code: 503 } } } });
    const err = await gw.g.calendar.createEvent(owner(), { title: 'x', start: from, end: to }, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleTransientError);
    expect(gw.stub.pending).toBe(0);
  });

  it('deleteEvent: DELETE with sendUpdates=none; 404 and 410 count as already gone', async () => {
    gw.stub.expect({ method: 'DELETE', url: `${EVENTS}/abcde12345?sendUpdates=none`, respond: { status: 204 } });
    gw.stub.expect({ method: 'DELETE', url: `${EVENTS}/abcde12345?sendUpdates=none`, respond: { status: 410, json: { error: { code: 410, errors: [{ reason: 'deleted' }] } } } });
    gw.stub.expect({ method: 'DELETE', url: `${EVENTS}/abcde12345?sendUpdates=none`, respond: { status: 404, json: { error: { code: 404 } } } });
    for (let i = 0; i < 3; i += 1) await gw.g.calendar.deleteEvent(owner(), 'abcde12345');
    gw.stub.expect({ method: 'DELETE', url: `${EVENTS}/abcde12345?sendUpdates=none`, respond: { status: 500, json: {} } });
    await expect(gw.g.calendar.deleteEvent(owner(), 'abcde12345')).rejects.toBeInstanceOf(GoogleTransientError);
  });

  it('an event id that would leave the allow-list is denied, not sent', async () => {
    await expect(gw.g.calendar.deleteEvent(owner(), '../../../users/me/calendarList')).rejects.toMatchObject({ code: 'denied' });
    expect(gw.stub.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('an event id carrying a query string cannot change sendUpdates; the call is denied and logged', async () => {
    await expect(gw.g.calendar.deleteEvent(owner(), 'abc?sendUpdates=all&sendUpdates=')).rejects.toMatchObject({ code: 'denied' });
    await expect(gw.g.calendar.deleteEvent(owner(), 'abc#x')).rejects.toMatchObject({ code: 'denied' });
    expect(gw.stub.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect((await gw.w.actions({ action: 'google.denied' })).length).toBeGreaterThanOrEqual(2);
  });

  it('GoogleNotFoundError is typed with a safe message', () => {
    const e = new GoogleNotFoundError('x', 404);
    expect(e.safeMessage).toBe("That wasn't found in Google.");
  });
});
