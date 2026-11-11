import { PermanentTransportError, RetryableTransportError, TransportError } from '../types.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgSentMessage {
  message_id: number;
  chat: TgChat;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendMessageParams {
  chat_id: string | number;
  text: string;
  link_preview_options?: { is_disabled: boolean };
  reply_markup?: { inline_keyboard: InlineButton[][] };
}

export interface GetUpdatesParams {
  offset?: number;
  timeout: number;
  allowed_updates: string[];
}

export interface SetWebhookParams {
  url: string;
  secret_token: string;
  allowed_updates: string[];
}

/** The updates the transport handles; everything else is not requested (webhook and polling). */
export const ALLOWED_UPDATES = ['message', 'callback_query'];

interface TgResponse {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/**
 * Tiny Bot API client. The token is part of every request URL, so neither the URL nor
 * anything derived from it (the fetch error, its cause) ever reaches an error, a log
 * line or the action log: errors are built from the method name and Telegram's
 * error_code/description only (I16).
 */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn,
  ) {}

  getMe(): Promise<TgUser> {
    return this.call('getMe', {});
  }

  sendMessage(params: SendMessageParams): Promise<TgSentMessage> {
    return this.call('sendMessage', params);
  }

  answerCallbackQuery(callbackQueryId: string): Promise<boolean> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  setWebhook(params: SetWebhookParams): Promise<boolean> {
    return this.call('setWebhook', params);
  }

  deleteWebhook(): Promise<boolean> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  /** Long poll; `signal` aborts it on shutdown. */
  getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<unknown[]> {
    return this.call('getUpdates', params, { signal, timeoutMs: (params.timeout + 10) * 1000 });
  }

  leaveChat(chatId: number): Promise<boolean> {
    return this.call('leaveChat', { chat_id: chatId });
  }

  private async call<T>(method: string, params: object, o: { signal?: AbortSignal | undefined; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    let body: TgResponse | null;
    try {
      res = await this.fetchFn(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
      body = (await res.json().catch(() => null)) as TgResponse | null;
    } catch {
      // The fetch error may quote the URL, so it is dropped, not wrapped.
      throw new RetryableTransportError(`telegram ${method}: network error`, 'network');
    }
    if (res.ok && body?.ok === true) return body.result as T;
    throw apiError(method, res.status, body);
  }
}

function apiError(method: string, status: number, body: TgResponse | null): TransportError {
  const code = typeof body?.error_code === 'number' ? body.error_code : status;
  const description = typeof body?.description === 'string' ? body.description.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) : '';
  const message = `telegram ${method} failed: ${code}${description ? ` ${description}` : ''}`;
  if (code === 429) {
    const after = body?.parameters?.retry_after;
    return new RetryableTransportError(message, 'rate_limited', typeof after === 'number' && after >= 0 ? after * 1000 : undefined);
  }
  if (code >= 500 || code < 400) return new RetryableTransportError(message, 'server_error');
  if (code === 403) return new PermanentTransportError(message, 'forbidden');
  if (code === 401 || code === 404) return new PermanentTransportError(message, 'unauthorized');
  return new PermanentTransportError(message, 'bad_request');
}
