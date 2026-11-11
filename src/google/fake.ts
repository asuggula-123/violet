import type {
  BusyInterval,
  CalendarEvent,
  CalendarProvider,
  EmailFull,
  EmailSummary,
  GmailProvider,
  NewCalendarEvent,
  NewDraft,
} from './types.js';

export type CalendarWrite =
  | { op: 'create'; ownerId: string; eventId: string; event: NewCalendarEvent; idempotencyKey: string }
  | { op: 'delete'; ownerId: string; eventId: string };

/** In-memory calendar per owner. Records every write. */
export class FakeCalendar implements CalendarProvider {
  readonly writes: CalendarWrite[] = [];
  private readonly events = new Map<string, CalendarEvent[]>();
  private readonly byKey = new Map<string, string>();
  private counter = 0;

  /** Seeds an event directly (not recorded as a write). */
  seed(ownerId: string, ev: Omit<CalendarEvent, 'id'> & { id?: string }): CalendarEvent {
    const event: CalendarEvent = { ...ev, id: ev.id ?? this.nextId() };
    this.list(ownerId).push(event);
    return event;
  }

  eventsOf(ownerId: string): CalendarEvent[] {
    return [...this.list(ownerId)];
  }

  async freeBusy(ownerId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const spans = this.overlapping(ownerId, from, to)
      .map((e) => ({ start: maxDate(e.start, from), end: minDate(e.end, to) }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const merged: BusyInterval[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start.getTime() <= last.end.getTime()) last.end = maxDate(last.end, s.end);
      else merged.push({ start: s.start, end: s.end });
    }
    return merged;
  }

  async listEvents(ownerId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    return this.overlapping(ownerId, from, to)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((e) => ({ ...e }));
  }

  async createEvent(ownerId: string, ev: NewCalendarEvent, idempotencyKey: string): Promise<{ eventId: string }> {
    const scoped = `${ownerId}:${idempotencyKey}`;
    const existing = this.byKey.get(scoped);
    if (existing) return { eventId: existing };
    const event = this.seed(ownerId, { ...ev });
    this.byKey.set(scoped, event.id);
    this.writes.push({ op: 'create', ownerId, eventId: event.id, event: { ...ev }, idempotencyKey });
    return { eventId: event.id };
  }

  async deleteEvent(ownerId: string, eventId: string): Promise<void> {
    const list = this.list(ownerId);
    const i = list.findIndex((e) => e.id === eventId);
    if (i >= 0) list.splice(i, 1);
    this.writes.push({ op: 'delete', ownerId, eventId });
  }

  private overlapping(ownerId: string, from: Date, to: Date): CalendarEvent[] {
    return this.list(ownerId).filter((e) => e.start.getTime() < to.getTime() && e.end.getTime() > from.getTime());
  }

  private list(ownerId: string): CalendarEvent[] {
    let list = this.events.get(ownerId);
    if (!list) {
      list = [];
      this.events.set(ownerId, list);
    }
    return list;
  }

  private nextId(): string {
    this.counter += 1;
    return `fake-event-${this.counter}`;
  }
}

export interface DraftWrite {
  ownerId: string;
  draftId: string;
  draft: NewDraft;
}

/** In-memory mailbox per owner. Has no send method (I8). Records every write. */
export class FakeGmail implements GmailProvider {
  readonly writes: DraftWrite[] = [];
  private readonly mail = new Map<string, EmailFull[]>();
  private counter = 0;

  seed(ownerId: string, email: EmailFull): void {
    const list = this.mail.get(ownerId) ?? [];
    list.push({ ...email });
    this.mail.set(ownerId, list);
  }

  async search(ownerId: string, query: string, max: number): Promise<EmailSummary[]> {
    const q = query.trim().toLowerCase();
    return (this.mail.get(ownerId) ?? [])
      .filter((m) => q === '' || [m.from, m.to, m.subject, m.bodyText].some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, max)
      .map(({ bodyText: _body, ...summary }) => summary);
  }

  async getMessage(ownerId: string, id: string): Promise<EmailFull> {
    const found = (this.mail.get(ownerId) ?? []).find((m) => m.id === id);
    if (!found) throw new Error(`fake gmail: no message ${id}`);
    return { ...found };
  }

  async createDraft(ownerId: string, draft: NewDraft): Promise<{ draftId: string }> {
    this.counter += 1;
    const draftId = `fake-draft-${this.counter}`;
    this.writes.push({ ownerId, draftId, draft: { ...draft, to: [...draft.to] } });
    return { draftId };
  }
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
