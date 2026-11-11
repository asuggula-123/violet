import pino, { type Logger } from 'pino';
import { SystemClock, type Clock } from './clock.js';
import type { AppDeps } from './app.js';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { FakeCalendar, FakeGmail } from './google/fake.js';
import { createGoogle, googleConfigured } from './google/services.js';
import { ScriptedLlm } from './llm/scripted.js';
import { FakeTransport } from './transport/fake.js';
import { telegramTransportFromConfig } from './transport/telegram/transport.js';
import type { Transport } from './transport/types.js';

export function createLogger(config: Config): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: { paths: ['*.token', '*.apiKey', '*.authorization', 'req.headers.authorization'], remove: true },
  });
}

function createTransport(config: Config, clock: Clock): Transport {
  if (config.TRANSPORT === 'fake') return new FakeTransport();
  return telegramTransportFromConfig(config, clock);
}

/**
 * Production wiring of providers. Until the Anthropic client (M2) exists, the
 * in-memory double stands in. Google is real once configured (M3), else fakes.
 */
export function createDeps(config: Config, db: Db): AppDeps {
  const clock = new SystemClock();
  const log = createLogger(config);
  const google = googleConfigured(config) ? createGoogle({ config, db, clock, log }) : null;
  return {
    db,
    clock,
    transport: createTransport(config, clock),
    llm: new ScriptedLlm(),
    calendar: google?.calendar ?? new FakeCalendar(),
    gmail: google?.gmail ?? new FakeGmail(),
    config,
    log,
  };
}
