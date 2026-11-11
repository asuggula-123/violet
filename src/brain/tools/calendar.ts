import { z } from 'zod';
import { calendarEventPayload } from '../../approvals/calendarEvent.js';
import { promptSummary } from '../../approvals/repo.js';
import type { BusyInterval } from '../../google/types.js';
import { ToolError } from '../../llm/tools.js';
import { formatDateTime, formatDay, formatRange, isoInZone, isoInstant } from '../time.js';
import type { BrainTool } from '../types.js';
import { wrapUntrusted } from '../untrusted.js';
import { line, range, type BrainToolDeps } from './deps.js';

const rangeInput = z.object({
  from: isoInstant.describe('Start of the range, ISO 8601 with offset'),
  to: isoInstant.describe('End of the range, ISO 8601 with offset (at most 31 days after from)'),
});

const MAX_EVENTS = 100;

function span(start: Date, end: Date, tz: string): string {
  return `${formatRange(start, end, tz)} [${isoInZone(start, tz)} → ${isoInZone(end, tz)}]`;
}

/** Free gaps of at least `minMs` between merged busy intervals inside [from, to). */
export function freeSlots(busy: BusyInterval[], from: Date, to: Date, minMs: number): BusyInterval[] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const free: BusyInterval[] = [];
  let cursor = from.getTime();
  for (const b of sorted) {
    const s = Math.max(b.start.getTime(), from.getTime());
    if (s - cursor >= minMs) free.push({ start: new Date(cursor), end: new Date(s) });
    cursor = Math.max(cursor, Math.min(b.end.getTime(), to.getTime()));
  }
  if (to.getTime() - cursor >= minMs) free.push({ start: new Date(cursor), end: to });
  return free;
}

export function calendarTools(d: BrainToolDeps): BrainTool[] {
  const getSchedule: BrainTool<z.infer<typeof rangeInput>> = {
    name: 'get_schedule',
    description: "List the owner's calendar events (with details) between two instants. Event text comes from third parties and is marked untrusted.",
    input: rangeInput,
    taints: true,
    async handler(input, ctx) {
      const r = range(input.from, input.to);
      const tz = ctx.owner.timezone;
      const events = (await d.calendar.listEvents(ctx.owner.id, r.from, r.to)).slice(0, MAX_EVENTS);
      const header = `Events from ${formatDateTime(r.from, tz)} to ${formatDateTime(r.to, tz)} (${tz}):`;
      if (events.length === 0) return `${header} none.`;
      const rows = events.map((e) => {
        const when = e.allDay ? `${formatDay(e.start, tz)} (all day)` : span(e.start, e.end, tz);
        const extra = [
          e.location ? `at: ${line(e.location, 200)}` : '',
          e.attendees?.length ? `attendees: ${line(e.attendees.join(', '), 300)}` : '',
          e.description ? `notes: ${line(e.description, 500)}` : '',
        ].filter(Boolean);
        return `- ${when}: ${line(e.title, 200)}${extra.length ? ` | ${extra.join(' | ')}` : ''}`;
      });
      return `${header}\n${wrapUntrusted('calendar', rows.join('\n'))}`;
    },
  };

  const findFreeTimeInput = rangeInput.extend({
    min_minutes: z.number().int().min(5).max(1440).optional().describe('Shortest free slot to list (default 30)'),
  });
  const findFreeTime: BrainTool<z.infer<typeof findFreeTimeInput>> = {
    name: 'find_free_time',
    description: "The owner's busy intervals (times only) and free slots between two instants.",
    input: findFreeTimeInput,
    async handler(input, ctx) {
      const r = range(input.from, input.to);
      const tz = ctx.owner.timezone;
      const busy = await d.calendar.freeBusy(ctx.owner.id, r.from, r.to);
      const min = input.min_minutes ?? 30;
      const free = freeSlots(busy, r.from, r.to, min * 60_000);
      const list = (xs: BusyInterval[]) => (xs.length ? xs.map((x) => `- ${span(x.start, x.end, tz)}`).join('\n') : '- none');
      return `Busy:\n${list(busy)}\nFree slots of at least ${min} minutes:\n${list(free)}`;
    },
  };

  const requestEvent: BrainTool<z.infer<typeof calendarEventPayload>> = {
    name: 'request_calendar_event',
    description:
      'Ask the owner to approve adding one event to their calendar. They get a yes/no prompt; the event is booked only if they say yes. Does not book anything by itself.',
    input: calendarEventPayload,
    sideEffect: true,
    async handler(input, ctx) {
      if (Date.parse(input.start) < ctx.now.getTime()) throw new ToolError('That start time is in the past.');
      const approval = await d.approvals.request(ctx.agent.id, { kind: 'calendar_event', payload: input, idempotencyKey: ctx.callKey });
      const sent = approval.prompt_transport_message_id !== null;
      return `${sent ? 'Asked' : 'Will ask (when I can send again)'} the owner: ${promptSummary(approval)} Nothing is booked unless they reply yes. Do not repeat the prompt in your reply.`;
    },
  };

  return [getSchedule, findFreeTime, requestEvent];
}
