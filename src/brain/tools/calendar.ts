import { z } from 'zod';
import { calendarEventKind, calendarEventPayload } from '../../approvals/calendarEvent.js';
import { promptFits } from '../../approvals/service.js';
import type { BusyInterval } from '../../google/types.js';
import { ToolError } from '../../llm/tools.js';
import { formatDateTime, formatDay, formatRange, isoInZone, isoInstant, MAX_DAYS_AHEAD, withinHorizon } from '../time.js';
import type { BrainTool } from '../types.js';
import { wrapUntrusted } from '../untrusted.js';
import { line, range, type BrainToolDeps } from './deps.js';

const rangeInput = z.object({
  from: isoInstant.describe('Start of the range, ISO 8601 with offset'),
  to: isoInstant.describe('End of the range, ISO 8601 with offset (at most 31 days after from)'),
});

const MAX_EVENTS = 100;

/** Fixed tool results of request_calendar_event: true whatever the model does next. */
export const CALENDAR_TOOL_TEXT = Object.freeze({
  requested:
    'The owner gets a yes/no prompt for this right after your reply. Do not repeat it or ask them to confirm in your own words. Nothing is booked unless they say yes.',
  paused: 'I am paused: the owner will get a yes/no prompt for this when I can send again. Nothing is booked unless they say yes.',
  past: 'That start time is in the past.',
  tooFar: `That start is more than ${MAX_DAYS_AHEAD} days ahead. I can only ask about events that start within ${MAX_DAYS_AHEAD} days.`,
  tooLong: 'The owner must see the whole title and location in one short prompt line, and this does not fit. Use a shorter title or location.',
  /** P13: the time is part of a plan with another owner that waits for both yeses. */
  jointPending: (ref: number, answered = false) =>
    answered
      ? `That time overlaps the plan in prompt #${ref}, which the owner already approved and which now waits for the other owner's yes. Do not book it separately.`
      : `That time overlaps the plan in prompt #${ref}, which waits for both owners' yes. Do not book it separately: tell the owner to answer prompt #${ref} instead.`,
});

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
      const start = new Date(input.start);
      const end = new Date(input.end);
      if (start.getTime() < ctx.now.getTime()) throw new ToolError(CALENDAR_TOOL_TEXT.past);
      if (!withinHorizon(start, ctx.now)) throw new ToolError(CALENDAR_TOOL_TEXT.tooFar);
      // What you see is what gets booked: the prompt shows every booked field whole, or nothing is asked.
      if (!promptFits(calendarEventKind.render(input, { timezone: ctx.owner.timezone, now: ctx.now }))) throw new ToolError(CALENDAR_TOOL_TEXT.tooLong);
      const joint = (await d.approvals.pendingJointEvents(ctx.agent.id)).find((e) => e.start < end && e.end > start);
      if (joint) throw new ToolError(CALENDAR_TOOL_TEXT.jointPending(joint.ref, joint.answered));
      await d.approvals.request(ctx.agent.id, { kind: 'calendar_event', payload: input, idempotencyKey: ctx.callKey });
      // I19: the prompt is held and goes out right after the reply (the last word of the turn).
      const paused = (await d.repos.agents.get(ctx.agent.id))?.paused === true;
      return paused ? CALENDAR_TOOL_TEXT.paused : CALENDAR_TOOL_TEXT.requested;
    },
  };

  return [getSchedule, findFreeTime, requestEvent];
}
