import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/clock.js';
import { parseConfig } from '../../../src/config.js';
import { TelegramApi } from '../../../src/transport/telegram/api.js';
import { splitText, TELEGRAM_TEXT_LIMIT } from '../../../src/transport/telegram/chunk.js';
import { checkTelegramCliArgs, telegramPairingInstructions } from '../../../src/transport/telegram/pairing.js';
import { runInJob } from '../../../src/core/jobContext.js';
import { PARTIAL_SEND_TTL_MS, parseBotTokens, TelegramTransport, telegramTransportFromConfig } from '../../../src/transport/telegram/transport.js';
import { PermanentTransportError, RetryableTransportError, TransportError } from '../../../src/transport/types.js';
import { StubBotApi, tgError } from './stub.js';
import { ALEX_BOT, ALEX_TOKEN, SAM_TOKEN, TOKEN_SECRETS } from './world.js';

const LIMIT = TELEGRAM_TEXT_LIMIT;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('splitText', () => {
  it('leaves texts up to exactly 4096 units alone', () => {
    expect(splitText('hello')).toEqual(['hello']);
    const exact = 'a'.repeat(LIMIT);
    expect(splitText(exact)).toEqual([exact]);
  });

  it('4097 units without separators → a hard cut', () => {
    const chunks = splitText('a'.repeat(LIMIT + 1));
    expect(chunks.map((c) => c.length)).toEqual([LIMIT, 1]);
  });

  it('prefers a paragraph break, then a line break, then a space', () => {
    const para = `${'a'.repeat(3000)}\n\n${'b'.repeat(500)}\n${'c'.repeat(1000)}`;
    expect(splitText(para)).toEqual(['a'.repeat(3000), `${'b'.repeat(500)}\n${'c'.repeat(1000)}`]);
    const line = `${'a'.repeat(3000)}\n${'b'.repeat(500)} ${'c'.repeat(1000)}`;
    expect(splitText(line)).toEqual(['a'.repeat(3000), `${'b'.repeat(500)} ${'c'.repeat(1000)}`]);
    const words = `${'a'.repeat(3000)} ${'b'.repeat(2000)}`;
    expect(splitText(words)).toEqual(['a'.repeat(3000), 'b'.repeat(2000)]);
  });

  it('a separator exactly at the limit still gives a full first chunk', () => {
    expect(splitText(`${'a'.repeat(LIMIT)} tail`)).toEqual(['a'.repeat(LIMIT), 'tail']);
  });

  it('ignores a break in the first half of the window rather than send a tiny chunk', () => {
    const text = `${'a'.repeat(100)}\n\n${'b'.repeat(5000)}`;
    const chunks = splitText(text);
    expect(chunks[0]!.length).toBe(LIMIT);
    expect(chunks.join('')).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(LIMIT - 1)}😀${'b'.repeat(10)}`;
    const chunks = splitText(text);
    expect(chunks).toEqual(['a'.repeat(LIMIT - 1), `😀${'b'.repeat(10)}`]);
    const emoji = '😀'.repeat(5000);
    for (const c of splitText(emoji)) {
      expect(c.length).toBeLessThanOrEqual(LIMIT);
      expect(c).not.toMatch(LONE_SURROGATE);
    }
    expect(splitText(emoji).join('')).toBe(emoji);
  });

  it('every chunk fits for long mixed text and no content is lost but separators', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Line ${i} ${'word '.repeat(i % 17)}`).join('\n');
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });
});

