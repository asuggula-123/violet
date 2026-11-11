import type { App } from '../../app.js';
import { ALLOWED_UPDATES } from './api.js';
import { createTelegramPoller, type PollerOptions } from './poller.js';
import { webhookPath } from './routes.js';
import { TelegramTransport } from './transport.js';

/** Webhook mode: points every bot at /webhooks/telegram/<bot id> with the secret token. */
export async function registerWebhooks(app: App, transport: TelegramTransport): Promise<void> {
  const { PUBLIC_BASE_URL: base, TELEGRAM_WEBHOOK_SECRET: secret } = app.deps.config;
  if (!base || !secret) {
    app.deps.log.warn('telegram: PUBLIC_BASE_URL unset, webhooks not registered');
    return;
  }
  for (const botId of transport.botIds()) {
    try {
      await transport.api(botId)!.setWebhook({
        url: `${base.replace(/\/+$/, '')}${webhookPath(botId)}`,
        secret_token: secret,
        allowed_updates: ALLOWED_UPDATES,
      });
      app.deps.log.info({ botId }, 'telegram webhook registered');
    } catch (err) {
      // Not fatal: a webhook set by an earlier boot keeps working.
      app.deps.log.error({ botId, err: err instanceof Error ? err.message : String(err) }, 'telegram setWebhook failed');
    }
  }
}

/**
 * Boot hook for main.ts: registers webhooks or starts the poller, per TELEGRAM_MODE.
 * Returns the matching stop function (a no-op for other transports).
 */
export async function startTelegram(app: App, pollerOptions?: PollerOptions): Promise<() => Promise<void>> {
  const transport = app.deps.transport;
  if (!(transport instanceof TelegramTransport)) return async () => undefined;
  if (app.deps.config.TELEGRAM_MODE === 'webhook') {
    await registerWebhooks(app, transport);
    return async () => undefined;
  }
  const poller = createTelegramPoller(app, transport, pollerOptions);
  poller.start();
  return () => poller.stop();
}
