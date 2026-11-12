/**
 * Typed Google errors. `message` is for logs (method, path, status — never bodies or
 * tokens). `safeMessage` is short owner-facing text other milestones may show as is;
 * `ownerMessage` (the field the tool loop and CalendarWriter read) is the same text (P6).
 * No text promises what the Brain cannot do: only the operator's `google:link` makes a link.
 */
export type GoogleErrorCode =
  | 'denied'
  | 'not_connected'
  | 'auth'
  | 'scope_missing'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'transient'
  | 'invalid_input'
  | 'request';

export class GoogleError extends Error {
  readonly code: GoogleErrorCode;
  readonly safeMessage: string;
  readonly ownerMessage: string;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: GoogleErrorCode, message: string, safeMessage: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.safeMessage = safeMessage;
    this.ownerMessage = safeMessage;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}

/** I8: the call is not on the allow-list. Thrown before any network call. */
export class GoogleDeniedError extends GoogleError {
  constructor(message: string) {
    super('denied', message, "That Google action isn't allowed.");
  }
}

export class GoogleNotConnectedError extends GoogleError {
  constructor(ownerId: string) {
    super('not_connected', `no Google account for owner ${ownerId}`, "Google isn't connected yet. Ask whoever set up Violet for a connect link.");
  }
}

export class GoogleAuthError extends GoogleError {
  /** OAuth error code from Google, e.g. 'invalid_grant'. */
  readonly reason: string | undefined;
  constructor(message: string, reason?: string, status?: number) {
    super('auth', message, 'Google access expired — reconnect needed.', status === undefined ? {} : { status });
    this.reason = reason;
  }
}

export type Capability = 'calendarFreeBusy' | 'calendarRead' | 'calendarWrite' | 'gmailRead' | 'gmailDraft';

const CAPABILITY_TEXT: Record<Capability, string> = {
  calendarFreeBusy: "see your calendar's free/busy times",
  calendarRead: 'read your calendar',
  calendarWrite: 'add events to your calendar',
  gmailRead: 'read your email',
  gmailDraft: 'create email drafts',
};

export class GoogleScopeMissingError extends GoogleError {
  readonly capability: Capability | undefined;
  constructor(message: string, capability?: Capability, status?: number) {
    const what = capability ? CAPABILITY_TEXT[capability] : 'do that';
    super('scope_missing', message, `Google didn't give me permission to ${what}. Reconnect Google and allow it.`, status === undefined ? {} : { status });
    this.capability = capability;
  }
}

export class GoogleNotFoundError extends GoogleError {
  constructor(message: string, status: number) {
    super('not_found', message, "That wasn't found in Google.", { status });
  }
}

export class GoogleConflictError extends GoogleError {
  constructor(message: string) {
    super('conflict', message, 'That already exists in Google.', { status: 409 });
  }
}

export class GoogleRateLimitedError extends GoogleError {
  /** Seconds, from Retry-After when Google sent one. */
  readonly retryAfterSec: number | undefined;
  constructor(message: string, status: number, retryAfterSec?: number) {
    super('rate_limited', message, 'Google is busy right now. Try again in a few minutes.', { retryable: true, status });
    this.retryAfterSec = retryAfterSec;
  }
}

export class GoogleTransientError extends GoogleError {
  constructor(message: string, status?: number) {
    super('transient', message, "Google didn't respond properly. Try again shortly.", status === undefined ? { retryable: true } : { retryable: true, status });
  }
}

/** Our own validation (e.g. a draft header) refused the input. `safeMessage` says what. */
export class GoogleInvalidInputError extends GoogleError {
  constructor(safeMessage: string) {
    super('invalid_input', `invalid input: ${safeMessage}`, safeMessage);
  }
}

export class GoogleRequestError extends GoogleError {
  constructor(message: string, status?: number) {
    super('request', message, 'Google rejected the request.', status === undefined ? {} : { status });
  }
}
