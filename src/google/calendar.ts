import { createHash } from 'node:crypto';
import { url, type GoogleApi } from './api.js';
import { GoogleConflictError, GoogleNotFoundError, GoogleRequestError } from './errors.js';
import { dateInZone, dateTimeInZone, isValidZone } from './time.js';
import type { BusyInterval, CalendarEvent, CalendarProvider, NewCalendarEvent } from './types.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
const EVENTS = `${BASE}/calendars/primary/events`;
const PAGE_SIZE = 250;
/**
 * Hard stop for pagination: at most 20 pages (5,000 events) per listEvents. Reaching it
 * with more pages left is an error, never a silently partial list.
 */
const MAX_PAGES = 20;

interface GTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: GTime;
  end?: GTime;
  attendees?: { email?: string; resource?: boolean }[];
}

interface GEventList {
  items?: GEvent[];
  nextPageToken?: string;
  timeZone?: string;
}

interface GFreeBusy {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }>;
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/**
 * Client-supplied event id: lowercase base32hex of sha256(idempotencyKey). Google
 * allows only a–v and 0–9, 5–1024 characters; this is always 52.
 */
export function eventIdFor(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey, 'utf8').digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** Google Calendar on the owner's "primary" calendar. */
export class GoogleCalendar implements CalendarProvider {
  constructor(private readonly api: GoogleApi) {}

  async freeBusy(ownerId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const res = await this.api.call<GFreeBusy>(ownerId, 'calendarFreeBusy', {
      method: 'POST',
      url: `${BASE}/freeBusy`,
      json: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] },
    });
    const cal = res.calendars?.primary;
    if (!cal || (cal.errors && cal.errors.length > 0)) throw new GoogleRequestError('google freeBusy: no result for primary calendar');
    return (cal.busy ?? [])
      .map((b) => ({ start: new Date(Date.parse(b.start)), end: new Date(Date.parse(b.end)) }))
      .filter((b) => !Number.isNaN(b.start.getTime()) && !Number.isNaN(b.end.getTime()));
  }

  async listEvents(ownerId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await this.api.call<GEventList>(ownerId, 'calendarRead', {
        method: 'GET',
        url: url(EVENTS, {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: PAGE_SIZE,
          pageToken,
        }),
      });
      const zone = isValidZone(res.timeZone) ? res.timeZone : 'UTC';
      for (const item of res.items ?? []) {
        const ev = toEvent(item, zone);
        if (ev) out.push(ev);
      }
      pageToken = res.nextPageToken;
      if (!pageToken) return out;
    }
    throw new GoogleRequestError(`google events.list: more than ${MAX_PAGES} pages in the range; refusing a partial list`);
  }

  async createEvent(ownerId: string, ev: NewCalendarEvent, idempotencyKey: string): Promise<{ eventId: string }> {
    const id = eventIdFor(idempotencyKey);
    try {
      const res = await this.api.call<{ id?: string }>(ownerId, 'calendarWrite', {
        method: 'POST',
        url: url(EVENTS, { sendUpdates: 'none' }),
        json: {
          id,
          summary: ev.title,
          start: { dateTime: ev.start.toISOString() },
          end: { dateTime: ev.end.toISOString() },
          ...(ev.location ? { location: ev.location } : {}),
          ...(ev.description ? { description: ev.description } : {}),
        },
      });
      return { eventId: res.id ?? id };
    } catch (err) {
      // 409: an event with this id exists — this key was already booked (idempotency).
      if (err instanceof GoogleConflictError) return { eventId: id };
      throw err;
    }
  }

  /** Client-supplied ids are derived from the key, so no request is needed. */
  async eventIdForKey(_ownerId: string, idempotencyKey: string): Promise<string | null> {
    return eventIdFor(idempotencyKey);
  }

  async deleteEvent(ownerId: string, eventId: string): Promise<void> {
    try {
      await this.api.call(ownerId, 'calendarWrite', { method: 'DELETE', url: url(`${EVENTS}/${encodeURIComponent(eventId)}`, { sendUpdates: 'none' }) });
    } catch (err) {
      if (err instanceof GoogleNotFoundError) return; // 404/410: already gone
      throw err;
    }
  }
}

function toEvent(g: GEvent, calendarZone: string): CalendarEvent | null {
  if (!g.id || g.status === 'cancelled' || !g.start || !g.end) return null;
  const allDay = g.start.date !== undefined;
  const start = when(g.start, calendarZone);
  const end = when(g.end, calendarZone);
  if (!start || !end) return null;
  const attendees = (g.attendees ?? []).filter((a) => a.email && !a.resource).map((a) => a.email as string);
  return {
    id: g.id,
    title: g.summary ?? '(no title)',
    start,
    end,
    ...(allDay ? { allDay: true } : {}),
    ...(g.location ? { location: g.location } : {}),
    ...(g.description ? { description: g.description } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
  };
}

/** All-day dates are midnight in the calendar's zone (end date exclusive, as Google sends it). */
function when(t: GTime, calendarZone: string): Date | null {
  const zone = isValidZone(t.timeZone) ? t.timeZone : calendarZone;
  if (t.dateTime) return dateTimeInZone(t.dateTime, zone);
  if (t.date) return dateInZone(t.date, calendarZone);
  return null;
}
