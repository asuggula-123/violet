import { GoogleError } from './errors.js';
import type { CalendarProvider, GmailProvider } from './types.js';

/** A reason fragment: CalendarWriter shows it as "I couldn't book #n: <reason>." */
export const NOT_CONFIGURED_REASON = "Google isn't connected on this server";

/**
 * The server has no Google OAuth settings, so no owner can connect Google at all.
 * Same code as GoogleNotConnectedError ('not_connected': a missing connection), but its
 * text does not offer a connect link that cannot be made. `ownerMessage` is the field
 * the tool loop and CalendarWriter read for a safe reason (`safeMessage` is not).
 */
export class GoogleNotConfiguredError extends GoogleError {
  readonly ownerMessage = NOT_CONFIGURED_REASON;
  constructor(op: string) {
    super('not_connected', `Google is not configured on this server (${op})`, `${NOT_CONFIGURED_REASON}.`);
  }
}

/** Production without Google settings: every call fails; nothing is stored or pretended. */
export class UnconfiguredCalendar implements CalendarProvider {
  async freeBusy(): Promise<never> {
    throw new GoogleNotConfiguredError('calendar.freeBusy');
  }
  async listEvents(): Promise<never> {
    throw new GoogleNotConfiguredError('calendar.listEvents');
  }
  async createEvent(): Promise<never> {
    throw new GoogleNotConfiguredError('calendar.createEvent');
  }
  async deleteEvent(): Promise<never> {
    throw new GoogleNotConfiguredError('calendar.deleteEvent');
  }
  /** Nothing is ever created here, so no key has an event: CalendarWriter's undo has nothing to delete. */
  async eventIdForKey(): Promise<null> {
    return null;
  }
}

/** See UnconfiguredCalendar. No send method (I8). */
export class UnconfiguredGmail implements GmailProvider {
  async search(): Promise<never> {
    throw new GoogleNotConfiguredError('gmail.search');
  }
  async getMessage(): Promise<never> {
    throw new GoogleNotConfiguredError('gmail.getMessage');
  }
  async createDraft(): Promise<never> {
    throw new GoogleNotConfiguredError('gmail.createDraft');
  }
}
