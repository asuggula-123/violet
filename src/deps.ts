import pino, { type Logger } from 'pino';
import { SystemClock } from './clock.js';
import type { AppDeps } from './app.js';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { FakeCalendar, FakeGmail } from './google/fake.js';
import { ScriptedLlm } from './llm/scripted.js';
import { FakeTransport } from './transport/fake.js';
import type { Transport } from './transport/types.js';

export function createLogger(config: Config): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: { paths: ['*.token', '*.apiKey', '*.authorization', 'req.headers.authorization'], remove: true },
  });
}

function createTransport(config: Config): Transport {
  if (config.TRANSPORT === 'fake') return new FakeTransport();
  throw new Error('TRANSPORT=telegram requires the Telegram transport (milestone 6), which is not installed in this build');
}

/**
 * Production wiring of providers. Until the Anthropic client (M2) and the Google
 * providers (M3) exist, the in-memory doubles stand in; M1 never calls them.
 */
export function createDeps(config: Config, db: Db): AppDeps {
  return {
    db,
    clock: new SystemClock(),
    transport: createTransport(config),
    llm: new ScriptedLlm(),
    calendar: new FakeCalendar(),
    gmail: new FakeGmail(),
    config,
    log: createLogger(config),
  };
}
