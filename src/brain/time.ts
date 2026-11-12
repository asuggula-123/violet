import { z } from 'zod';

/** ISO 8601 date-time with an explicit offset (`Z` or `±hh:mm`). Anything else is rejected. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const isoInstant = z
  .string()
  .regex(ISO_WITH_OFFSET, 'must be ISO 8601 with an explicit offset, like 2026-11-13T19:00:00-05:00')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'is not a valid date-time');

export function parseInstant(s: string): Date {
  if (!ISO_WITH_OFFSET.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`not an ISO instant with offset: ${s}`);
  return new Date(s);
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  monthName: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(d: Date, timeZone: string): Parts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const month = Number(p.month);
  return {
    year: Number(p.year),
    month,
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: String(p.weekday),
    monthName: MONTHS[month - 1] ?? '',
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `2026-11-13T19:00:00-05:00`: the instant written in the zone's local time with its offset. */
export function isoInZone(d: Date, timeZone: string): string {
  const p = partsIn(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `Fri Nov 13` */
export function formatDay(d: Date, timeZone: string): string {
  const p = partsIn(d, timeZone);
  return `${p.weekday} ${p.monthName} ${p.day}`;
}

function clock12(p: Parts): { text: string; meridiem: 'AM' | 'PM' } {
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return { text: `${h}:${pad(p.minute)}`, meridiem: p.hour < 12 ? 'AM' : 'PM' };
}

/** `7:00 PM` */
export function formatTime(d: Date, timeZone: string): string {
  const c = clock12(partsIn(d, timeZone));
  return `${c.text} ${c.meridiem}`;
}

/** `Fri Nov 13, 7:00 PM` */
export function formatDateTime(d: Date, timeZone: string): string {
  return `${formatDay(d, timeZone)}, ${formatTime(d, timeZone)}`;
}

/** `Fri Nov 13, 7:00–8:30 PM` · `Fri Nov 13, 11:00 AM – 1:00 PM` · `Fri Nov 13, 11:00 PM – Sat Nov 14, 1:00 AM` */
export function formatRange(start: Date, end: Date, timeZone: string): string {
  const day = formatDay(start, timeZone);
  if (formatDay(end, timeZone) !== day) return `${formatDateTime(start, timeZone)} – ${formatDateTime(end, timeZone)}`;
  const a = clock12(partsIn(start, timeZone));
  const b = clock12(partsIn(end, timeZone));
  if (a.meridiem === b.meridiem) return `${day}, ${a.text}–${b.text} ${b.meridiem}`;
  return `${day}, ${a.text} ${a.meridiem} – ${b.text} ${b.meridiem}`;
}

/** P3: an event may start at most this far ahead (request_calendar_event, the Envoy's propose/accept). */
export const MAX_DAYS_AHEAD = 366;

/** Whether `start` is within MAX_DAYS_AHEAD of `now`. */
export function withinHorizon(start: Date, now: Date): boolean {
  return start.getTime() <= now.getTime() + MAX_DAYS_AHEAD * 86_400_000;
}

/** Whole minutes only: the prompt shows times to the minute, so nothing finer may be booked or sent. */
export function wholeMinute(d: Date): boolean {
  return d.getTime() % 60_000 === 0;
}

/** The local wall time, to the minute (`2026-11-01T01:30`). */
const wallMinute = (d: Date, tz: string) => isoInZone(d, tz).slice(0, 16);
/** `-04:00` */
const offsetOf = (d: Date, tz: string) => isoInZone(d, tz).slice(19);
const yearOf = (d: Date, tz: string) => Number(isoInZone(d, tz).slice(0, 4));

/**
 * Whether another instant near `d` reads the same local wall time (the repeated hour when the
 * clocks go back). Offset changes are at most two hours, so instants up to 2 h away are checked.
 */
export function ambiguousLocalTime(d: Date, tz: string): boolean {
  // Fast path: the same offset 2 h before and after means no change near d, so no repeat.
  const off = offsetOf(d, tz);
  if (offsetOf(new Date(d.getTime() - 120 * 60_000), tz) === off && offsetOf(new Date(d.getTime() + 120 * 60_000), tz) === off) return false;
  const wall = wallMinute(d, tz);
  return [-120, -90, -60, -30, 30, 60, 90, 120].some((m) => wallMinute(new Date(d.getTime() + m * 60_000), tz) === wall);
}

/**
 * The one time text of everything an owner says yes to, and of the lines that report it
 * (approval prompts, Booked and booking-failure lines, the release window): the text
 * determines the (start, end) pair, to the minute, exactly. It is the `formatRange` text, plus
 * the year whenever the start or the end is not in the owner's local year of `now` (the time
 * of the request; unknown → always shown), and the UTC offset for a local time that occurs
 * twice (the DST fall-back hour).
 */
export function exactRange(start: Date, end: Date, tz: string, now?: Date): string {
  const showYear = now === undefined || yearOf(start, tz) !== yearOf(now, tz) || yearOf(end, tz) !== yearOf(now, tz);
  const amb = (d: Date) => ambiguousLocalTime(d, tz);
  if (!showYear && !amb(start) && !amb(end)) return formatRange(start, end, tz);
  const one = (d: Date) => `${formatDay(d, tz)}${showYear ? ` ${yearOf(d, tz)}` : ''}, ${formatTime(d, tz)}${amb(d) ? ` (UTC${offsetOf(d, tz)})` : ''}`;
  return `${one(start)} – ${one(end)}`;
}
