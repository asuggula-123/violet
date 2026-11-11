import type { Logger } from 'pino';
import type { FlagService } from '../core/flags.js';
import type { Repos } from '../core/repos/index.js';
import { quote } from '../core/sanitize.js';
import type { CalendarEvent, CalendarProvider } from '../google/types.js';
import { GoogleNotConfiguredError } from '../google/unconfigured.js';
import { addDays, isQuietHours, localDate, localParts, quietHoursEnd } from './time.js';

export const CONFLICT_LOOKAHEAD_MS = 36 * 3_600_000;
export const MAX_CONFLICTS_PER_RUN = 3;
const TITLE_MAX = 80;

export type ConflictPair = [CalendarEvent, CalendarEvent];

/**
 * Overlapping timed events, earliest overlap first. Touching (end == start) is not an
 * overlap; all-day and zero-length events never conflict. (CalendarEvent carries no
 * free/cancelled marker: the real provider already drops cancelled events.)
 */
export function findConflicts(events: CalendarEvent[]): ConflictPair[] {
  const timed = events
    .filter((e) => !e.allDay && e.end.getTime() > e.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i]!;
    for (let j = i + 1; j < timed.length && timed[j]!.start.getTime() < a.end.getTime(); j++) {
      if (timed[j]!.id !== a.id) pairs.push([a, timed[j]!]);
    }
  }
  return pairs.sort((x, y) => x[1].start.getTime() - y[1].start.getTime() || x[0].start.getTime() - y[0].start.getTime());
}

/** Both event ids with their start instants, sorted: a moved event makes a new pair. */
export function conflictKey([a, b]: ConflictPair): string {
  return `conflict:${[`${a.id}@${a.start.toISOString()}`, `${b.id}@${b.start.toISOString()}`].sort().join('|')}`;
}

function dayWord(zone: string, now: Date, at: Date): string {
  const today = localDate(zone, now);
  const date = localDate(zone, at);
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return `on ${localParts(zone, at).weekday}`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockTime(zone: string, at: Date): { time: string; period: string } {
  let f = clockFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true });
    clockFormatters.set(zone, f);
  }
  const parts = f.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { time: `${get('hour')}:${get('minute')}`, period: get('dayPeriod').toUpperCase() };
}

/** "3:00-4:00 PM", or "11:30 AM-12:30 PM" across noon. */
function span(zone: string, e: CalendarEvent): string {
  const s = clockTime(zone, e.start);
  const t = clockTime(zone, e.end);
  return s.period === t.period ? `${s.time}-${t.time} ${t.period}` : `${s.time} ${s.period}-${t.time} ${t.period}`;
}

/** One line, rendered by code; titles may be written by third parties (invites), so they are quoted (I13). */
export function conflictText(zone: string, now: Date, [a, b]: ConflictPair): string {
  const dayA = dayWord(zone, now, a.start);
  const dayB = dayWord(zone, now, b.start);
  const title = (e: CalendarEvent) => quote(e.title.trim() === '' ? '(no title)' : e.title, TITLE_MAX);
  return `Conflict ${dayA}: ${title(a)} ${span(zone, a)} overlaps ${title(b)} ${dayB === dayA ? '' : `${dayB} `}${span(zone, b)}.`;
}

/**
 * Hourly per active agent (8.5): one 'now' flag per new overlapping pair in the next 36 h,
 * at most MAX_CONFLICTS_PER_RUN per run. Never throws into the scheduler: a provider or
 * delivery error is one log line (no event details) and no flag.
 */
export function createConflictCheck(deps: { repos: Repos; calendar: CalendarProvider; flags: FlagService; log: Logger }) {
  const { repos, calendar, flags, log } = deps;
  // Google not configured on the server fails every agent the same way: one line per
  // scheduler run (all agents of a run share `now`), not one per agent.
  let notConfiguredLoggedAt: number | null = null;
  return async (agentId: string, now: Date): Promise<void> => {
    try {
      const agent = await repos.agents.get(agentId);
      const owner = agent ? await repos.owners.get(agent.owner_id) : null;
      if (!owner) return;
      const events = await calendar.listEvents(owner.id, now, new Date(now.getTime() + CONFLICT_LOOKAHEAD_MS));
      // A flag raised in quiet hours is texted at 07:00 (I17): its day words are rendered
      // for that moment, and an overlap over by then is not worth a text.
      const readAt = isQuietHours(owner.timezone, now) ? quietHoursEnd(owner.timezone, now) : now;
      let raised = 0;
      for (const pair of findConflicts(events)) {
        if (raised >= MAX_CONFLICTS_PER_RUN) break;
        if (Math.min(pair[0].end.getTime(), pair[1].end.getTime()) <= readAt.getTime()) continue;
        const dedupeKey = conflictKey(pair);
        if (await repos.flags.findByDedupeKey(agentId, dedupeKey)) continue;
        raised += 1;
        await flags.raise(agentId, { kind: 'calendar_conflict', urgency: 'now', text: conflictText(owner.timezone, readAt, pair), dedupeKey });
      }
    } catch (err) {
      if (err instanceof GoogleNotConfiguredError) {
        if (notConfiguredLoggedAt === now.getTime()) return;
        notConfiguredLoggedAt = now.getTime();
        log.warn({ error: err.name, code: err.code }, 'conflict check skipped');
        return;
      }
      const e = err as { name?: unknown; code?: unknown };
      log.warn({ agentId, error: typeof e?.name === 'string' ? e.name : 'Error', code: typeof e?.code === 'string' ? e.code : undefined }, 'conflict check skipped');
    }
  };
}
