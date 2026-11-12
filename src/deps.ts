import pino, { type Logger } from 'pino';
import { SystemClock, type Clock } from './clock.js';
import type { AppDeps } from './app.js';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { createGoogleProviders } from './google/providers.js';
import { AnthropicLlm } from './llm/anthropic.js';
import { UnconfiguredLlm } from './llm/errors.js';
import type { LlmClient } from './llm/types.js';
import { FakeTransport } from './transport/fake.js';
import { telegramTransportFromConfig } from './transport/telegram/transport.js';
import type { Transport } from './transport/types.js';

export function createLogger(config: Config): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: { paths: ['*.token', '*.apiKey', '*.authorization', 'req.headers.authorization'], remove: true },
  });
}

/** M2: the Claude API when ANTHROPIC_API_KEY is set; otherwise every model call fails with a typed error. */
function createLlm(config: Config): LlmClient {
  if (!config.ANTHROPIC_API_KEY) return new UnconfiguredLlm();
  return new AnthropicLlm({
    apiKey: config.ANTHROPIC_API_KEY,
    models: { brain: config.VIOLET_MODEL, envoy: config.VIOLET_ENVOY_MODEL },
    fallback: config.VIOLET_MODEL_FALLBACK === 'on',
  });
}

function createTransport(config: Config, clock: Clock): Transport {
  if (config.TRANSPORT === 'fake') return new FakeTransport();
  return telegramTransportFromConfig(config, clock);
}

/**
 * Production wiring of providers: the Claude API when ANTHROPIC_API_KEY is set, the real
 * Google providers once Google is configured (else providers that fail every call, except
 * in-memory doubles with the fake transport outside production), and the transport chosen by TRANSPORT.
 */
export function createDeps(config: Config, db: Db): AppDeps {
  const clock = new SystemClock();
  const log = createLogger(config);
  return {
    db,
    clock,
    transport: createTransport(config, clock),
    llm: createLlm(config),
    ...createGoogleProviders({ config, db, clock, log }),
    config,
    log,
  };
}
