import type { Logger } from 'pino';
import type { ActionLog } from '../core/actionLog.js';
import { checkAllowed, describe } from './allowlist.js';
import {
  GoogleAuthError,
  GoogleConflictError,
  GoogleDeniedError,
  GoogleNotFoundError,
  GoogleRateLimitedError,
  GoogleRequestError,
  GoogleScopeMissingError,
  GoogleTransientError,
} from './errors.js';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface GoogleRequest {
  method: string;
  url: string;
  /** Owner on whose behalf the call is made (logged with a denied call). */
  ownerId?: string;
  accessToken?: string;
  json?: unknown;
  form?: Record<string, string>;
}

export interface GoogleHttpDeps {
  fetch: FetchFn;
  actionLog: ActionLog;
  log: Logger;
  /** Owner → agent, so a denied call is logged against the agent. */
  agentOf(ownerId: string): Promise<string | null>;
  timeoutMs?: number;
}

/**
 * The only code that talks to Google. Every call is checked against the allow-list
 * (I8) before fetch is touched; errors map to typed GoogleErrors; nothing is retried
 * here (the job queue owns retries). Tokens and bodies are never logged.
 */
export class GoogleHttp {
  constructor(private readonly deps: GoogleHttpDeps) {}

  async request<T>(req: GoogleRequest): Promise<T> {
    try {
      checkAllowed(req.method, req.url);
    } catch (err) {
      // Best effort: an audit-log failure must never mask the denial itself.
      if (err instanceof GoogleDeniedError) await this.logDenied(req).catch(() => this.deps.log.error('google denied call could not be audited'));
      throw err;
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (req.accessToken) headers.authorization = `Bearer ${req.accessToken}`;
    let body: string | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }

    const where = `${req.method} ${describe(req.url)}`;
    let res: Response;
    try {
      res = await this.deps.fetch(req.url, {
        method: req.method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      this.deps.log.warn({ call: where }, 'google call failed (network)');
      throw new GoogleTransientError(`google ${where}: network error`);
    }
    const text = await res.text().catch(() => '');
    if (res.ok) return (text === '' ? {} : parseJson(text, where)) as T;
    const err = mapError(res, safeParse(text), where);
    this.deps.log.warn({ call: where, status: res.status, code: err.code }, 'google call failed');
    throw err;
  }

  private async logDenied(req: GoogleRequest): Promise<void> {
    const agentId = req.ownerId ? await this.deps.agentOf(req.ownerId) : null;
    this.deps.log.warn({ call: `${req.method} ${describe(req.url)}` }, 'google call denied');
    await this.deps.actionLog.write({
      agentId,
      actor: 'system',
      action: 'google.denied',
      detail: { method: describe(req.method.slice(0, 16)), url: describe(req.url), ...(req.ownerId ? { ownerId: req.ownerId } : {}) },
    });
  }
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleRequestError(`google ${where}: malformed response`);
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Only short machine codes from Google's error body are used — never free text. */
function code(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z_]{1,64}$/.test(v) ? v : undefined;
}

interface ApiError {
  status?: unknown;
  errors?: { reason?: unknown }[];
  details?: { reason?: unknown }[];
}

function mapError(res: Response, body: Record<string, unknown>, where: string) {
  const status = res.status;
  // OAuth endpoint: { error: 'invalid_grant', error_description }
  const oauthCode = code(body.error);
  const api = (typeof body.error === 'object' && body.error ? body.error : {}) as ApiError;
  const reasons = [
    code(api.status),
    ...(Array.isArray(api.errors) ? api.errors.map((e) => code(e?.reason)) : []),
    ...(Array.isArray(api.details) ? api.details.map((d) => code(d?.reason)) : []),
  ].filter((r): r is string => r !== undefined);
  const msg = `google ${where}: HTTP ${status}${oauthCode ? ` ${oauthCode}` : ''}${reasons.length ? ` ${reasons.join(',')}` : ''}`;
  const has = (...rs: string[]) => rs.some((r) => reasons.includes(r));

  if (oauthCode === 'invalid_grant') return new GoogleAuthError(msg, oauthCode, status);
  if (status === 401 || oauthCode === 'invalid_client' || oauthCode === 'unauthorized_client') return new GoogleAuthError(msg, oauthCode, status);
  if (status === 429 || has('rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED')) {
    return new GoogleRateLimitedError(msg, status, retryAfter(res));
  }
  if (
    status === 403 &&
    (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient_scope/.test(res.headers.get('www-authenticate') ?? ''))
  ) {
    return new GoogleScopeMissingError(msg, undefined, status);
  }
  if (status === 404 || status === 410) return new GoogleNotFoundError(msg, status);
  if (status === 409) return new GoogleConflictError(msg);
  if (status >= 500) return new GoogleTransientError(msg, status);
  return new GoogleRequestError(msg, status);
}

function retryAfter(res: Response): number | undefined {
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
