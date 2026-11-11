import type { App } from '../../app.js';
import type { TelegramApi } from './api.js';
import { normalizeUpdate, type Normalized, type TelegramUpdate } from './normalize.js';

async function agentIdFor(app: App, botId: string): Promise<string | null> {
  return (await app.repos.agents.findByAddress('telegram', botId))?.id ?? null;
}

/**
 * Normalizes one update and ingests it. An ignored update is written to action_log as
 * inbound.dropped (I15). Throws if the ingest or that write fails (the update must come again).
 */
export async function ingestUpdate(app: App, botId: string, update: TelegramUpdate): Promise<Normalized> {
  const n = normalizeUpdate(botId, update, app.deps.clock.now());
  if (n.action === 'ingest') {
    await app.ingest(n.msg);
  } else {
    app.deps.log.debug({ botId, updateId: update.update_id, reason: n.reason }, 'telegram update ignored');
    await app.actionLog.write({
      agentId: await agentIdFor(app, botId),
      actor: 'system',
      action: 'inbound.dropped',
      detail: {
        transport: 'telegram',
        botId,
        updateId: update.update_id,
        reason: n.reason,
        ...(n.leaveChatId !== undefined ? { chatId: n.leaveChatId } : {}),
      },
    });
  }
  return n;
}

/**
 * Best-effort calls after an ingest: stop the button's spinner, leave a group the bot
 * was added to (logged as telegram.chat_left). Never rejects; failures are only logged.
 */
export async function followUp(app: App, api: TelegramApi, botId: string, n: Normalized): Promise<void> {
  try {
    if (n.action === 'ingest' && n.callbackQueryId) await api.answerCallbackQuery(n.callbackQueryId);
    if (n.action === 'ignore' && n.leaveChatId !== undefined) {
      await api.leaveChat(n.leaveChatId);
      app.deps.log.info({ botId, chatId: n.leaveChatId }, 'telegram: left a non-private chat');
      await app.actionLog.write({
        agentId: await agentIdFor(app, botId),
        actor: 'system',
        action: 'telegram.chat_left',
        detail: { botId, chatId: n.leaveChatId },
      });
    }
  } catch (err) {
    app.deps.log.warn({ botId, err: err instanceof Error ? err.message : String(err) }, 'telegram follow-up call failed');
  }
}
