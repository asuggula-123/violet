import { z } from 'zod';
import { exactRange, isoInstant, wholeMinute } from '../brain/time.js';
import { sanitize } from '../core/sanitize.js';
import { canonicalEventText, quotedField } from './eventText.js';
import type { ApprovalKind } from './types.js';

export const MAX_EVENT_MS = 7 * 86_400_000;

/**
 * Stored exactly as the prompt shows it (canonicalEventText: one line, folded, NFKC, no number
 * signs; NUL dropped, which Postgres cannot store), so the owner's yes covers every character.
 */
const text = (max: number, min = 0) => z.string().max(max).transform(canonicalEventText).pipe(z.string().min(min).max(max));

export const calendarEventPayload = z
  .object({
    title: text(200, 1),
    start: isoInstant,
    end: isoInstant,
    location: text(300).optional(),
  })
  // No description: the one-line prompt cannot show one, and nothing is booked that the owner did
  // not see. An older stored payload that has one is booked without it (unknown keys are dropped).
  .refine((p) => wholeMinute(new Date(p.start)) && wholeMinute(new Date(p.end)), { message: 'times must be whole minutes (no seconds)', path: ['start'] })
  .refine((p) => Date.parse(p.end) > Date.parse(p.start), { message: 'end must be after start', path: ['end'] })
  .refine((p) => Date.parse(p.end) - Date.parse(p.start) <= MAX_EVENT_MS, { message: 'an event can last at most 7 days', path: ['end'] });

export type CalendarEventPayload = z.infer<typeof calendarEventPayload>;

/**
 * `Dinner — Fri Nov 13, 7:00–8:30 PM[ at “Luigi's”]`: the whole title, the whole location and the
 * exact time (exactRange: the year when not this year, the offset in a repeated hour). Never cut:
 * request_calendar_event refuses what does not fit the prompt.
 */
export function eventLine(p: CalendarEventPayload, timezone: string, now: Date): string {
  const at = p.location ? ` at ${quotedField(p.location)}` : '';
  return `${p.title} — ${exactRange(new Date(p.start), new Date(p.end), timezone, now)}${at}`;
}

/** F2: paused between the yes and the write (the reply waits too; on resume the booking runs and its line is sent). */
export const HELD_SOLO = "You're paused, so the booking waits: it goes ahead when you text resume.";

/** `calendar_event`: one event on the owner's own calendar. */
export const calendarEventKind: ApprovalKind<CalendarEventPayload> = {
  schema: calendarEventPayload,

  render: (p, { timezone, now }) => `${eventLine(p, timezone, now)}. Book it?`,

  async onApproved({ approval, owner, calendar, now }) {
    const p = calendarEventPayload.parse(approval.payload);
    const result = await calendar.executeApproved(approval.id);
    if (result.ok) return `Booked: ${eventLine(p, owner.timezone, now)}.`;
    if (result.held) return HELD_SOLO;
    return `I couldn't book #${approval.ref}: ${sanitize(result.reason, 200)}.`;
  },

  async onDenied({ approval }) {
    return `Okay, I won't book #${approval.ref}.`;
  },

  booked: (p, { timezone, now }) => eventLine(p, timezone, now),

  // Once the event has started, a yes is too late: the approval expires at the start.
  latestExpiry: (p) => new Date(p.start),

  calendarEvents: (p) => [
    {
      title: p.title,
      start: new Date(p.start),
      end: new Date(p.end),
      ...(p.location ? { location: p.location } : {}),
    },
  ],
};
