/** Owner-local calendar math with Intl only (no date library). */
import { dateInZone, zonedToUtc } from '../google/time.js';

export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'long',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function localParts(zone: string, at: Date): LocalParts {
  const parts = formatter(zone).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: get('weekday'),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The owner-local calendar date of an instant, `YYYY-MM-DD`. */
export function localDate(zone: string, at: Date): string {
  const p = localParts(zone, at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` date (no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** First instant of a local date (23 or 25 hours long on DST days). */
export function startOfLocalDate(zone: string, date: string): Date {
  const start = dateInZone(date, zone);
  if (!start) throw new Error(`bad date ${date}`);
  return start;
}

/** Quiet hours are [22:00, 07:00) owner-local. */
export function isQuietHours(zone: string, at: Date): boolean {
  const { hour } = localParts(zone, at);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** The 07:00 owner-local that ends the quiet hours `at` falls in (call only inside quiet hours). */
export function quietHoursEnd(zone: string, at: Date): Date {
  const p = localParts(zone, at);
  const today = localDate(zone, at);
  const date = p.hour >= QUIET_START_HOUR ? addDays(today, 1) : today;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return zonedToUtc(zone, y, m, d, QUIET_END_HOUR);
}
