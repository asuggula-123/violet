import type { Logger } from 'pino';
import type { AppDeps, Module } from '../app.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { createActionLog } from '../core/actionLog.js';
import type { FlagService } from '../core/flags.js';
import type { Queryable } from '../db/db.js';
import { GoogleApi } from './api.js';
import { GoogleCalendar } from './calendar.js';
import { parseEncKey } from './crypto.js';
import { GoogleGmail } from './gmail.js';
import { GoogleHttp, type FetchFn } from './http.js';
import { GoogleOAuth } from './oauth.js';
import { parseScopes } from './scopes.js';
import { TokenStore } from './tokens.js';
import type { CalendarProvider } from './types.js';

export interface GoogleServices {
  http: GoogleHttp;
  tokens: TokenStore;
  oauth: GoogleOAuth;
  calendar: GoogleCalendar;
  gmail: GoogleGmail;
  /** Gives the token store the app's FlagService (revocation flags). */
  bindFlags(flags: FlagService): void;
}

/** Real Google providers are used only when all four settings are present. */
export function googleConfigured(config: Config): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI && config.TOKEN_ENC_KEY);
}

export interface CreateGoogleDeps {
  config: Config;
  db: Queryable;
  clock: Clock;
  log: Logger;
  fetch?: FetchFn;
}

const registry = new WeakMap<CalendarProvider, GoogleServices>();

export function createGoogle(d: CreateGoogleDeps): GoogleServices {
  const { config, db, clock, log } = d;
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    throw new Error('Google needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI');
  }
  const key = parseEncKey(config.TOKEN_ENC_KEY);
  const actionLog = createActionLog(db, clock);
  const agentOf = async (ownerId: string) =>
    (await db.query<{ id: string }>('SELECT id FROM agents WHERE owner_id = $1', [ownerId])).rows[0]?.id ?? null;
  const fetchFn: FetchFn = d.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let flags: FlagService | null = null;

  const http = new GoogleHttp({ fetch: fetchFn, actionLog, log, agentOf });
  const tokens = new TokenStore({
    db,
    clock,
    http,
    actionLog,
    log,
    key,
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    agentOf,
    flags: () => flags,
  });
  const oauth = new GoogleOAuth({
    db,
    clock,
    http,
    tokens,
    actionLog,
    log,
    agentOf,
    config: {
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      redirectUri: config.GOOGLE_REDIRECT_URI,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      scopes: parseScopes(config.GOOGLE_SCOPES),
    },
  });
  const api = new GoogleApi(http, tokens);
  const services: GoogleServices = {
    http,
    tokens,
    oauth,
    calendar: new GoogleCalendar(api),
    gmail: new GoogleGmail(api),
    bindFlags(f) {
      flags = f;
    },
  };
  registry.set(services.calendar, services);
  return services;
}

/** The Google services behind an app's providers, or null when the fakes are in use. */
export function googleOf(deps: Pick<AppDeps, 'calendar'>): GoogleServices | null {
  return registry.get(deps.calendar) ?? null;
}

/**
 * Binds the app's FlagService so a revoked grant reaches the owner. Delegates on each
 * call, so a FlagService a later module installs on the app is the one used.
 */
export const googleModule: Module = {
  name: 'google',
  install(app) {
    googleOf(app.deps)?.bindFlags({ raise: (agentId, f) => app.flags.raise(agentId, f) });
  },
};
