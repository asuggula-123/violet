import { z } from 'zod';
import type { InboundMessage } from '../types.js';

const user = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});
const chat = z.object({ id: z.number().int(), type: z.string() });
const message = z.object({
  message_id: z.number().int(),
  chat,
  from: user.optional(),
  text: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number().int(), chat: chat.optional() }).optional(),
  // Signs that the text was not typed by the sender (forwarded, or sent through an inline bot).
  forward_origin: z.unknown().optional(),
  forward_from: z.unknown().optional(),
  forward_from_chat: z.unknown().optional(),
  forward_sender_name: z.unknown().optional(),
  forward_date: z.unknown().optional(),
  via_bot: z.unknown().optional(),
});

/**
 * Principle 3 / I5: text the sender did not type themselves (a forward, or an inline
 * bot's output) must never read as their own words. It becomes 'unsupported'.
 */
function notTypedBySender(m: z.infer<typeof message>): boolean {
  return (
    m.forward_origin !== undefined ||
    m.forward_from !== undefined ||
    m.forward_from_chat !== undefined ||
    m.forward_sender_name !== undefined ||
    m.forward_date !== undefined ||
    m.via_bot !== undefined
  );
}

/** The parts of a Telegram Update the transport reads. Unknown fields are ignored. */
export const telegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: message.optional(),
  edited_message: message.optional(),
  channel_post: message.optional(),
  edited_channel_post: message.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: user,
      data: z.string().optional(),
      message: z.object({ message_id: z.number().int(), chat }).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdate>;

export type Normalized =
  | { action: 'ingest'; msg: InboundMessage; callbackQueryId?: string }
  /** `leaveChatId`: a group, supergroup or channel the bot should leave (best effort). */
  | { action: 'ignore'; reason: string; leaveChatId?: number };

/** "<chat id>:<message id>", the same shape as outbound transport message ids. */
export function messageRef(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Untrusted strings are made storable: U+0000 is dropped and lone surrogates become
 * U+FFFD, both of which Postgres jsonb rejects. An update that can never be stored would
 * otherwise fail on every webhook redelivery and stall the poller's offset for good.
 */
export function storable(s: string): string {
  return s.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD');
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function nameOf(u: z.infer<typeof user>): string | undefined {
  const name = [u.first_name, u.last_name]
    .map((p) => (p === undefined ? '' : storable(p)))
    .filter((p) => p.trim() !== '')
    .join(' ');
  return name === '' ? undefined : name;
}

/**
 * Telegram Update → InboundMessage (or ignore). Only private chats with human senders
 * count. transportMessageId = "<bot id>:<update id>", the idempotency key (I18).
 */
export function normalizeUpdate(botId: string, update: TelegramUpdate, receivedAt: Date): Normalized {
  const anyChat =
    update.message?.chat ??
    update.edited_message?.chat ??
    update.channel_post?.chat ??
    update.edited_channel_post?.chat ??
    update.callback_query?.message?.chat;
  if (anyChat && anyChat.type !== 'private') return { action: 'ignore', reason: 'not_private', leaveChatId: anyChat.id };

  const base = { transport: 'telegram' as const, agentAddress: botId, transportMessageId: `${botId}:${update.update_id}`, receivedAt };
  const q = update.callback_query;
  if (q) {
    if (q.from.is_bot) return { action: 'ignore', reason: 'bot_sender' };
    if (q.data === undefined || !q.message) return { action: 'ignore', reason: 'no_button' };
    const fromName = nameOf(q.from);
    return {
      action: 'ingest',
      callbackQueryId: q.id,
      msg: {
        ...base,
        fromAddress: String(q.from.id),
        ...(fromName ? { fromName } : {}),
        kind: 'button',
        text: '',
        buttonPayload: storable(q.data),
        replyToTransportMessageId: messageRef(q.message.chat.id, q.message.message_id),
      },
    };
  }

  const m = update.message;
  if (!m) return { action: 'ignore', reason: 'unhandled_update' };
  if (!m.from || m.from.is_bot) return { action: 'ignore', reason: 'bot_sender' };
  const fromName = nameOf(m.from);
  const reply = m.reply_to_message;
  return {
    action: 'ingest',
    msg: {
      ...base,
      fromAddress: String(m.from.id),
      ...(fromName ? { fromName } : {}),
      ...(m.text !== undefined && !notTypedBySender(m) ? { kind: 'text' as const, text: storable(m.text) } : { kind: 'unsupported' as const, text: '' }),
      ...(reply ? { replyToTransportMessageId: messageRef(reply.chat?.id ?? m.chat.id, reply.message_id) } : {}),
      // I19: this message's number in its chat (outbound ids have the same shape).
      chatMessageId: messageRef(m.chat.id, m.message_id),
    },
  };
}
