/** Wall-clock time in an IANA zone → instant, without a date library. */

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
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isValidZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** Zone offset (ms, local minus UTC) at a given instant. */
function offsetAt(zone: string, utcMs: number): number {
  const parts = formatter(zone).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const DAY_MS = 86_400_000;

/**
 * Wall time fields (month 1–12) in `zone` → UTC instant.
 * A wall time inside a DST gap (it does not exist) resolves forward by the gap's
 * length, using the pre-transition offset — Temporal's 'compatible' mode. So
 * 02:30 on a New York spring-forward day is 03:30 EDT, and a date whose midnight
 * is skipped (America/Santiago, America/Havana) starts at the transition instant.
 */
export function zonedToUtc(zone: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // Offsets are within ±14h, so these samples fall on either side of the real instant
  // (zones change offset at most once in any two days).
  const before = offsetAt(zone, wall - DAY_MS);
  const after = offsetAt(zone, wall + DAY_MS);
  const valid = (offset: number) => offsetAt(zone, wall - offset) === offset;
  // Overlap (both valid): the earlier instant, i.e. the pre-transition offset.
  if (valid(before)) return new Date(wall - before);
  if (valid(after)) return new Date(wall - after);
  // Gap (neither valid): pre-transition offset, which lands past the transition.
  return new Date(wall - before);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;

/** The first instant of a `YYYY-MM-DD` date in `zone` (midnight, or the transition if midnight is skipped). */
export function dateInZone(date: string, zone: string): Date | null {
  const m = DATE_ONLY.exec(date);
  return m ? zonedToUtc(zone, Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** RFC 3339 with an offset is absolute; without one it is wall time in `zone`. */
export function dateTimeInZone(value: string, zone: string): Date | null {
  if (WITH_OFFSET.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  const m = LOCAL_DATE_TIME.exec(value);
  if (!m) return null;
  return zonedToUtc(zone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}
