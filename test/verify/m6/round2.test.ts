/**
 * Independent verifier, M6 round 2. Adversarial tests for the Telegram transport after
 * the round-1 fixes. Tests that currently fail are kept as evidence of findings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../src/clock.js';
import { CANNED, OWNER_TEXT } from '../../../src/core/canned.js';
import { runInJob } from '../../../src/core/jobContext.js';
import type { OwnerMessageCtx } from '../../../src/core/router.js';
import { parseConfig } from '../../../src/config.js';
import { normalizeUpdate, telegramUpdate } from '../../../src/transport/telegram/normalize.js';
import { createTelegramPoller } from '../../../src/transport/telegram/poller.js';
import { SECRET_HEADER } from '../../../src/transport/telegram/routes.js';
import { telegramStateRepo } from '../../../src/transport/telegram/state.js';
import { parseBotTokens, TelegramTransport, telegramTransportFromConfig } from '../../../src/transport/telegram/transport.js';
import type { FetchFn } from '../../../src/transport/telegram/api.js';
import { tgError } from '../../unit/telegram/stub.js';
import {
  ALEX_TOKEN,
  buttonUpdate,
  createTelegramWorld,
  SAM_BOT,
  SAM_TG,
  SAM_TOKEN,
  textUpdate,
  TOKEN_SECRETS,
  WEBHOOK_SECRET,
  type TelegramWorld,
} from '../../unit/telegram/world.js';

let w: TelegramWorld | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.close();
  w = undefined;
});

/** A sendMessage stub whose n-th call (1-based) fails with 429; records delivered texts. */
function flakySend(failOnCall: number) {
  const delivered: string[] = [];
  let calls = 0;
  let id = 500;
  const fetchFn: FetchFn = async (_url, init) => {
    calls += 1;
    const p = JSON.parse(String(init.body)) as { chat_id: string; text: string };
    if (calls === failOnCall) {
      return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }), {
        status: 429,
      });
    }
    delivered.push(p.text);
    id += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: Number(p.chat_id), type: 'private' } } }), {
      status: 200,
    });
  };
  return { fetchFn, delivered };
}

const LONG = ['A'.repeat(4000), 'B'.repeat(4000), 'C'.repeat(4000)].join('\n\n');

describe('verify M6 round 2: multi-chunk resume state', () => {
  it('a resume record left by an abandoned send must not make a later, separate message with the same text lose its first chunks', async () => {
    const { fetchFn, delivered } = flakySend(2);
    const t = new TelegramTransport(parseBotTokens(SAM_TOKEN), fetchFn, new FakeClock());
    const msg = { agentAddress: SAM_BOT, toAddress: SAM_TG, text: LONG, purpose: 'transcript' as const };
    // Send #1: chunk A goes out, chunk B hits 429. Its job is then abandoned (e.g. dead
    // after its attempts, or the gateway gives up) — the transport is never told.
    // (Fix round 2: sends run inside their job, as the job queue does in production.)
    await expect(runInJob('job-1', () => t.send(msg))).rejects.toThrow(/429/);
    expect(delivered).toEqual(['A'.repeat(4000)]);
    delivered.length = 0;
    // Later, a NEW request produces the very same text (owner asks for the transcript
    // again). It must be delivered in full: the owner never got B and C, and has to get A
    // again as part of this new message.
    await runInJob('job-2', () => t.send(msg));
    expect(delivered).toEqual(['A'.repeat(4000), 'B'.repeat(4000), 'C'.repeat(4000)]);
  });

  it('a resumed send still puts the buttons on the last chunk only', async () => {
    const { fetchFn } = flakySend(2);
    const calls: { text: string; markup?: unknown }[] = [];
    const t = new TelegramTransport(parseBotTokens(SAM_TOKEN), async (url, init) => {
      const p = JSON.parse(String(init.body)) as { text: string; reply_markup?: unknown };
      calls.push({ text: p.text, markup: p.reply_markup });
      return fetchFn(url, init);
    }, new FakeClock());
    const msg = { agentAddress: SAM_BOT, toAddress: SAM_TG, text: LONG, purpose: 'approval' as const, buttons: [{ id: 'approve:a1', label: 'Yes' }] };
    // (Fix round 2: only a retry of the same job resumes, so both attempts run in one job.)
    await expect(runInJob('job-1', () => t.send(msg))).rejects.toThrow();
    const res = await runInJob('job-1', () => t.send(msg));
    expect(calls.map((c) => c.text[0])).toEqual(['A', 'B', 'B', 'C']);
    expect(calls.slice(0, 3).every((c) => c.markup === undefined)).toBe(true);
    expect(calls[3]!.markup).toEqual({ inline_keyboard: [[{ text: 'Yes', callback_data: 'approve:a1' }]] });
    expect(res.transportMessageId).toMatch(new RegExp(`^${SAM_TG}:\\d+$`));
  });
});