describe('parseBotTokens', () => {
  it('maps bot id → token', () => {
    expect([...parseBotTokens(` ${ALEX_TOKEN} , ${SAM_TOKEN}`).keys()]).toEqual([ALEX_BOT, '7000000002']);
  });

  it('rejects malformed tokens without quoting them, and duplicates', () => {
    for (const bad of ['', 'abc', '123:short', `${ALEX_TOKEN},`, `x${ALEX_TOKEN}`]) {
      let message = '';
      try {
        parseBotTokens(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/TELEGRAM_BOT_TOKENS/);
      for (const s of TOKEN_SECRETS) expect(message).not.toContain(s);
    }
    expect(() => parseBotTokens(`${ALEX_TOKEN},${ALEX_TOKEN}`)).toThrow(/listed twice/);
  });
});

describe('telegramTransportFromConfig', () => {
  const base = { TRANSPORT: 'telegram', TELEGRAM_BOT_TOKENS: ALEX_TOKEN };
  it('requires tokens, and a secret in webhook mode', () => {
    expect(() => telegramTransportFromConfig(parseConfig({ TRANSPORT: 'telegram' }), new FakeClock())).toThrow(/TELEGRAM_BOT_TOKENS/);
    expect(() => telegramTransportFromConfig(parseConfig(base), new FakeClock())).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => telegramTransportFromConfig(parseConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: 'short' }), new FakeClock())).toThrow(/16/);
    expect(telegramTransportFromConfig(parseConfig({ ...base, TELEGRAM_MODE: 'polling' }), new FakeClock()).botIds()).toEqual([ALEX_BOT]);
    expect(telegramTransportFromConfig(parseConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: 'a-long-enough-secret' }), new FakeClock()).name).toBe('telegram');
  });
});

