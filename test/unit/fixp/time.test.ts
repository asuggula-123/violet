/**
 * P3/P3b: one code formatter (exactRange) for the time text of every approval prompt and
 * Booked / failure line. Its text determines the (start, end) pair: the year whenever the start
 * or end is not in the owner's current local year, the UTC offset in a repeated hour. Starts are
 * limited to 366 days ahead and to whole minutes, for the Brain's calendar tool and the Envoy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { calendarEventKind } from '../../../src/approvals/calendarEvent.js';
import { checkEvents } from '../../../src/a2a/envoyTools.js';
import { bookedLine, outcomePrompt, releaseWindowText } from '../../../src/a2a/render.js';
import type { ConversationRow } from '../../../src/a2a/types.js';
import { CALENDAR_TOOL_TEXT } from '../../../src/brain/tools/calendar.js';
import { exactRange, MAX_DAYS_AHEAD } from '../../../src/brain/time.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { lastResults, respond, stepOf, toolUse } from '../brain/script.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const MIN = 60_000;
const DAY = 86_400_000;

describe('P3 exactRange is injective inside the horizon', () => {
  it('no two different (start, end) minute pairs render the same text: DST both ways, the year boundary, 30/45-minute zones', () => {
    const zones = ['America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Asia/Kolkata', 'Pacific/Chatham', 'Australia/Adelaide', 'Europe/London'];
    const now = new Date('2026-11-12T12:00:00Z');
    // Windows around every interesting instant inside the 366-day horizon.
    const bases = ['2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z', '2027-03-14T00:00:00Z', '2027-03-27T12:00:00Z', '2027-04-03T12:00:00Z', '2027-04-04T12:00:00Z', '2027-09-25T12:00:00Z', '2027-10-30T12:00:00Z', '2027-11-07T00:00:00Z'].map(Date.parse);
    const collisions: string[] = [];
    for (const tz of zones) {
      const seen = new Map<string, string>();
      for (const b of bases) {
        for (let m = 0; m < 30 * 60; m += 1) {
          const s = new Date(b + m * MIN);
          for (const len of [1, 30, 61, 24 * 60, 6 * 24 * 60]) {
            const e = new Date(s.getTime() + len * MIN);
            const text = exactRange(s, e, tz, now);
            const key = `${s.toISOString()}/${e.toISOString()}`;
            const before = seen.get(text);
            if (before !== undefined && before !== key) collisions.push(`${tz}: “${text}” is both ${before} and ${key}`);
            seen.set(text, key);
          }
        }
      }
    }
    expect(collisions.slice(0, 5)).toEqual([]);
  }, 600_000);

  it('the same day a year later shows its year; this year keeps the plain text', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const tz = 'America/New_York';
    expect(exactRange(new Date('2026-11-14T00:00:00Z'), new Date('2026-11-14T01:30:00Z'), tz, now)).toBe('Fri Nov 13, 7:00–8:30 PM');
    expect(exactRange(new Date('2027-11-13T00:00:00Z'), new Date('2027-11-13T01:30:00Z'), tz, now)).toBe('Fri Nov 12 2027, 7:00 PM – Fri Nov 12 2027, 8:30 PM');
    // Across New Year: the end is in another year, so both show it.
    expect(exactRange(new Date('2027-01-01T04:00:00Z'), new Date('2027-01-01T06:00:00Z'), tz, new Date('2026-12-31T12:00:00Z'))).toBe('Thu Dec 31 2026, 11:00 PM – Fri Jan 1 2027, 1:00 AM');
    // releaseWindowText is the same formatter (I20 keeps its behaviour).
    const s = new Date('2027-11-13T00:00:00Z');
    const e = new Date('2027-11-13T05:00:00Z');
    expect(releaseWindowText(s, e, tz, now)).toBe(exactRange(s, e, tz, now));
  });

  it('every prompt and line uses it: calendar_event, a2a_outcome prompt and Booked line, in the repeated hour', () => {
    const tz = 'America/New_York';
    const now = new Date('2026-10-30T12:00:00Z');
    const edt = { title: 'Call', start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T01:50:00-04:00' };
    const est = { title: 'Call', start: '2026-11-01T01:30:00-05:00', end: '2026-11-01T01:50:00-05:00' };
    expect(calendarEventKind.render(edt, { timezone: tz, now })).not.toBe(calendarEventKind.render(est, { timezone: tz, now }));
    expect(calendarEventKind.render(edt, { timezone: tz, now })).toContain('(UTC-04:00)');
    expect(outcomePrompt({ peer: 'Sam', summary: 's', events: [est] }, tz, now)).toContain('(UTC-05:00)');
    expect(bookedLine({ summary: 's', events: [edt] }, tz, now)).not.toBe(bookedLine({ summary: 's', events: [est] }, tz, now));
  });
});

describe('P3 horizon and whole minutes', () => {
  const conv = { window_start: null, window_end: null } as unknown as ConversationRow;
  const now = new Date('2026-11-12T12:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('the Envoy: a start more than 366 days ahead, or with seconds, is refused', () => {
    const ok = now.getTime() + MAX_DAYS_AHEAD * DAY - 60 * MIN;
    expect(() => checkEvents([{ start: iso(ok), end: iso(ok + 30 * MIN) }], conv, now)).not.toThrow();
    const far = now.getTime() + MAX_DAYS_AHEAD * DAY + MIN;
    expect(() => checkEvents([{ start: iso(far), end: iso(far + 30 * MIN) }], conv, now)).toThrow(/at most 366 days/);
    const odd = now.getTime() + DAY + 1000;
    expect(() => checkEvents([{ start: iso(odd), end: iso(odd + 30 * MIN) }], conv, now)).toThrow(/whole minutes/);
  });

  it('request_calendar_event (hostile model): 2037 is refused with the fixed text, seconds are refused, nothing is asked', async () => {
    w = await createTestWorld();
    const world = w;
    const results: string[] = [];
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
      const step = stepOf(req);
      if (step > 0) results.push(...lastResults(req).map((r) => r.content));
      if (step === 0) return respond([toolUse('a', 'request_calendar_event', { title: 'Dinner', start: '2037-11-13T19:00:00-05:00', end: '2037-11-13T20:30:00-05:00' })]);
      if (step === 1) return respond([toolUse('b', 'request_calendar_event', { title: 'Dinner', start: '2026-11-13T19:00:30-05:00', end: '2026-11-13T20:30:00-05:00' })]);
      return respond([{ type: 'text', text: 'Booked both!' }]);
    });
    await world.ownerSays(world.alex, 'book dinners');
    expect(results[0]).toBe(CALENDAR_TOOL_TEXT.tooFar);
    expect(results[1]).toMatch(/whole minutes/);
    expect(await world.app.approvals!.listPending(world.alex.agent.id)).toEqual([]);
  });
});
