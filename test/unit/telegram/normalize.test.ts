import { describe, expect, it } from 'vitest';
import { normalizeUpdate, telegramUpdate } from '../../../src/transport/telegram/normalize.js';

const BOT = '7000000001';
const at = new Date('2026-11-09T09:00:00Z');
const alex = { id: 1101, is_bot: false, first_name: 'Alex', last_name: 'Doe' };
const privateChat = { id: 1101, type: 'private' };

function norm(update: unknown) {
  return normalizeUpdate(BOT, telegramUpdate.parse(update), at);
}

describe('normalizeUpdate', () => {
  it('private text → kind text with ids in transport formats', () => {
    expect(norm({ update_id: 42, message: { message_id: 9, chat: privateChat, from: alex, text: 'hi there' } })).toEqual({
      action: 'ingest',
      msg: {
        transport: 'telegram',
        agentAddress: BOT,
        fromAddress: '1101',
        fromName: 'Alex Doe',
        kind: 'text',
        text: 'hi there',
        transportMessageId: `${BOT}:42`,
        receivedAt: at,
      },
    });
  });

  it('NUL characters and lone surrogates (which Postgres jsonb rejects) are made storable in text, names and button data', () => {
    const from = { id: 1101, is_bot: false, first_name: 'A\u0000lex', last_name: '\uD800' };
    expect(norm({ update_id: 1, message: { message_id: 9, chat: privateChat, from, text: 'hi\u0000there \uDC00 😀' } })).toMatchObject({
      action: 'ingest',
      msg: { kind: 'text', text: 'hithere \uFFFD 😀', fromName: 'Alex \uFFFD' },
    });
    const nameless = norm({ update_id: 2, message: { message_id: 9, chat: privateChat, from: { id: 1101, first_name: '\u0000' }, text: 'x' } });
    expect(nameless.action).toBe('ingest');
    expect(nameless.action === 'ingest' && 'fromName' in nameless.msg).toBe(false);
    const q = { id: 'q', from: alex, data: 'approve:\u0000a1', message: { message_id: 5, chat: privateChat } };
    expect(norm({ update_id: 3, callback_query: q })).toMatchObject({ action: 'ingest', msg: { buttonPayload: 'approve:a1' } });
  });

  it('reply_to_message → replyToTransportMessageId "<chat id>:<message id>", like outbound ids', () => {
    const n = norm({
      update_id: 43,
      message: { message_id: 10, chat: privateChat, from: alex, text: 'yes', reply_to_message: { message_id: 7, chat: privateChat } },
    });
    expect(n.action === 'ingest' && n.msg.replyToTransportMessageId).toBe('1101:7');
  });

  it('first name only, and no name at all', () => {
    const one = norm({ update_id: 1, message: { message_id: 1, chat: privateChat, from: { id: 1101, is_bot: false, first_name: 'Sam' }, text: 'x' } });
    expect(one.action === 'ingest' && one.msg.fromName).toBe('Sam');
    const none = norm({ update_id: 2, message: { message_id: 1, chat: privateChat, from: { id: 1101, is_bot: false, first_name: ' ' }, text: 'x' } });
    expect(none.action === 'ingest' && 'fromName' in none.msg).toBe(false);
  });

  it.each([
    ['photo', { photo: [{ file_id: 'f' }], caption: 'look' }],
    ['voice', { voice: { file_id: 'v' } }],
    ['sticker', { sticker: { file_id: 's' } }],
    ['location', { location: { latitude: 1, longitude: 2 } }],
    ['document', { document: { file_id: 'd' } }],
  ])('%s → kind unsupported with empty text', (_name, extra) => {
    const n = norm({ update_id: 3, message: { message_id: 1, chat: privateChat, from: alex, ...extra } });
    expect(n).toMatchObject({ action: 'ingest', msg: { kind: 'unsupported', text: '', fromAddress: '1101' } });
  });

  it.each([
    ['forward_origin', { forward_origin: { type: 'user', date: 0, sender_user: { id: 3303, is_bot: false, first_name: 'Sam' } } }],
    ['forward_from (older API)', { forward_from: { id: 3303, is_bot: false, first_name: 'Sam' }, forward_date: 0 }],
    ['forward_from_chat', { forward_from_chat: { id: -1005, type: 'channel' }, forward_date: 0 }],
    ['forward_sender_name (hidden account)', { forward_sender_name: 'Someone', forward_date: 0 }],
    ['via_bot (inline bot output)', { via_bot: { id: 9009, is_bot: true, first_name: 'Inline' } }],
  ])('text the sender did not type (%s) → unsupported, never the sender\'s own text', (_name, extra) => {
    const n = norm({ update_id: 5, message: { message_id: 1, chat: privateChat, from: alex, text: 'yes, approve', ...extra } });
    expect(n).toMatchObject({ action: 'ingest', msg: { kind: 'unsupported', text: '', fromAddress: '1101' } });
  });

  it('callback_query → kind button from the pressing user, replying to the message with the button', () => {
    const n = norm({
      update_id: 44,
      callback_query: {
        id: 'cbq-1',
        from: { id: 3303, is_bot: false, first_name: 'Other' },
        chat_instance: 'x',
        data: 'approve:abc',
        message: { message_id: 55, chat: privateChat },
      },
    });
    expect(n).toEqual({
      action: 'ingest',
      callbackQueryId: 'cbq-1',
      msg: {
        transport: 'telegram',
        agentAddress: BOT,
        fromAddress: '3303',
        fromName: 'Other',
        kind: 'button',
        text: '',
        buttonPayload: 'approve:abc',
        replyToTransportMessageId: '1101:55',
        transportMessageId: `${BOT}:44`,
        receivedAt: at,
      },
    });
  });

  it('callback_query without data or without a message (inline/game) → ignore', () => {
    expect(norm({ update_id: 5, callback_query: { id: 'c', from: alex, chat_instance: 'x', message: { message_id: 1, chat: privateChat } } })).toMatchObject({ action: 'ignore' });
    expect(norm({ update_id: 6, callback_query: { id: 'c', from: alex, chat_instance: 'x', data: 'd' } })).toMatchObject({ action: 'ignore' });
  });

  it.each(['edited_message', 'edited_channel_post'])('%s in a private chat → ignore', (key) => {
    expect(norm({ update_id: 7, [key]: { message_id: 1, chat: privateChat, from: alex, text: 'edited' } })).toEqual({
      action: 'ignore',
      reason: 'unhandled_update',
    });
  });

  it('other update types → ignore', () => {
    expect(norm({ update_id: 8, my_chat_member: { chat: privateChat } })).toEqual({ action: 'ignore', reason: 'unhandled_update' });
  });

  it.each(['group', 'supergroup'])('%s message → ignore and leave the chat', (type) => {
    expect(norm({ update_id: 9, message: { message_id: 1, chat: { id: -100, type }, from: alex, text: 'hi bot' } })).toEqual({
      action: 'ignore',
      reason: 'not_private',
      leaveChatId: -100,
    });
  });

  it('channel post → ignore and leave the channel', () => {
    expect(norm({ update_id: 10, channel_post: { message_id: 1, chat: { id: -200, type: 'channel' }, text: 'news' } })).toMatchObject({
      action: 'ignore',
      leaveChatId: -200,
    });
  });

  it('a button pressed in a group → ignore and leave', () => {
    const n = norm({ update_id: 11, callback_query: { id: 'c', from: alex, chat_instance: 'x', data: 'd', message: { message_id: 1, chat: { id: -300, type: 'group' } } } });
    expect(n).toMatchObject({ action: 'ignore', leaveChatId: -300 });
  });

  it('bot senders → ignore (message and button)', () => {
    const bot = { id: 999, is_bot: true, first_name: 'Bot' };
    expect(norm({ update_id: 12, message: { message_id: 1, chat: { id: 999, type: 'private' }, from: bot, text: 'beep' } })).toEqual({
      action: 'ignore',
      reason: 'bot_sender',
    });
    expect(norm({ update_id: 13, callback_query: { id: 'c', from: bot, chat_instance: 'x', data: 'd', message: { message_id: 1, chat: privateChat } } })).toEqual({
      action: 'ignore',
      reason: 'bot_sender',
    });
  });

  it('a message without a sender → ignore', () => {
    expect(norm({ update_id: 14, message: { message_id: 1, chat: privateChat, text: 'x' } })).toMatchObject({ action: 'ignore' });
  });

  it('the update schema rejects malformed updates', () => {
    expect(telegramUpdate.safeParse({}).success).toBe(false);
    expect(telegramUpdate.safeParse({ update_id: 'x' }).success).toBe(false);
    expect(telegramUpdate.safeParse({ update_id: 1, message: { chat: privateChat } }).success).toBe(false);
  });
});
