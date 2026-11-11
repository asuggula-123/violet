import type { FakeCalendar, FakeGmail } from '../google/fake.js';

/** The demo week, in America/New_York (UTC-5 in November). Story time starts Wed Nov 11, 9:00 AM. */
export const ZONE = 'America/New_York';
export const START = '2026-11-11T09:00:00-05:00';

interface SeedEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
}

interface SeedMail {
  from: string;
  subject: string;
  body: string;
  date: string;
}

/** No two events of one owner overlap, so the hourly conflict check stays quiet. */
const WEEK: Record<'alex' | 'sam', { events: SeedEvent[]; mail: SeedMail[] }> = {
  alex: {
    events: [
      { title: 'Team stand-up', start: '2026-11-09T09:30', end: '2026-11-09T10:00' },
      { title: 'Lunch with the design team', start: '2026-11-11T12:30', end: '2026-11-11T13:30', location: 'Corner Cafe' },
      { title: 'Dentist', start: '2026-11-12T08:00', end: '2026-11-12T09:00', location: 'Elm Street Dental' },
      { title: 'Parent-teacher meeting', start: '2026-11-12T18:00', end: '2026-11-12T19:00', location: 'Room 12' },
      { title: "Pick up Sam's birthday present", start: '2026-11-13T12:00', end: '2026-11-13T13:00', location: 'Main Street Books' },
      { title: 'Gym', start: '2026-11-13T17:30', end: '2026-11-13T18:30' },
      { title: 'Swim lessons for the kids', start: '2026-11-14T10:00', end: '2026-11-14T11:00', location: 'Community pool' },
    ],
    mail: [
      { from: 'books@example.com', subject: 'Your order is ready for pickup', body: 'The book you ordered is ready at the front desk.', date: '2026-11-10T16:00' },
      { from: 'school@example.com', subject: 'Parent-teacher meeting on Thursday', body: 'See you in room 12 at 6 PM.', date: '2026-11-09T11:00' },
    ],
  },
  sam: {
    events: [
      { title: 'Physio', start: '2026-11-11T10:00', end: '2026-11-11T11:00', location: 'Riverside Clinic' },
      { title: 'Budget review', start: '2026-11-12T14:00', end: '2026-11-12T15:30' },
      { title: 'School pickup and soccer practice', start: '2026-11-13T17:00', end: '2026-11-13T18:45', location: 'North Field' },
      { title: 'Farmers market', start: '2026-11-14T09:00', end: '2026-11-14T10:00' },
    ],
    mail: [{ from: 'clinic@example.com', subject: 'Physio appointment reminder', body: 'Wednesday at 10 AM.', date: '2026-11-10T09:00' }],
  },
};

const at = (local: string) => new Date(`${local}:00-05:00`);

export function seedWeek(calendar: FakeCalendar, gmail: FakeGmail, owners: { alex: string; sam: string }): void {
  for (const who of ['alex', 'sam'] as const) {
    for (const e of WEEK[who].events) {
      calendar.seed(owners[who], { title: e.title, start: at(e.start), end: at(e.end), ...(e.location ? { location: e.location } : {}) });
    }
    WEEK[who].mail.forEach((m, i) => {
      gmail.seed(owners[who], { id: `${who}-mail-${i + 1}`, threadId: `${who}-thread-${i + 1}`, from: m.from, to: `${who}@example.com`, subject: m.subject, snippet: m.body, bodyText: m.body, date: at(m.date) });
    });
  }
}

/** Every private detail of both owners: none of these may reach an Envoy or the agents' channel. */
export function privateDetails(): string[] {
  return (['alex', 'sam'] as const).flatMap((who) => [
    ...WEEK[who].events.flatMap((e) => [e.title, ...(e.location ? [e.location] : [])]),
    ...WEEK[who].mail.flatMap((m) => [m.subject, m.body]),
  ]);
}
