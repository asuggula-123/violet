import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretMatches, SECRET_HEADER } from '../../../src/transport/telegram/routes.js';
import { ALEX_BOT, createTelegramWorld, SAM_TG, textUpdate, WEBHOOK_SECRET, type TelegramWorld } from './world.js';

describe('Telegram webhook auth (I18)', () => {
  let w: TelegramWorld;
  beforeEach(async () => {
    w = await createTelegramWorld();
  });
  afterEach(async () => w.close());

  async function stored(): Promise<number> {
    const res = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_events');
    return res.rows[0]!.n;
  }

  it('accepts the right secret and ingests', async () => {
    const res = await w.post(ALEX_BOT, textUpdate(SAM_TG, 'hello'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await stored()).toBe(1);
  });

  it.each([
    ['missing', {}],
    ['wrong', { [SECRET_HEADER]: 'wrong-secret-0123456789' }],
    ['a prefix of the right one', { [SECRET_HEADER]: WEBHOOK_SECRET.slice(0, -1) }],
    ['empty', { [SECRET_HEADER]: '' }],
  ])('%s secret → 401, nothing ingested, nothing echoed', async (_name, headers) => {
    const update = textUpdate(SAM_TG, 'pause');
    const res = await w.post(ALEX_BOT, update, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('{"ok":false}');
    expect(await stored()).toBe(0);
    await w.app.settle();
    expect(w.api.calls).toEqual([]);
  });

  it('wrong secret with a malformed body is still a 401 (auth before parsing)', async () => {
    const res = await w.post(ALEX_BOT, '{not json', { [SECRET_HEADER]: 'nope' });
    expect(res.statusCode).toBe(401);
  });

  it('unknown bot → 404 (after auth), nothing ingested', async () => {
    const res = await w.post('123456', textUpdate(SAM_TG, 'hi'));
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('{"ok":false}');
    expect((await w.post('123456', textUpdate(SAM_TG, 'hi'), {})).statusCode).toBe(401);
    expect(await stored()).toBe(0);
  });

  it.each([
    ['not JSON', '{"update_id": 1, "message": '],
    ['no update_id', JSON.stringify({ message: { text: 'secret stuff' } })],
    ['bad types', JSON.stringify({ update_id: 'one', message: { text: 'secret stuff' } })],
    ['JSON null', 'null'],
    ['empty', ''],
  ])('malformed body (%s) → 400 without echoing it', async (_name, body) => {
    const res = await w.post(ALEX_BOT, body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('{"ok":false}');
    expect(await stored()).toBe(0);
  });

  it('a non-JSON content type is parsed the same way (no 415 leak of parser details)', async () => {
    const res = await w.post(ALEX_BOT, 'hello', { [SECRET_HEADER]: WEBHOOK_SECRET, 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('{"ok":false}');
  });

  it('an ingest failure → 500 with no detail, so Telegram redelivers', async () => {
    const real = w.app.ingest;
    w.app.ingest = async () => {
      throw new Error('db down: secret stuff');
    };
    const res = await w.post(ALEX_BOT, textUpdate(SAM_TG, 'secret stuff'));
    w.app.ingest = real;
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('{"ok":false}');
  });

  it('the route does not exist without the Telegram transport', async () => {
    const { buildServer } = await import('../../../src/server.js');
    const { FakeTransport } = await import('../../../src/transport/fake.js');
    const server = buildServer({ ...w.app, deps: { ...w.app.deps, transport: new FakeTransport() } });
    const res = await server.inject({ method: 'POST', url: `/webhooks/telegram/${ALEX_BOT}`, headers: { [SECRET_HEADER]: WEBHOOK_SECRET }, payload: {} });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('secretMatches is exact', () => {
    expect(secretMatches(WEBHOOK_SECRET, WEBHOOK_SECRET)).toBe(true);
    expect(secretMatches(`${WEBHOOK_SECRET} `, WEBHOOK_SECRET)).toBe(false);
    expect(secretMatches(undefined, WEBHOOK_SECRET)).toBe(false);
    expect(secretMatches([WEBHOOK_SECRET], WEBHOOK_SECRET)).toBe(false);
  });
});
