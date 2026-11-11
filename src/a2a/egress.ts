import { addMs } from '../clock.js';
import type { CalendarEvent } from '../google/types.js';
import type { A2ADeps } from './deps.js';
import { A2A_LIMITS, DAY_MS } from './types.js';
import { privateMatches } from './words.js';

export type EgressResult = { ok: true } | { ok: false; matches: number } | { ok: 'unreadable' };

/**
 * EgressGuard (I11), run on every release: the private calendar phrases are the titles,
 * locations, descriptions and attendees of the owner's events in the next 31 days and in
 * the conversation window. A release containing one the owner did not type in this turn's
 * message is blocked (see words.ts privateMatches for the exact rule). A calendar that
 * cannot be read gives 'unreadable': the caller holds the release for the owner's yes.
 */
export async function egressCheck(
  d: Pick<A2ADeps, 'calendar' | 'clock'>,
  q: { ownerId: string; texts: string[]; ownerText: string; names: string[]; window: { start: Date; end: Date } | null },
): Promise<EgressResult> {
  const now = d.clock.now();
  const ranges = [{ start: now, end: addMs(now, A2A_LIMITS.ownWindowDays * DAY_MS) }];
  if (q.window) ranges.push(q.window);
  const events = new Map<string, CalendarEvent>();
  try {
    for (const r of ranges) for (const e of await d.calendar.listEvents(q.ownerId, r.start, r.end)) events.set(e.id, e);
  } catch {
    return { ok: 'unreadable' };
  }
  const fields = [...events.values()].flatMap((e) => [e.title, e.location ?? '', e.description ?? '', ...(e.attendees ?? [])]).filter(Boolean);
  const matches = q.texts.reduce((n, t) => n + privateMatches(t, q.ownerText, fields, q.names).length, 0);
  return matches === 0 ? { ok: true } : { ok: false, matches };
}
