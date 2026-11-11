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
