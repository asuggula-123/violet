import { z } from 'zod';
import { formatRange, isoInstant } from '../brain/time.js';
import { sanitize } from '../core/sanitize.js';
import type { ApprovalKind } from './types.js';

export const MAX_EVENT_MS = 7 * 86_400_000;

/** Postgres cannot store NUL in text or jsonb: it is dropped before validation of the rest. */
const text = (max: number, min = 0) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/\u0000/g, '').trim())
    .pipe(z.string().min(min));

export const calendarEventPayload = z
  .object({
    title: text(200, 1),
    start: isoInstant,
    end: isoInstant,
    location: text(300).optional(),
    description: text(2000).optional(),
  })
  .refine((p) => Date.parse(p.end) > Date.parse(p.start), { message: 'end must be after start', path: ['end'] })
  .refine((p) => Date.parse(p.end) - Date.parse(p.start) <= MAX_EVENT_MS, { message: 'an event can last at most 7 days', path: ['end'] });

export type CalendarEventPayload = z.infer<typeof calendarEventPayload>;

const title = (p: CalendarEventPayload) => sanitize(p.title, 80);
const when = (p: CalendarEventPayload, timezone: string) => formatRange(new Date(p.start), new Date(p.end), timezone);

/** `calendar_event`: one event on the owner's own calendar. */
export const calendarEventKind: ApprovalKind<CalendarEventPayload> = {
  schema: calendarEventPayload,

  render: (p, { timezone }) => `${title(p)} — ${when(p, timezone)}. Book it?`,

  async onApproved({ approval, owner, calendar }) {
    const p = calendarEventPayload.parse(approval.payload);
    const result = await calendar.executeApproved(approval.id);
    if (result.ok) return `Booked: ${sanitize(`${title(p)} — ${when(p, owner.timezone)}`, 200)}.`;
    return `I couldn't book #${approval.ref}: ${sanitize(result.reason, 150)}.`;
  },

  async onDenied({ approval }) {
    return `Okay, I won't book #${approval.ref}.`;
  },

  booked: (p, { timezone }) => `${title(p)} — ${when(p, timezone)}`,

  // Once the event has started, a yes is too late: the approval expires at the start.
  latestExpiry: (p) => new Date(p.start),

  calendarEvents: (p) => [
    {
      title: p.title,
      start: new Date(p.start),
      end: new Date(p.end),
      ...(p.location ? { location: p.location } : {}),
      ...(p.description ? { description: p.description } : {}),
    },
  ],
};
