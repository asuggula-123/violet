import type { FetchFn } from '../../../src/transport/telegram/api.js';

export interface StubCall {
  botId: string;
  token: string;
  method: string;
  params: Record<string, any>;
}

type Scripted = { status: number; body: unknown } | 'network';

/**
 * In-memory Telegram Bot API behind a stub `fetch`. Records every call; sendMessage
 * returns increasing message ids; getUpdates serves queued batches, then waits until
 * aborted (like a long poll with nothing new).
 */
export class StubBotApi {
  readonly calls: StubCall[] = [];
  private readonly scripted = new Map<string, Scripted[]>();
  private readonly persistent = new Map<string, Scripted>();
  private readonly updates = new Map<string, unknown[][]>();
  private messageId = 100;

  /** The next `n` calls of `method` get this response. */
  failNext(method: string, response: Scripted, n = 1): void {
    const queue = this.scripted.get(method) ?? [];
    for (let i = 0; i < n; i += 1) queue.push(response);
    this.scripted.set(method, queue);
  }

  /** Every call of `method` gets this response until cleared with null. */
  failAlways(method: string, response: Scripted | null): void {
    if (response) this.persistent.set(method, response);
    else this.persistent.delete(method);
  }

  queueUpdates(botId: string, batch: unknown[]): void {
    const queue = this.updates.get(botId) ?? [];
    queue.push(batch);
    this.updates.set(botId, queue);
  }

  callsOf(method: string): StubCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Texts sent to a chat, in order. */
  textsTo(chatId: string | number): string[] {
    return this.callsOf('sendMessage')
      .filter((c) => String(c.params.chat_id) === String(chatId))
      .map((c) => c.params.text as string);
  }

  readonly fetch: FetchFn = async (url, init) => {
    const m = /^https:\/\/api\.telegram\.org\/bot((\d+):[^/]+)\/(\w+)$/.exec(url);
    if (!m) throw new Error(`stub: unexpected url`);
    const [, token, botId, method] = m as unknown as [string, string, string, string];
    const params = JSON.parse(String(init.body ?? '{}')) as Record<string, any>;
    this.calls.push({ botId, token, method, params });
    const scripted = this.scripted.get(method)?.shift() ?? this.persistent.get(method);
    if (scripted === 'network') throw new TypeError(`fetch failed for ${url}`);
    if (scripted) return json(scripted.status, scripted.body);
    return this.respond(botId, method, params, init.signal ?? undefined);
  };

  private async respond(botId: string, method: string, params: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    switch (method) {
      case 'sendMessage':
        this.messageId += 1;
        return ok({ message_id: this.messageId, chat: { id: Number(params.chat_id), type: 'private' }, text: params.text });
      case 'getMe':
        return ok({ id: Number(botId), is_bot: true, first_name: 'Violet', username: `violet_${botId}_bot` });
      case 'getUpdates': {
        const batch = this.updates.get(botId)?.shift();
        if (batch) return ok(batch);
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('aborted'));
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return ok([]);
      }
      default:
        return ok(true);
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ok(result: unknown): Response {
  return json(200, { ok: true, result });
}

export const tgError = (status: number, description: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { ok: false, error_code: status, description, ...extra },
});