describe('TelegramTransport.send', () => {
  function setup() {
    const api = new StubBotApi();
    return { api, t: new TelegramTransport(parseBotTokens(ALEX_TOKEN), api.fetch, new FakeClock()) };
  }

  it('sends plain text with link previews off, returns "<chat id>:<message id>"', async () => {
    const { api, t } = setup();
    const res = await t.send({ agentAddress: ALEX_BOT, toAddress: '1101', text: 'see https://example.com *bold*', purpose: 'reply' });
    expect(res.transportMessageId).toBe('1101:101');
    const [call] = api.calls;
    expect(call).toMatchObject({ botId: ALEX_BOT, method: 'sendMessage' });
    expect(call!.params).toEqual({ chat_id: '1101', text: 'see https://example.com *bold*', link_preview_options: { is_disabled: true } });
    expect(call!.params).not.toHaveProperty('parse_mode');
  });

  it('long text → several messages, buttons as one row on the last, id of the last', async () => {
    const { api, t } = setup();
    const text = `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}\n\n${'c'.repeat(100)}`;
    const buttons = [
      { id: 'approve:1', label: 'Yes' },
      { id: 'deny:1', label: 'No' },
    ];
    const res = await t.send({ agentAddress: ALEX_BOT, toAddress: '1101', text, purpose: 'approval', buttons });
    const sends = api.callsOf('sendMessage');
    expect(sends.map((c) => c.params.text)).toEqual(['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(100)]);
    expect(sends.slice(0, 2).map((c) => c.params.reply_markup)).toEqual([undefined, undefined]);
    expect(sends[2]!.params.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'approve:1' },
          { text: 'No', callback_data: 'deny:1' },
        ],
      ],
    });
    expect(res.transportMessageId).toBe('1101:103');
  });

  it('a button id over 64 bytes is a clear permanent error, before anything is sent', async () => {
    const { api, t } = setup();
    const ok = 'x'.repeat(64);
    await t.send({ agentAddress: ALEX_BOT, toAddress: '1101', text: 'hi', purpose: 'reply', buttons: [{ id: ok, label: 'ok' }] });
    const long = 'é'.repeat(33); // 66 bytes, 33 UTF-16 units
    await expect(
      t.send({ agentAddress: ALEX_BOT, toAddress: '1101', text: 'hi', purpose: 'reply', buttons: [{ id: long, label: 'no' }] }),
    ).rejects.toThrow(/66 bytes; callback_data allows at most 64/);
    await expect(
      t.send({ agentAddress: ALEX_BOT, toAddress: '1101', text: 'hi', purpose: 'reply', buttons: [{ id: long, label: 'no' }] }),
    ).rejects.toBeInstanceOf(PermanentTransportError);
    expect(api.callsOf('sendMessage')).toHaveLength(1);
  });

  it('a retryable failure partway through a long send: the same job\'s retry resumes after the delivered chunks', async () => {
    const { api } = setup();
    const text = `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}\n\n${'c'.repeat(100)}`;
    const msg = { agentAddress: ALEX_BOT, toAddress: '1101', text, purpose: 'approval' as const, buttons: [{ id: 'approve:1', label: 'Yes' }] };
    // Chunk 1 goes out, chunk 2 hits a 429, then a 502 on the first retry.
    const realFetch = api.fetch;
    let n = 0;
    const flaky = new TelegramTransport(parseBotTokens(ALEX_TOKEN), async (url, init) => {
      n += 1;
      if (n === 2) return new Response(JSON.stringify(tgError(429, 'Too Many Requests', { parameters: { retry_after: 3 } }).body), { status: 429 });
      if (n === 3) return new Response(JSON.stringify(tgError(502, 'Bad Gateway').body), { status: 502 });
      return realFetch(url, init);
    }, new FakeClock());
    const inJob = () => runInJob('job-1', () => flaky.send(msg));
    await expect(inJob()).rejects.toBeInstanceOf(RetryableTransportError);
    await expect(inJob()).rejects.toBeInstanceOf(RetryableTransportError);
    const res = await inJob();
    expect(api.callsOf('sendMessage').map((c) => c.params.text)).toEqual(['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(100)]);
    expect(api.callsOf('sendMessage')[2]!.params.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Yes', callback_data: 'approve:1' }]] });
    expect(res.transportMessageId).toBe('1101:103');

    // Once delivered, the same text sent again is a new message and goes out whole.
    await inJob();
    expect(api.callsOf('sendMessage')).toHaveLength(6);
  });

  it('a partly sent message is resumed only by the same job: another job, or a send outside a job, gets it whole', async () => {
    const api = new StubBotApi();
    const t = new TelegramTransport(parseBotTokens(ALEX_TOKEN), api.fetch, new FakeClock());
    const msg = { agentAddress: ALEX_BOT, toAddress: '1101', text: `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}`, purpose: 'transcript' as const };
    const texts = () => api.callsOf('sendMessage').map((c) => c.params.text[0]);
    api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 1, chat: { id: 1101, type: 'private' } } } });
    api.failNext('sendMessage', 'network');
    await expect(runInJob('job-1', () => t.send(msg))).rejects.toBeInstanceOf(RetryableTransportError);
    // job-1 is abandoned; a new job with the same text gets every chunk
    await runInJob('job-2', () => t.send(msg));
    expect(texts()).toEqual(['a', 'b', 'a', 'b']);
    // outside a job nothing is remembered: a failure partway is never resumed
    api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 2, chat: { id: 1101, type: 'private' } } } });
    api.failNext('sendMessage', 'network');
    await expect(t.send(msg)).rejects.toBeInstanceOf(RetryableTransportError);
    await t.send(msg);
    expect(texts()).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('a partly sent message is forgotten after a permanent error or after the TTL', async () => {
    const api = new StubBotApi();
    const clock = new FakeClock();
    const t = new TelegramTransport(parseBotTokens(ALEX_TOKEN), api.fetch, clock);
    const send = () => runInJob('job-1', () => t.send(msg));
    const msg = { agentAddress: ALEX_BOT, toAddress: '1101', text: `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}`, purpose: 'reply' as const };
    api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 1, chat: { id: 1101, type: 'private' } } } });
    api.failNext('sendMessage', 'network');
    await expect(send()).rejects.toBeInstanceOf(RetryableTransportError);
    clock.advance({ ms: PARTIAL_SEND_TTL_MS + 1 });
    await send();
    expect(api.callsOf('sendMessage').map((c) => c.params.text[0])).toEqual(['a', 'b', 'a', 'b']);

    api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 2, chat: { id: 1101, type: 'private' } } } });
    api.failNext('sendMessage', tgError(403, 'Forbidden: bot was blocked by the user'));
    await expect(send()).rejects.toBeInstanceOf(PermanentTransportError);
    await send();
    expect(api.callsOf('sendMessage').map((c) => c.params.text[0])).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('unknown bot and empty text are permanent errors', async () => {
    const { t } = setup();
    await expect(t.send({ agentAddress: '999', toAddress: '1101', text: 'hi', purpose: 'reply' })).rejects.toBeInstanceOf(PermanentTransportError);
    await expect(t.send({ agentAddress: ALEX_BOT, toAddress: '1101', text: '  ', purpose: 'reply' })).rejects.toBeInstanceOf(PermanentTransportError);
  });
});

