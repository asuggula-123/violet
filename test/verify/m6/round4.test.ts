/**
 * Independent verifier, M6 round 4. New adversarial cases: duplicate ids inside one
 * getUpdates batch, poller restart, malformed-but-JSON webhook bodies, odd methods and
 * bot ids on the webhook path, and secret-before-404 ordering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { createTelegramPoller } from '../../../src/transport/telegram/poller.js';
import { SECRET_HEADER } from '../../../src/transport/telegram/routes.js';
import { telegramStateRepo } from '../../../src/transport/telegram/state.js';
import { createTelegramWorld, SAM_BOT, SAM_TG, SAM_TOKEN, textUpdate, TOKEN_SECRETS, WEBHOOK_SECRET, type TelegramWorld } from '../../unit/telegram/world.js';

let w: TelegramWorld | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.close();
  w = undefined;
});

async function countEvents(world: TelegramWorld): Promise<number> {
  const r = await world.db.query<{ n: string }>('SELECT count(*)::text AS n FROM inbound_events');
  return Number(r.rows[0]!.n);
}

describe('verify M6 round 4', () => {
  it('polling: the same update_id twice in one batch is ingested once and the offset ends on it', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const u = textUpdate(SAM_TG, 'hello twice');
    w.api.queueUpdates(SAM_BOT, [u, u]);
    const poller = createTelegramPoller(w.app, w.transport, { timeoutSec: 0 });
    await poller.pollOnce(SAM_BOT);
    await w.app.settle();
    expect(await countEvents(w)).toBe(1);
    expect(await telegramStateRepo(w.db).lastUpdateId(SAM_BOT)).toBe(u.update_id);
  });

  it('polling: stop then start again resumes from the persisted offset, re-clears the webhook, loses nothing', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    const sleep = async () => undefined;
    const first = textUpdate(SAM_TG, 'first');
    w.api.queueUpdates(SAM_BOT, [first]);
    const poller = createTelegramPoller(w.app, w.transport, { timeoutSec: 0, sleep });
    poller.start();
    await vi.waitFor(async () => expect(await telegramStateRepo(w!.db).lastUpdateId(SAM_BOT)).toBe(first.update_id));
    await poller.stop();
    const deletesBefore = w.api.callsOf('deleteWebhook').filter((c) => c.botId === SAM_BOT).length;
    const second = textUpdate(SAM_TG, 'second');
    w.api.queueUpdates(SAM_BOT, [second]);
    poller.start();
    await vi.waitFor(async () => expect(await telegramStateRepo(w!.db).lastUpdateId(SAM_BOT)).toBe(second.update_id));
    await poller.stop();
    const samPolls = w.api.callsOf('getUpdates').filter((c) => c.botId === SAM_BOT);
    expect(samPolls.some((c) => c.params.offset === first.update_id + 1)).toBe(true);
    expect(w.api.callsOf('deleteWebhook').filter((c) => c.botId === SAM_BOT).length).toBeGreaterThan(deletesBefore);
    await w.app.settle();
    expect(await countEvents(w)).toBe(2);
  });

  it('webhook: JSON that is not an update (null, array, string, negative / fractional / string id) → 400, nothing stored', async () => {
    w = await createTelegramWorld();
    const bodies = ['null', '[]', '"x"', '42', '{}', '{"update_id":-1}', '{"update_id":1.5}', '{"update_id":"5"}', '{"update_id":5,"message":"hi"}'];
    for (const b of bodies) {
      const res = await w.post(SAM_BOT, b);
      expect(res.statusCode, b).toBe(400);
      expect(res.body).not.toContain('hi');
    }
    await w.app.settle();
    expect(await countEvents(w)).toBe(0);
    expect(w.api.callsOf('sendMessage')).toHaveLength(0);
  });

  it('webhook: wrong secret on an unknown bot is 401 (no bot enumeration without the secret)', async () => {
    w = await createTelegramWorld();
    const res = await w.post('7999999999', textUpdate(SAM_TG, 'x'), { [SECRET_HEADER]: 'nope-nope-nope-nope' });
    expect(res.statusCode).toBe(401);
    const res2 = await w.post('7999999999', textUpdate(SAM_TG, 'x'), {});
    expect(res2.statusCode).toBe(401);
  });

  it('webhook: look-alike bot ids (leading zero, full token, trailing space) never ingest under another id', async () => {
    w = await createTelegramWorld();
    for (const id of [`0${SAM_BOT}`, encodeURIComponent(SAM_TOKEN), `${SAM_BOT}%20`, `${SAM_BOT}.0`, `+${SAM_BOT}`]) {
      const res = await w.post(id, textUpdate(SAM_TG, 'look-alike'));
      expect(res.statusCode, id).toBe(404);
    }
    await w.app.settle();
    expect(await countEvents(w)).toBe(0);
    const surface = await w.leakSurface();
    for (const s of TOKEN_SECRETS) expect(surface).not.toContain(s);
  });

  it('webhook: GET / PUT with the right secret do not ingest', async () => {
    w = await createTelegramWorld();
    const server = (await import('../../../src/server.js')).buildServer(w.app);
    try {
      for (const method of ['GET', 'PUT', 'DELETE'] as const) {
        const res = await server.inject({
          method,
          url: `/webhooks/telegram/${SAM_BOT}`,
          headers: { 'content-type': 'application/json', [SECRET_HEADER]: WEBHOOK_SECRET },
          ...(method === 'GET' ? {} : { payload: JSON.stringify(textUpdate(SAM_TG, 'via ' + method)) }),
        });
        expect(res.statusCode, method).not.toBe(200);
      }
    } finally {
      await server.close();
    }
    await w.app.settle();
    expect(await countEvents(w)).toBe(0);
  });

  it('webhook: a query string on the path does not bypass the secret, and with it the update is processed once', async () => {
    w = await createTelegramWorld();
    const u = textUpdate(SAM_TG, 'hello');
    const server = (await import('../../../src/server.js')).buildServer(w.app);
    try {
      const bad = await server.inject({
        method: 'POST',
        url: `/webhooks/telegram/${SAM_BOT}?${SECRET_HEADER}=${WEBHOOK_SECRET}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(u),
      });
      expect(bad.statusCode).toBe(401);
      for (let i = 0; i < 2; i += 1) {
        const good = await server.inject({
          method: 'POST',
          url: `/webhooks/telegram/${SAM_BOT}?x=1`,
          headers: { 'content-type': 'application/json', [SECRET_HEADER]: WEBHOOK_SECRET },
          payload: JSON.stringify(u),
        });
        expect(good.statusCode).toBe(200);
      }
    } finally {
      await server.close();
    }
    await w.app.settle();
    expect(await countEvents(w)).toBe(1);
    // Sam is preset as owner of Sam's bot; a plain text gets exactly one reply at most.
    expect(w.api.textsTo(SAM_TG).filter((t) => t === OWNER_TEXT.notSetUp).length).toBeLessThanOrEqual(1);
  });
});
