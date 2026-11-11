export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
}

export interface NewCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
}

export interface CalendarProvider {
  freeBusy(ownerId: string, from: Date, to: Date): Promise<BusyInterval[]>;
  listEvents(ownerId: string, from: Date, to: Date): Promise<CalendarEvent[]>;
  createEvent(ownerId: string, ev: NewCalendarEvent, idempotencyKey: string): Promise<{ eventId: string }>;
  /** Compensation only, CalendarWriter only. */
  deleteEvent(ownerId: string, eventId: string): Promise<void>;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: Date;
}

export interface EmailFull extends EmailSummary {
  bodyText: string;
}

export interface NewDraft {
  to: string[];
  subject: string;
  body: string;
  replyToMessageId?: string;
}

export interface GmailProvider {
  search(ownerId: string, query: string, max: number): Promise<EmailSummary[]>;
  getMessage(ownerId: string, id: string): Promise<EmailFull>;
  createDraft(ownerId: string, draft: NewDraft): Promise<{ draftId: string }>;
  // No send. Ever. (I8)
}
