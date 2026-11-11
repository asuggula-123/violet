import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../src/clock.js';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { createTelegramPoller } from '../../../src/transport/telegram/poller.js';
import { parseBotTokens, TelegramTransport } from '../../../src/transport/telegram/transport.js';
import { registerWebhooks, startTelegram } from '../../../src/transport/telegram/start.js';
import { telegramStateRepo } from '../../../src/transport/telegram/state.js';
import { tgError } from './stub.js';
import { ALEX_BOT, buttonUpdate, createTelegramWorld, SAM_BOT, SAM_TG, SAM_TOKEN, textUpdate, TOKEN_SECRETS, WEBHOOK_SECRET, type TelegramWorld } from './world.js';

let w: TelegramWorld;
afterEach(async () => w.close());

describe('Telegram polling', () => {
  it('ingests a batch, persists the offset and asks for the next update after it', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const poller = createTelegramPoller(w.app, w.transport, { timeoutSec: 25 });
    const a = textUpdate(SAM_TG, 'one');
    const b = textUpdate(SAM_TG, 'two');
    w.api.queueUpdates(SAM_BOT, [a, b]);
    expect(await poller.pollOnce(SAM_BOT)).toBe(2);
    expect(await telegramStateRepo(w.db).lastUpdateId(SAM_BOT)).toBe(b.update_id);
    expect(w.api.callsOf('getUpdates')[0]!.params).toEqual({ timeout: 25, allowed_updates: ['message', 'callback_query'] });

    w.api.queueUpdates(SAM_BOT, []);
    // A new poller (a restart) starts from the stored offset.
    await createTelegramPoller(w.app, w.transport, { timeoutSec: 25 }).pollOnce(SAM_BOT);
    expect(w.api.callsOf('getUpdates')[1]!.params).toMatchObject({ offset: b.update_id + 1 });
    await w.app.settle();
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp, OWNER_TEXT.notSetUp]);
  });

  it('an offset older than 6 days is not sent, and a restarted (lower) update id is followed', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const poller = createTelegramPoller(w.app, w.transport, { timeoutSec: 0 });
    const state = telegramStateRepo(w.db);
    await state.save(SAM_BOT, 900_000, w.clock.now());
    w.clock.advance({ days: 5, hours: 23 });
    w.api.queueUpdates(SAM_BOT, []);
    await poller.pollOnce(SAM_BOT);
    expect(w.api.callsOf('getUpdates')[0]!.params).toMatchObject({ offset: 900_001 });

    w.clock.advance({ hours: 2 });
    const low = { ...textUpdate(SAM_TG, 'after a quiet week'), update_id: 12_345 };
    w.api.queueUpdates(SAM_BOT, [low]);
    expect(await poller.pollOnce(SAM_BOT)).toBe(1);
    expect(w.api.callsOf('getUpdates')[1]!.params).not.toHaveProperty('offset');
    expect(await state.get(SAM_BOT)).toEqual({ lastUpdateId: 12_345, updatedAt: w.clock.now() });

    w.api.queueUpdates(SAM_BOT, []);
    await poller.pollOnce(SAM_BOT);
    expect(w.api.callsOf('getUpdates')[2]!.params).toMatchObject({ offset: 12_346 });
    await w.app.settle();
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp]);
  });

  it('an ingest failure loses nothing: the offset stops before the failed update', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const poller = createTelegramPoller(w.app, w.transport);
    const [a, b, c] = [textUpdate(SAM_TG, 'a'), textUpdate(SAM_TG, 'b'), textUpdate(SAM_TG, 'c')];
    const real = w.app.ingest;
    let calls = 0;
    w.app.ingest = async (msg) => {
      calls += 1;
      if (calls === 2) throw new Error('db blip');
      return real(msg);
    };
    w.api.queueUpdates(SAM_BOT, [a, b, c]);
    await expect(poller.pollOnce(SAM_BOT)).rejects.toThrow('db blip');
    expect(await telegramStateRepo(w.db).lastUpdateId(SAM_BOT)).toBe(a.update_id);

    // Telegram redelivers b and c (offset = a + 1).
    w.api.queueUpdates(SAM_BOT, [b, c]);
    expect(await poller.pollOnce(SAM_BOT)).toBe(2);
    expect(w.api.callsOf('getUpdates')[1]!.params).toMatchObject({ offset: a.update_id + 1 });
    expect(await telegramStateRepo(w.db).lastUpdateId(SAM_BOT)).toBe(c.update_id);
    const rows = await w.db.query<{ id: string }>('SELECT transport_message_id AS id FROM inbound_events ORDER BY received_at, id');
    expect(rows.rows.map((r) => r.id).sort()).toEqual([a, b, c].map((u) => `${SAM_BOT}:${u.update_id}`).sort());
  });

  it('a redelivered update after a lost offset write is deduplicated', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const poller = createTelegramPoller(w.app, w.transport);
    const a = textUpdate(SAM_TG, 'a');
    w.api.queueUpdates(SAM_BOT, [a]);
    w.api.queueUpdates(SAM_BOT, [a]);
    await poller.pollOnce(SAM_BOT);
    await w.db.query('DELETE FROM telegram_state');
    await poller.pollOnce(SAM_BOT);
    await w.app.settle();
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp]);
    expect(await w.app.actionLog.list({ action: 'inbound.duplicate' })).toHaveLength(1);
  });

  it('a malformed update with an update_id is skipped, buttons are answered, groups are left', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const poller = createTelegramPoller(w.app, w.transport);
    const group = textUpdate(SAM_TG, 'g', { chat: { id: -7, type: 'group' } });
    const button = buttonUpdate(SAM_TG, 'approve:z', SAM_TG, 5);
    w.api.queueUpdates(SAM_BOT, [{ update_id: 1, message: 'garbage' }, group, button]);
    expect(await poller.pollOnce(SAM_BOT)).toBe(2);
    expect(await telegramStateRepo(w.db).lastUpdateId(SAM_BOT)).toBe(button.update_id);
    await vi.waitFor(() => {
      expect(w.api.callsOf('leaveChat')).toHaveLength(1);
      expect(w.api.callsOf('answerCallbackQuery')).toHaveLength(1);
    });
  });

  it('the loop deletes the webhook once, backs off on errors and stops cleanly', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const sleeps: number[] = [];
    const samOnly = new TelegramTransport(parseBotTokens(SAM_TOKEN), w.api.fetch, new FakeClock());
    const poller = createTelegramPoller(w.app, samOnly, {
      backoffMs: (n) => n * 100,
      sleep: async (ms) => void sleeps.push(ms),
    });
    w.api.failNext('deleteWebhook', 'network');
    w.api.failNext('getUpdates', tgError(502, 'Bad Gateway'), 2);
    const update = textUpdate(SAM_TG, 'hi');
    w.api.queueUpdates(SAM_BOT, [update]);
    poller.start();
    await vi.waitFor(async () => expect(await telegramStateRepo(w.db).lastUpdateId(SAM_BOT)).toBe(update.update_id));
    // Now in a long poll with nothing new; stop must abort it.
    await vi.waitFor(() => expect(w.api.callsOf('getUpdates')).toHaveLength(4));
    await poller.stop();
    // deleteWebhook: failed, then succeeded once and was not called again.
    expect(w.api.callsOf('deleteWebhook')).toHaveLength(2);
    // Three failures in a row before the first successful poll.
    expect(sleeps).toEqual([100, 200, 300]);
    const callsAtStop = w.api.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(w.api.calls.length).toBe(callsAtStop);
    for (const s of TOKEN_SECRETS) expect(w.logs.join('\n')).not.toContain(s);
  });

  it('the real back-off timer is cut short by stop()', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    w.api.failAlways('deleteWebhook', 'network');
    const stop = await startTelegram(w.app, { backoffMs: () => 3_600_000 });
    await vi.waitFor(() => expect(w.api.callsOf('deleteWebhook')).toHaveLength(2));
    const t0 = performance.now();
    await stop();
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('Telegram webhook registration', () => {
  it('calls setWebhook per bot with the secret and the allowed updates', async () => {
    w = await createTelegramWorld({ env: { PUBLIC_BASE_URL: 'https://violet.example.test/' } });
    const stop = await startTelegram(w.app);
    await stop();
    const calls = w.api.callsOf('setWebhook');
    expect(calls.map((c) => [c.botId, c.params])).toEqual(
      [ALEX_BOT, SAM_BOT].map((botId) => [
        botId,
        {
          url: `https://violet.example.test/webhooks/telegram/${botId}`,
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'],
        },
      ]),
    );
    expect(w.api.callsOf('deleteWebhook')).toEqual([]);
  });

  it('without PUBLIC_BASE_URL nothing is registered; a failing bot does not stop the others', async () => {
    w = await createTelegramWorld();
    await registerWebhooks(w.app, w.transport);
    expect(w.api.calls).toEqual([]);
    const withUrl = { ...w.app, deps: { ...w.app.deps, config: { ...w.app.deps.config, PUBLIC_BASE_URL: 'https://violet.example.test' } } };
    w.api.failNext('setWebhook', tgError(400, 'Bad Request: bad webhook'));
    await registerWebhooks(withUrl, w.transport);
    expect(w.api.callsOf('setWebhook')).toHaveLength(2);
    expect(w.logs.join('\n')).toMatch(/setWebhook failed/);
  });
});
