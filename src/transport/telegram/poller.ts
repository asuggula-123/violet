import type { App } from '../../app.js';
import { ALLOWED_UPDATES } from './api.js';
import { followUp, ingestUpdate } from './inbound.js';
import { telegramUpdate } from './normalize.js';
import { telegramStateRepo } from './state.js';
import type { TelegramTransport } from './transport.js';

export interface PollerOptions {
  /** getUpdates long-poll timeout, seconds. */
  timeoutSec?: number;
  /** Delay after the n-th consecutive failure (1-based). */
  backoffMs?: (failures: number) => number;
  /** Waits `ms`, or less if `signal` aborts first. Tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface TelegramPoller {
  start(): void;
  /** Aborts the long polls and pending back-off waits, then waits for the loops to end. */
  stop(): Promise<void>;
  /** One getUpdates round for one bot; returns how many updates were ingested. */
  pollOnce(botId: string, signal?: AbortSignal): Promise<number>;
}

/**
 * Bot API: "If there are no new updates for at least a week, then identifier of the
 * next update will be chosen randomly instead of sequentially." An offset older than
 * this is not sent, so a lower restarted id is not taken as already confirmed; updates
 * Telegram redelivers because of that are deduplicated by ingest (I18).
 */
export const STALE_OFFSET_MS = 6 * 24 * 3_600_000;

export function defaultPollBackoffMs(failures: number): number {
  return Math.min(1_000 * 2 ** (failures - 1), 60_000);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * TELEGRAM_MODE=polling (local development, no public URL): one long-poll loop per bot.
 * The offset is persisted and advanced only after an update is ingested, so a failed
 * ingest means the update comes again (and ingest dedupes, I18).
 */
export function createTelegramPoller(app: App, transport: TelegramTransport, opts: PollerOptions = {}): TelegramPoller {
  const state = telegramStateRepo(app.deps.db);
  const log = app.deps.log;
  const backoff = opts.backoffMs ?? defaultPollBackoffMs;
  const sleep = opts.sleep ?? abortableSleep;
  let controller: AbortController | null = null;
  let loops: Promise<void>[] = [];

  function apiFor(botId: string) {
    const api = transport.api(botId);
    if (!api) throw new Error(`telegram: no bot token for bot ${botId}`);
    return api;
  }

  async function pollOnce(botId: string, signal?: AbortSignal): Promise<number> {
    const api = apiFor(botId);
    const stored = await state.get(botId);
    const fresh = stored !== null && app.deps.clock.now().getTime() - stored.updatedAt.getTime() < STALE_OFFSET_MS;
    if (stored && !fresh) log.info({ botId }, 'telegram: stored offset is over 6 days old; polling without it');
    const updates = await api.getUpdates(
      { ...(stored && fresh ? { offset: stored.lastUpdateId + 1 } : {}), timeout: opts.timeoutSec ?? 30, allowed_updates: ALLOWED_UPDATES },
      signal,
    );
    let ingested = 0;
    for (const raw of updates) {
      const parsed = telegramUpdate.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { update_id?: unknown } | null)?.update_id;
        if (typeof id !== 'number') throw new Error('telegram getUpdates returned an update without update_id');
        log.warn({ botId, updateId: id }, 'telegram: skipped a malformed update');
        await state.save(botId, id, app.deps.clock.now());
        continue;
      }
      const n = await ingestUpdate(app, botId, parsed.data);
      await state.save(botId, parsed.data.update_id, app.deps.clock.now());
      void followUp(app, api, botId, n);
      ingested += 1;
    }
    return ingested;
  }

  async function loop(botId: string, signal: AbortSignal): Promise<void> {
    let failures = 0;
    let webhookCleared = false;
    while (!signal.aborted) {
      try {
        if (!webhookCleared) {
          // getUpdates is refused while a webhook is set.
          await apiFor(botId).deleteWebhook();
          webhookCleared = true;
        }
        await pollOnce(botId, signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures += 1;
        log.warn({ botId, failures, err: err instanceof Error ? err.message : String(err) }, 'telegram poll failed');
        await sleep(backoff(failures), signal);
      }
    }
  }

  return {
    pollOnce,
    start() {
      if (controller) return;
      controller = new AbortController();
      const signal = controller.signal;
      loops = transport.botIds().map((botId) => loop(botId, signal));
    },
    async stop() {
      controller?.abort();
      controller = null;
      await Promise.all(loops);
      loops = [];
    },
  };
}
