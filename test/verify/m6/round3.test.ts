/**
 * Independent verifier, M6 round 3. Re-checks the round-2 fixes end to end, through the
 * real job queue and app, rather than with hand-made runInJob wrappers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../src/clock.js';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { parseConfig } from '../../../src/config.js';
import { createTelegramPoller } from '../../../src/transport/telegram/poller.js';
import { PARTIAL_SEND_TTL_MS, parseBotTokens, TelegramTransport, telegramTransportFromConfig } from '../../../src/transport/telegram/transport.js';
import { tgError } from '../../unit/telegram/stub.js';
import { buttonUpdate, createTelegramWorld, SAM_BOT, SAM_TG, SAM_TOKEN, textUpdate, type TelegramWorld } from '../../unit/telegram/world.js';

let w: TelegramWorld | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.close();
  w = undefined;
});

const A = 'A'.repeat(4000);
const B = 'B'.repeat(4000);
const C = 'C'.repeat(4000);
const LONG = [A, B, C].join('\n\n');
/** Short form of delivered texts: first char + length, so failures stay readable. */
const short = (xs: string[]) => xs.map((x) => (x.length === 4000 ? x[0]! : x));

describe('verify M6 round 3: job-scoped resume through the real job queue', () => {
  it('a 429 on chunk 2 inside a real job: the retry delivers B and C once, A is never repeated, nothing lost', async () => {
    w = await createTelegramWorld({ jobs: { backoffMs: () => 1_000 } });
    const world = w;
    world.app.jobs.register('verify.long', async (p: { agentId: string }) => {
      await world.app.gateway.sendToOwner(p.agentId, LONG, { purpose: 'reply' });
    });
    await world.app.jobs.enqueue('verify.long', { agentId: world.sam.agent.id }, { lane: world.sam.agent.id });
    // first sendMessage (A) ok, second (B) 429
    world.api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 900, chat: { id: Number(SAM_TG), type: 'private' }, text: A } } });
    world.api.failNext('sendMessage', tgError(429, 'Too Many Requests: retry after 2', { parameters: { retry_after: 2 } }));
    await world.app.settle();
    expect(world.api.callsOf('sendMessage').length).toBe(2);
    // not retried before retry_after
    world.clock.advance(1_500);
    await world.app.settle();
    expect(world.api.callsOf('sendMessage').length).toBe(2);
    world.clock.advance(1_000);
    await world.app.settle();
    expect(short(world.api.textsTo(SAM_TG))).toEqual(short([A, B, B, C])); // calls: A ok, B 429 (recorded attempt), retry B, C — A never repeated
    const sent = await world.app.actionLog.list({ action: 'outbound.sent' });
    expect(sent).toHaveLength(1);
  });

  it('two different jobs with the same long text each deliver the full message even when the first was abandoned partway', async () => {
    w = await createTelegramWorld({ jobs: { maxAttempts: 1 } });
    const world = w;
    world.app.jobs.register('verify.long', async (p: { agentId: string }) => {
      await world.app.gateway.sendToOwner(p.agentId, LONG, { purpose: 'reply' });
    });
    world.api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 900, chat: { id: Number(SAM_TG), type: 'private' }, text: A } } });
    world.api.failNext('sendMessage', tgError(500, 'Internal Server Error'));
    await world.app.jobs.enqueue('verify.long', { agentId: world.sam.agent.id }, { lane: world.sam.agent.id });
    await world.app.settle();
    const dead = await world.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'verify.long'`);
    expect(dead.rows.map((r) => r.status)).toEqual(['dead']);
    await world.app.jobs.enqueue('verify.long', { agentId: world.sam.agent.id }, { lane: world.sam.agent.id });
    await world.app.settle();
    expect(short(world.api.textsTo(SAM_TG))).toEqual(short([A, B, A, B, C])); // calls: job-1 A ok, B 500 (dead); job-2 full message
  });

  it('a 403 partway through a multi-chunk send kills the job at once, logs outbound.failed, and the lane moves on', async () => {
    w = await createTelegramWorld();
    const world = w;
    world.app.jobs.register('verify.long', async (p: { agentId: string }) => {
      await world.app.gateway.sendToOwner(p.agentId, LONG, { purpose: 'reply' });
    });
    world.api.failNext('sendMessage', { status: 200, body: { ok: true, result: { message_id: 900, chat: { id: Number(SAM_TG), type: 'private' }, text: A } } });
    world.api.failNext('sendMessage', tgError(403, 'Forbidden: bot was blocked by the user'));
    await world.app.jobs.enqueue('verify.long', { agentId: world.sam.agent.id }, { lane: world.sam.agent.id });
    await world.app.ingest({
      transport: 'telegram',
      agentAddress: SAM_BOT,
      fromAddress: SAM_TG,
      kind: 'text',
      text: 'hello',
      transportMessageId: `${SAM_BOT}:777001`,
      receivedAt: world.clock.now(),
    });
    await world.app.settle();
    const jobs = await world.db.query<{ type: string; status: string; attempts: number }>(`SELECT type, status, attempts FROM jobs ORDER BY created_at`);
    const long = jobs.rows.find((r) => r.type === 'verify.long')!;
    expect(long).toMatchObject({ status: 'dead', attempts: 1 });
    expect(jobs.rows.filter((r) => r.type !== 'verify.long').every((r) => r.status === 'done')).toBe(true);
    expect(await world.app.actionLog.list({ action: 'outbound.failed' })).toHaveLength(1);
    expect(short(world.api.textsTo(SAM_TG))).toEqual(short([A, B, OWNER_TEXT.notSetUp])); // calls: A ok, B 403 (no retry), then the next job of the lane
  });

  it('the partial-send record expires on the injected clock, not wall time', async () => {
    let calls = 0;
    const delivered: string[] = [];
    const clock = new FakeClock();
    const t = new TelegramTransport(parseBotTokens(SAM_TOKEN), async (_u, init) => {
      calls += 1;
      const p = JSON.parse(String(init.body)) as { text: string };
      if (calls === 2) return new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), { status: 502 });
      delivered.push(p.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls, chat: { id: 1, type: 'private' } } }), { status: 200 });
    }, clock);
    const { runInJob } = await import('../../../src/core/jobContext.js');
    const msg = { agentAddress: SAM_BOT, toAddress: SAM_TG, text: LONG, purpose: 'reply' as const };
    await expect(runInJob('j', () => t.send(msg))).rejects.toThrow();
    clock.advance(PARTIAL_SEND_TTL_MS + 1);
    await runInJob('j', () => t.send(msg));
    expect(short(delivered)).toEqual(short([A, A, B, C]));
  });

  it('production wiring with a SystemClock-like clock never touches Date.now during sends', async () => {
    const config = parseConfig({ NODE_ENV: 'test', TRANSPORT: 'telegram', TELEGRAM_BOT_TOKENS: SAM_TOKEN, TELEGRAM_MODE: 'polling' });
    const spy = vi.spyOn(Date, 'now');
    const t = telegramTransportFromConfig(config, new FakeClock(), async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1, type: 'private' } } }), { status: 200 }),
    );
    await t.send({ agentAddress: SAM_BOT, toAddress: SAM_TG, text: LONG, purpose: 'reply' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('verify M6 round 3: unstorable strings from untrusted senders', () => {
  it('NUL / lone surrogates in text, names and button data never 500 the webhook, and the update is stored once', async () => {
    w = await createTelegramWorld();
    const updates = [
      textUpdate('3303', 'x\u0000y', { from: { id: 3303, is_bot: false, first_name: '\u0000', last_name: 'S\uD800am' } }),
      textUpdate('3304', 'lone \uDC00 low'),
      textUpdate('3305', '\uD83D'),
      buttonUpdate(SAM_TG, 'b\u0000\uD800', SAM_TG, 123),
    ];
    for (const u of updates) {
      const res = await w.post(SAM_BOT, u);
      expect(res.statusCode).toBe(200);
      const again = await w.post(SAM_BOT, u);
      expect(again.statusCode).toBe(200);
    }
    await w.app.settle();
    const ev = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_events');
    expect(ev.rows[0]!.n).toBe(updates.length);
    expect(w.logs.join('\n')).not.toMatch(/telegram webhook failed/);
  });

  it('polling: an update with NUL and lone surrogates does not stall the offset; later updates arrive', async () => {
    w = await createTelegramWorld({ mode: 'polling' });
    w.api.queueUpdates(SAM_BOT, [textUpdate('3303', 'a\u0000\uDFFF'), textUpdate(SAM_TG, 'hello')]);
    const poller = createTelegramPoller(w.app, w.transport, { timeoutSec: 0 });
    await poller.pollOnce(SAM_BOT);
    await w.app.settle();
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp]);
  });
});
