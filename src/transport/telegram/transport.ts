import { createHash } from 'node:crypto';
import type { Clock } from '../../clock.js';
import type { Config } from '../../config.js';
import { currentJobId } from '../../core/jobContext.js';
import { TransportError, PermanentTransportError, type OutboundMessage, type Transport } from '../types.js';
import { TelegramApi, type FetchFn, type SendMessageParams } from './api.js';
import { splitText } from './chunk.js';

/** "<bot id>:<secret>". The bot id is the agent's address. */
const TOKEN_FORMAT = /^(\d{1,20}):[A-Za-z0-9_-]{30,}$/;
const SECRET_FORMAT = /^[A-Za-z0-9_-]{16,256}$/;
/** Telegram's limit for callback_data. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** Parses TELEGRAM_BOT_TOKENS into bot id → token. Errors never quote a token. */
export function parseBotTokens(raw: string): Map<string, string> {
  const bots = new Map<string, string>();
  const entries = raw.split(',').map((t) => t.trim());
  entries.forEach((token, i) => {
    const botId = TOKEN_FORMAT.exec(token)?.[1];
    if (!botId) throw new Error(`TELEGRAM_BOT_TOKENS: entry ${i + 1} is not a bot token ("<bot id>:<secret>")`);
    if (bots.has(botId)) throw new Error(`TELEGRAM_BOT_TOKENS: bot ${botId} is listed twice`);
    bots.set(botId, token);
  });
  return bots;
}

/** How long a partly sent multi-chunk message is remembered for its retry. */
export const PARTIAL_SEND_TTL_MS = 6 * 3_600_000;

interface PartialSend {
  sent: number;
  at: number;
}

/** One bot per agent: `agentAddress` is the bot id, `toAddress` the owner's Telegram user id. */
export class TelegramTransport implements Transport {
  readonly name = 'telegram' as const;
  private readonly apis = new Map<string, TelegramApi>();
  /**
   * Multi-chunk sends that failed retryably after some chunks went out, by (job id,
   * message hash). Only a retry of the same job resumes; a new request always gets the
   * whole message, even with the same text.
   */
  private readonly partial = new Map<string, PartialSend>();

  constructor(
    tokens: Map<string, string>,
    fetchFn: FetchFn,
    private readonly clock: Clock,
  ) {
    for (const [botId, token] of tokens) this.apis.set(botId, new TelegramApi(token, fetchFn));
  }

  botIds(): string[] {
    return [...this.apis.keys()];
  }

  /** The API client for a bot, or undefined if this process has no token for it. */
  api(botId: string): TelegramApi | undefined {
    return this.apis.get(botId);
  }

  /**
   * Plain text only (no parse_mode: the text may quote third-party content), no link
   * previews. Long texts go out in several messages; buttons ride on the last one.
   * Returns "<chat id>:<message id>" of the last message.
   */
  async send(msg: OutboundMessage): Promise<{ transportMessageId: string }> {
    const api = this.apis.get(msg.agentAddress);
    if (!api) throw new PermanentTransportError(`telegram: no bot token for bot ${msg.agentAddress}`, 'unknown_bot');
    if (msg.text.trim() === '') throw new PermanentTransportError('telegram: message text is empty', 'bad_request');
    const keyboard = inlineKeyboard(msg.buttons ?? []);
    const chunks = splitText(msg.text);
    // A retry of the same job's send that failed partway resumes after the chunks already
    // delivered (in-process memory: after a restart the whole message goes again). Outside
    // a job there is no retry to resume, so nothing is remembered.
    const jobId = currentJobId();
    const key = chunks.length > 1 && jobId !== undefined ? partialKey(jobId, msg) : null;
    const nowMs = this.clock.now().getTime();
    for (const [k, p] of this.partial) if (nowMs - p.at > PARTIAL_SEND_TTL_MS) this.partial.delete(k);
    const start = key ? (this.partial.get(key)?.sent ?? 0) : 0;
    let last = { chatId: '', messageId: 0 };
    for (let i = start; i < chunks.length; i += 1) {
      const params: SendMessageParams = {
        chat_id: msg.toAddress,
        text: chunks[i]!,
        link_preview_options: { is_disabled: true },
        ...(keyboard && i === chunks.length - 1 ? { reply_markup: keyboard } : {}),
      };
      let sent;
      try {
        sent = await api.sendMessage(params);
      } catch (err) {
        if (key && i > 0 && err instanceof TransportError && !err.permanent) this.partial.set(key, { sent: i, at: this.clock.now().getTime() });
        else if (key) this.partial.delete(key);
        throw err;
      }
      last = { chatId: String(sent.chat.id), messageId: sent.message_id };
    }
    if (key) this.partial.delete(key);
    return { transportMessageId: `${last.chatId}:${last.messageId}` };
  }
}

function partialKey(jobId: string, msg: OutboundMessage): string {
  return createHash('sha256')
    .update(JSON.stringify([jobId, msg.agentAddress, msg.toAddress, msg.purpose, msg.text, msg.buttons ?? []]))
    .digest('hex');
}

function inlineKeyboard(buttons: { id: string; label: string }[]): SendMessageParams['reply_markup'] | undefined {
  if (buttons.length === 0) return undefined;
  for (const b of buttons) {
    if (Buffer.byteLength(b.id, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
      throw new PermanentTransportError(
        `telegram: button id is ${Buffer.byteLength(b.id, 'utf8')} bytes; callback_data allows at most ${CALLBACK_DATA_MAX_BYTES}`,
        'bad_request',
      );
    }
  }
  return { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.id }))] };
}

/** TRANSPORT=telegram wiring, with clear errors for missing or malformed settings. */
export function telegramTransportFromConfig(
  config: Config,
  clock: Clock,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): TelegramTransport {
  if (!config.TELEGRAM_BOT_TOKENS) throw new Error('TRANSPORT=telegram requires TELEGRAM_BOT_TOKENS (comma-separated bot tokens)');
  const secret = config.TELEGRAM_WEBHOOK_SECRET;
  if (config.TELEGRAM_MODE === 'webhook' && !secret) {
    throw new Error('TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_SECRET');
  }
  if (secret && !SECRET_FORMAT.test(secret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ and -');
  }
  return new TelegramTransport(parseBotTokens(config.TELEGRAM_BOT_TOKENS), fetchFn, clock);
}