describe('verify M6 round 2: Clock discipline', () => {
  it('the production wiring (telegramTransportFromConfig) never reads Date.now: app code takes a Clock', async () => {
    const { fetchFn } = flakySend(2);
    const config = parseConfig({ NODE_ENV: 'test', TRANSPORT: 'telegram', TELEGRAM_BOT_TOKENS: SAM_TOKEN, TELEGRAM_MODE: 'polling' });
    // Spy first: the transport captures Date.now as a default argument at construction.
    const spy = vi.spyOn(Date, 'now');
    const t = telegramTransportFromConfig(config, new FakeClock(), fetchFn);
    const msg = { agentAddress: SAM_BOT, toAddress: SAM_TG, text: LONG, purpose: 'reply' as const };
    // (Fix round 2: inside a job, so the partial-send record and its expiry are exercised.)
    await expect(runInJob('job-1', () => t.send(msg))).rejects.toThrow();
    await runInJob('job-1', () => t.send(msg));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('verify M6 round 2: webhook edge cases', () => {
  it('right secret but no content-type (or text/plain): never a 500, never echoed, valid JSON still ingested once', async () => {
    w = await createTelegramWorld();
    const u = textUpdate('3303', 'hi-marker-xyz');
    const a = await w.post(SAM_BOT, u, { [SECRET_HEADER]: WEBHOOK_SECRET, 'content-type': 'text/plain' });
    expect([200, 400, 415]).toContain(a.statusCode);
    expect(a.body).not.toContain('marker');
    const ev = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_events');
    expect(ev.rows[0]!.n).toBeLessThanOrEqual(1);
  });

  it('wrong secret of the same length, a prefix and an empty header: 401 and nothing stored or logged as inbound', async () => {
    w = await createTelegramWorld();
    const variants = [
      WEBHOOK_SECRET.slice(0, -1) + (WEBHOOK_SECRET.endsWith('x') ? 'y' : 'x'),
      WEBHOOK_SECRET.slice(0, 8),
      '',
      ` ${WEBHOOK_SECRET}`,
      `${WEBHOOK_SECRET}\u0000`,
    ];
    for (const s of variants) {
      const res = await w.post(SAM_BOT, textUpdate(SAM_TG, 'pause'), { [SECRET_HEADER]: s });
      expect(res.statusCode).toBe(401);
    }
    // unknown bot with a wrong secret: still 401 (does not reveal which bots exist)
    expect((await w.post('7999999999', textUpdate(SAM_TG, 'x'), { [SECRET_HEADER]: 'nope' })).statusCode).toBe(401);
    await w.app.settle();
    const ev = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_events');
    expect(ev.rows[0]!.n).toBe(0);
    expect(await w.app.actionLog.list({ action: 'inbound.dropped' })).toEqual([]);
    expect((await w.app.repos.agents.get(w.sam.agent.id))!.paused).toBe(false);
  });

  it('an update carrying a NUL character from a stranger is stored (or dropped) — it must not 500 forever', async () => {
    w = await createTelegramWorld();
    const u = textUpdate('3303', 'hi\u0000there', { from: { id: 3303, is_bot: false, first_name: 'A\u0000lex' } });
    const res = await w.post(SAM_BOT, u);
    expect(w.logs.join('\n')).not.toMatch(/telegram webhook failed/);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('verify M6 round 2: owner attribution (I1, principle 3, I5)', () => {
  const NOW = new Date('2026-11-09T09:00:00Z');
  const norm = (u: unknown) => normalizeUpdate(SAM_BOT, telegramUpdate.parse(u), NOW);

  it('a forward whose only marker is forward_origin of type "hidden_user" / "channel" is still not owner text', () => {
    for (const origin of [
      { type: 'hidden_user', date: 0, sender_user_name: 'Alex' },
      { type: 'channel', date: 0, chat: { id: -100, type: 'channel' }, message_id: 1 },
      { type: 'chat', date: 0, sender_chat: { id: -200, type: 'supergroup' } },
    ]) {
      const n = norm(textUpdate(SAM_TG, 'yes', { forward_origin: origin }));
      expect(n).toMatchObject({ action: 'ingest', msg: { kind: 'unsupported', text: '' } });
    }
  });

  it('end to end: a forwarded "yes" replying to an approval prompt never reaches the owner interceptors', async () => {
    w = await createTelegramWorld();
    const seen: OwnerMessageCtx[] = [];
    w.app.router.hooks.ownerInterceptors.push(async (ctx) => {
      seen.push(ctx);
      return true;
    });
    const prompt = await w.app.gateway.sendToOwner(w.sam.agent.id, '#1 Book it?', { purpose: 'approval', buttons: [{ id: 'approve:a1', label: 'Yes' }] });
    const [chatId, messageId] = prompt!.transportMessageId.split(':');
    const reply = { message_id: Number(messageId), date: 0, chat: { id: Number(chatId), type: 'private' } };
    await w.post(
      SAM_BOT,
      textUpdate(SAM_TG, 'yes', { reply_to_message: reply, forward_origin: { type: 'hidden_user', date: 0, sender_user_name: 'Alex' } }),
    );
    await w.app.settle();
    expect(seen).toEqual([]);
  });

  it("a button press by a stranger on the owner's own prompt message id is the stranger's, not the owner's", async () => {
    w = await createTelegramWorld();
    const seen: OwnerMessageCtx[] = [];
    w.app.router.hooks.ownerInterceptors.push(async (ctx) => {
      seen.push(ctx);
      return true;
    });
    const prompt = await w.app.gateway.sendToOwner(w.sam.agent.id, '#2 Book it?', { purpose: 'approval', buttons: [{ id: 'approve:a2', label: 'Yes' }] });
    const [chatId, messageId] = prompt!.transportMessageId.split(':');
    // Forged chat: the stranger claims the message lives in the owner's chat.
    await w.post(SAM_BOT, buttonUpdate('3303', 'approve:a2', chatId!, Number(messageId)));
    await w.app.settle();
    expect(seen).toEqual([]);
    expect(w.api.textsTo('3303')).toEqual([CANNED.stranger_reply]);
  });
});

describe('verify M6 round 2: poller lifecycle and leaks', () => {
  it('stop() during a real back-off wait returns promptly (no timer left running)', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    w.api.failAlways('getUpdates', 'network');
    const t = new TelegramTransport(parseBotTokens(SAM_TOKEN), w.api.fetch, new FakeClock());
    // default sleep (real setTimeout), long back-off
    const poller = createTelegramPoller(w.app, t, { timeoutSec: 0, backoffMs: () => 60_000 });
    poller.start();
    await vi.waitFor(() => expect(w!.logs.join('\n')).toMatch(/telegram poll failed/));
    const t0 = performance.now();
    await poller.stop();
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('a revoked token (401 on getUpdates) is logged without the token, and the loop backs off', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    w.api.failAlways('getUpdates', tgError(401, 'Unauthorized'));
    const t = new TelegramTransport(parseBotTokens(`${ALEX_TOKEN},${SAM_TOKEN}`), w.api.fetch, new FakeClock());
    const sleeps: number[] = [];
    const poller = createTelegramPoller(w.app, t, {
      timeoutSec: 0,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (sleeps.length > 6) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    });
    poller.start();
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThan(6));
    await poller.stop();
    const surface = await w.leakSurface();
    for (const s of TOKEN_SECRETS) expect(surface).not.toContain(s);
    expect(w.logs.join('\n')).toMatch(/401/);
  });

  it('polling: one update that can never be stored (NUL in the text) must not block every later update of the bot', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const bad = textUpdate('3303', 'hi\u0000there');
    const good = textUpdate(SAM_TG, 'hello');
    const pending = [bad, good];
    const t = new TelegramTransport(parseBotTokens(SAM_TOKEN), async (url, init) => {
      if (url.endsWith('/getUpdates')) {
        const p = JSON.parse(String(init.body)) as { offset?: number };
        const out = pending.filter((u) => p.offset === undefined || u.update_id >= p.offset);
        return new Response(JSON.stringify({ ok: true, result: out }), { status: 200 });
      }
      return w!.api.fetch(url, init);
    }, new FakeClock());
    const poller = createTelegramPoller(w.app, t, { timeoutSec: 0 });
    for (let i = 0; i < 5; i += 1) await poller.pollOnce(SAM_BOT).catch(() => undefined);
    await w.app.settle();
    // The owner's message behind the poison update is received.
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp]);
  });

  it('the stored offset is sent while fresh, and a ≥6-day-old one is not (but the update is still received once)', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const offsets: (number | undefined)[] = [];
    const u = textUpdate(SAM_TG, 'hello');
    let served = false;
    const t = new TelegramTransport(parseBotTokens(SAM_TOKEN), async (url, init) => {
      if (url.endsWith('/getUpdates')) {
        const p = JSON.parse(String(init.body)) as { offset?: number };
        offsets.push(p.offset);
        const out = !served && (p.offset === undefined || u.update_id >= p.offset) ? [u] : [];
        served = true;
        return new Response(JSON.stringify({ ok: true, result: out }), { status: 200 });
      }
      return w!.api.fetch(url, init);
    }, new FakeClock());
    await telegramStateRepo(w.db).save(SAM_BOT, u.update_id - 1, w.clock.now());
    const poller = createTelegramPoller(w.app, t, { timeoutSec: 0 });
    w.clock.advance({ days: 5 });
    await poller.pollOnce(SAM_BOT);
    expect(offsets).toEqual([u.update_id]);
    await w.app.settle();
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp]);
  });
});
