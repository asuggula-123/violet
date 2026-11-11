import type { Capability } from './errors.js';

const AUTH = 'https://www.googleapis.com/auth/';

/** Requested at consent unless GOOGLE_SCOPES overrides them. */
export const DEFAULT_SCOPES: readonly string[] = [
  `${AUTH}calendar.freebusy`,
  `${AUTH}calendar.events.owned`,
  `${AUTH}gmail.readonly`,
  `${AUTH}gmail.drafts.create`,
];

export function parseScopes(raw: string | undefined): string[] {
  const list = (raw ?? '').split(/\s+/).filter((s) => s !== '');
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_SCOPES];
}

/** Any one of these granted scopes gives the capability. */
const GRANTS: Record<Capability, readonly string[]> = {
  calendarFreeBusy: ['calendar', 'calendar.readonly', 'calendar.freebusy', 'calendar.events.freebusy'].map((s) => AUTH + s),
  calendarRead: ['calendar', 'calendar.readonly', 'calendar.events', 'calendar.events.readonly', 'calendar.events.owned', 'calendar.events.owned.readonly'].map(
    (s) => AUTH + s,
  ),
  calendarWrite: ['calendar', 'calendar.events', 'calendar.events.owned'].map((s) => AUTH + s),
  gmailRead: [`${AUTH}gmail.readonly`, `${AUTH}gmail.modify`, 'https://mail.google.com/'],
  gmailDraft: [`${AUTH}gmail.drafts.create`, `${AUTH}gmail.compose`, `${AUTH}gmail.modify`, 'https://mail.google.com/'],
};

export type Capabilities = Record<Capability, boolean>;

/** Derived from what Google actually granted, not from what was asked for. */
export function capabilitiesOf(granted: readonly string[]): Capabilities {
  const has = (c: Capability) => GRANTS[c].some((s) => granted.includes(s));
  return {
    calendarFreeBusy: has('calendarFreeBusy'),
    calendarRead: has('calendarRead'),
    calendarWrite: has('calendarWrite'),
    gmailRead: has('gmailRead'),
    gmailDraft: has('gmailDraft'),
  };
}