describe('TelegramApi errors', () => {
  async function failWith(response: Parameters<StubBotApi['failNext']>[1]): Promise<TransportError> {
    const api = new StubBotApi();
    api.failNext('sendMessage', response);
    const client = new TelegramApi(ALEX_TOKEN, api.fetch);
    const err = await client.sendMessage({ chat_id: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    const e = err as TransportError;
    for (const s of TOKEN_SECRETS) {
      expect(e.message).not.toContain(s);
      expect(String(e.stack)).not.toContain(s);
      expect(JSON.stringify(e)).not.toContain(s);
    }
    expect(e.cause).toBeUndefined();
    return e;
  }

  it('403 blocked / chat not found / bad request are permanent', async () => {
    const blocked = await failWith(tgError(403, 'Forbidden: bot was blocked by the user'));
    expect(blocked).toBeInstanceOf(PermanentTransportError);
    expect(blocked).toMatchObject({ permanent: true, reason: 'forbidden', message: 'telegram sendMessage failed: 403 Forbidden: bot was blocked by the user' });
    expect(await failWith(tgError(400, 'Bad Request: chat not found'))).toMatchObject({ permanent: true, reason: 'bad_request' });
    expect(await failWith(tgError(403, "Forbidden: bot can't initiate conversation with a user"))).toMatchObject({ permanent: true });
    expect(await failWith(tgError(401, 'Unauthorized'))).toMatchObject({ permanent: true, reason: 'unauthorized' });
  });

  it('429 is retryable with retryAfterMs; 5xx and network errors are retryable', async () => {
    const limited = await failWith(tgError(429, 'Too Many Requests: retry after 17', { parameters: { retry_after: 17 } }));
    expect(limited).toBeInstanceOf(RetryableTransportError);
    expect(limited).toMatchObject({ permanent: false, reason: 'rate_limited', retryAfterMs: 17_000 });
    expect(await failWith(tgError(502, 'Bad Gateway'))).toMatchObject({ permanent: false, reason: 'server_error' });
    expect(await failWith({ status: 500, body: 'not json' })).toMatchObject({ permanent: false, message: 'telegram sendMessage failed: 500' });
    // The stub's network error quotes the URL (and so the token), as real fetch errors can.
    expect(await failWith('network')).toMatchObject({ permanent: false, reason: 'network', message: 'telegram sendMessage: network error' });
  });
});

describe('owner:add telegram helpers', () => {
  it('prints the exact /start text and a deep link when the username is known', () => {
    expect(telegramPairingInstructions('ABCD234567')).toEqual(['Open the bot in Telegram and send exactly:', '  /start ABCD234567']);
    const { botUsername } = checkTelegramCliArgs(ALEX_BOT, '@alex_violet_bot');
    expect(telegramPairingInstructions('ABCD234567', botUsername)).toContain('  https://t.me/alex_violet_bot?start=ABCD234567');
  });

  it('rejects a non-numeric bot id and a bad username', () => {
    expect(() => checkTelegramCliArgs(ALEX_TOKEN)).toThrow(/bot id/);
    expect(() => checkTelegramCliArgs('violet-alex')).toThrow(/bot id/);
    expect(() => checkTelegramCliArgs(ALEX_BOT, 'bad name/x')).toThrow(/bot-username/);
    expect(checkTelegramCliArgs(ALEX_BOT)).toEqual({});
  });
});
