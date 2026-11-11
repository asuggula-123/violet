import type { AppDeps } from '../app.js';
import { FakeCalendar, FakeGmail } from './fake.js';
import { createGoogle, googleConfigured, type CreateGoogleDeps } from './services.js';
import { UnconfiguredCalendar, UnconfiguredGmail } from './unconfigured.js';

/**
 * The calendar and mailbox the app uses: the real Google providers when Google is
 * configured; else, in production, providers that fail every call (never a stand-in an
 * owner could mistake for their calendar); else (development, test) in-memory fakes.
 */
export function createGoogleProviders(d: CreateGoogleDeps): Pick<AppDeps, 'calendar' | 'gmail'> {
  if (googleConfigured(d.config)) {
    const google = createGoogle(d);
    return { calendar: google.calendar, gmail: google.gmail };
  }
  if (d.config.NODE_ENV === 'production') {
    d.log.warn('Google is not configured: calendar and Gmail requests fail with "Google isn\'t connected on this server"');
    return { calendar: new UnconfiguredCalendar(), gmail: new UnconfiguredGmail() };
  }
  d.log.info('Google is not configured: the calendar and mailbox are in-memory stand-ins (lost on restart, never a real calendar)');
  return { calendar: new FakeCalendar(), gmail: new FakeGmail() };
}
