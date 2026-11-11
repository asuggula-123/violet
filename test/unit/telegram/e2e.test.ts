/** The real app with the Telegram transport, a stub Bot API and the webhook route. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../../src/core/canned.js';
import type { OwnerMessageCtx } from '../../../src/core/router.js';
import { tgError } from './stub.js';
import {
  ALEX_BOT,
  ALEX_TG,
  buttonUpdate,
  createTelegramWorld,
  SAM_BOT,
  SAM_TG,
  textUpdate,
  TOKEN_SECRETS,
  type TelegramWorld,
} from './world.js';

describe('Telegram end to end', () => {
  let w: TelegramWorld;
  beforeEach(async () => {
    w = await createTelegramWorld({ jobs: { backoffMs: () => 1_000, maxAttempts: 5 } });
  });
  afterEach(async () => w.close());

  async function deliver(botId: string, update: unknown): Promise<void> {
    expect((await w.post(botId, update)).statusCode).toBe(200);
    await w.app.settle();
  }

  async function jobs() {
    const res = await w.db.query<{ status: string; attempts: number; run_at: Date }>(
      `SELECT status, attempts, run_at FROM jobs WHERE type = 'inbound.process' ORDER BY seq`,
    );
    return res.rows;
  }

  it('owner pairs via "/start <code>" → paired ack via sendMessage, then is the owner', async () => {
    await deliver(ALEX_BOT, textUpdate(ALEX_TG, `/start ${w.alex.pairingCode}`));
    expect(w.api.textsTo(ALEX_TG)).toEqual([OWNER_TEXT.paired]);
    const [ack] = w.api.callsOf('sendMessage');
    expect(ack!.botId).toBe(ALEX_BOT);
    const agent = await w.app.repos.agents.get(w.alex.agent.id);
    expect(agent!.owner_address).toBe(ALEX_TG);
    const sent = await w.app.actionLog.list({ action: 'outbound.sent', agentId: w.alex.agent.id });
    expect(sent[0]!.detail).toMatchObject({ purpose: 'ack', transportMessageId: `${ALEX_TG}:101` });

    await deliver(ALEX_BOT, textUpdate(ALEX_TG, 'hello'));
    expect(w.api.textsTo(ALEX_TG).at(-1)).toBe(OWNER_TEXT.notSetUp);
  });

  it('a wrong code is a stranger: canned reply, no binding', async () => {
    await deliver(ALEX_BOT, textUpdate(ALEX_TG, '/start WRONGCODE2'));
    expect(w.api.textsTo(ALEX_TG)).toEqual([CANNED.stranger_reply]);
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.owner_address).toBeNull();
  });

  it('stranger message → canned reply; owner stays private', async () => {
    await deliver(SAM_BOT, textUpdate('3303', 'who owns this bot?'));
    expect(w.api.textsTo('3303')).toEqual([CANNED.stranger_reply]);
    expect(w.api.textsTo(SAM_TG)).toEqual([]);
  });

  it('the same update delivered twice (same update_id) is processed once', async () => {
    const update = textUpdate(SAM_TG, 'hi');
    await deliver(SAM_BOT, update);
    await deliver(SAM_BOT, update);
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.notSetUp]);
    expect(await w.app.actionLog.list({ action: 'inbound.duplicate' })).toHaveLength(1);
    const rows = await w.db.query<{ id: string }>('SELECT transport_message_id AS id FROM inbound_events');
    expect(rows.rows).toEqual([{ id: `${SAM_BOT}:${update.update_id}` }]);
  });

  it("the owner's button press reaches the interceptors with payload and the prompt it answers", async () => {
    const seen: OwnerMessageCtx[] = [];
    w.app.router.hooks.ownerInterceptors.push(async (ctx) => {
      seen.push(ctx);
      return true;
    });
    const prompt = await w.app.gateway.sendToOwner(w.sam.agent.id, '#1 Book it?', {
      purpose: 'approval',
      buttons: [{ id: 'approve:a1', label: 'Yes' }],
    });
    const [chatId, messageId] = prompt!.transportMessageId.split(':');
    await deliver(SAM_BOT, buttonUpdate(SAM_TG, 'approve:a1', chatId!, Number(messageId)));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.msg).toMatchObject({
      kind: 'button',
      buttonPayload: 'approve:a1',
      fromAddress: SAM_TG,
      replyToTransportMessageId: prompt!.transportMessageId,
    });
    await vi.waitFor(() => expect(w.api.callsOf('answerCallbackQuery')).toHaveLength(1));
    expect(w.api.callsOf('answerCallbackQuery')[0]!.params).toEqual({ callback_query_id: expect.stringMatching(/^cbq-/) });
  });

  it("a button press from a non-owner is not treated as the owner's (I1)", async () => {
    const seen: OwnerMessageCtx[] = [];
    w.app.router.hooks.ownerInterceptors.push(async (ctx) => {
      seen.push(ctx);
      return true;
    });
    // The pressing user differs from the owner, even on a message in the owner's chat.
    await deliver(SAM_BOT, buttonUpdate('3303', 'approve:a1', SAM_TG, 101));
    expect(seen).toEqual([]);
    const contacts = await w.db.query<{ address: string; kind: string }>('SELECT address, kind FROM contacts WHERE agent_id = $1', [w.sam.agent.id]);
    expect(contacts.rows).toEqual([{ address: '3303', kind: 'stranger' }]);
    expect(w.api.textsTo(SAM_TG)).toEqual([]);
  });

  it('a forwarded "yes" or inline-bot text from the owner never reaches the interceptors or the Brain', async () => {
    const seen: OwnerMessageCtx[] = [];
    w.app.router.hooks.ownerInterceptors.push(async (ctx) => {
      seen.push(ctx);
      return true;
    });
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'yes', { forward_origin: { type: 'user', date: 0, sender_user: { id: 3303, is_bot: false, first_name: 'Alex' } } }));
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'approve all', { via_bot: { id: 9009, is_bot: true, first_name: 'Inline' } }));
    expect(seen).toEqual([]);
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.textOnly, OWNER_TEXT.textOnly]);
    const stored = await w.db.query<{ body: string }>(`SELECT body FROM messages WHERE direction = 'in'`);
    expect(stored.rows.map((r) => r.body)).toEqual(['', '']);
  });

  it('a group message is ignored and the bot leaves the group; both are in action_log (I15)', async () => {
    const update = textUpdate(SAM_TG, 'hello group', { chat: { id: -100555, type: 'supergroup' } });
    await deliver(SAM_BOT, update);
    expect(await jobs()).toEqual([]);
    await vi.waitFor(() => expect(w.api.callsOf('leaveChat')).toHaveLength(1));
    expect(w.api.callsOf('leaveChat')[0]).toMatchObject({ botId: SAM_BOT, params: { chat_id: -100555 } });
    expect(w.api.callsOf('sendMessage')).toEqual([]);
    const dropped = await w.app.actionLog.list({ action: 'inbound.dropped' });
    expect(dropped.map((r) => r.detail)).toEqual([
      { transport: 'telegram', botId: SAM_BOT, updateId: update.update_id, reason: 'not_private', chatId: -100555 },
    ]);
    await vi.waitFor(async () =>
      expect((await w.app.actionLog.list({ action: 'telegram.chat_left' })).map((r) => r.detail)).toEqual([{ botId: SAM_BOT, chatId: -100555 }]),
    );
    expect(dropped[0]!.agent_id).toBe(w.sam.agent.id);
  });

  it('a bot sender is ignored (and logged as dropped)', async () => {
    await deliver(SAM_BOT, textUpdate('4404', 'beep', { from: { id: 4404, is_bot: true, first_name: 'Bot' } }));
    expect(await jobs()).toEqual([]);
    expect(w.api.calls).toEqual([]);
    const dropped = await w.app.actionLog.list({ action: 'inbound.dropped' });
    expect(dropped.map((r) => r.detail)).toEqual([expect.objectContaining({ transport: 'telegram', reason: 'bot_sender' })]);
  });

  it('a blocked owner chat: the resume ack fails permanently but the resume hooks still run', async () => {
    let resumed = 0;
    w.app.router.hooks.onResume.push(async () => {
      resumed += 1;
    });
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'pause'));
    w.api.failAlways('sendMessage', tgError(403, 'Forbidden: bot was blocked by the user'));
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'resume'));
    expect((await w.app.repos.agents.get(w.sam.agent.id))!.paused).toBe(false);
    expect(resumed).toBe(1);
    expect((await jobs()).map((j) => j.status)).toEqual(['done', 'done']);
    expect(await w.app.actionLog.list({ action: 'outbound.failed' })).toHaveLength(1);
  });

  it('a retryable error on the pause ack still retries the ack', async () => {
    w.api.failNext('sendMessage', tgError(502, 'Bad Gateway'));
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'pause'));
    expect((await jobs())[0]).toMatchObject({ status: 'failed', attempts: 1 });
    w.clock.advance({ seconds: 2 });
    await w.app.settle();
    // The stub records the failed call too: one failed attempt, one delivered ack.
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.paused]);
    expect((await jobs())[0]).toMatchObject({ status: 'done', attempts: 2 });
    expect((await w.app.repos.agents.get(w.sam.agent.id))!.paused).toBe(true);
  });

  it('unsupported media from the owner → "I can only read text for now."', async () => {
    const update = textUpdate(SAM_TG, 'x');
    const { text: _drop, ...message } = update.message;
    await deliver(SAM_BOT, { ...update, message: { ...message, photo: [{ file_id: 'p' }] } });
    expect(w.api.textsTo(SAM_TG)).toEqual([OWNER_TEXT.textOnly]);
  });

  it('403 (bot blocked) is permanent: one attempt, outbound.failed logged, no retry storm, lane not wedged', async () => {
    w.api.failAlways('sendMessage', tgError(403, 'Forbidden: bot was blocked by the user'));
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'hi'));
    for (let i = 0; i < 5; i += 1) {
      w.clock.advance({ hours: 1 });
      await w.app.settle();
    }
    expect(w.api.callsOf('sendMessage')).toHaveLength(1);
    expect(await jobs()).toEqual([expect.objectContaining({ status: 'dead', attempts: 1 })]);
    const failed = await w.app.actionLog.list({ action: 'outbound.failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toMatchObject({ purpose: 'reply', permanent: true, reason: 'forbidden', error: expect.stringMatching(/403 Forbidden: bot was blocked/) });
    expect((await w.app.actionLog.list({ action: 'job.dead' }))[0]!.detail).toMatchObject({ permanent: true });

    // The owner unblocks the bot: their next message is handled at once.
    w.api.failAlways('sendMessage', null);
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'back'));
    expect(w.api.textsTo(SAM_TG).at(-1)).toBe(OWNER_TEXT.notSetUp);
  });

  it('429 is retryable and the retry waits for retry_after', async () => {
    w.api.failNext('sendMessage', tgError(429, 'Too Many Requests: retry after 120', { parameters: { retry_after: 120 } }));
    const start = w.clock.now().getTime();
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'hi'));
    const [job] = await jobs();
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job!.run_at.getTime() - start).toBe(120_000);
    const failed = await w.app.actionLog.list({ action: 'outbound.failed' });
    expect(failed[0]!.detail).toMatchObject({ permanent: false, reason: 'rate_limited', retryAfterMs: 120_000 });

    w.clock.advance({ seconds: 60 });
    await w.app.settle();
    expect(w.api.callsOf('sendMessage')).toHaveLength(1);
    w.clock.advance({ seconds: 61 });
    await w.app.settle();
    expect(w.api.callsOf('sendMessage')).toHaveLength(2);
    expect(w.api.textsTo(SAM_TG).at(-1)).toBe(OWNER_TEXT.notSetUp);
    expect((await jobs())[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('5xx and network errors keep the normal retries', async () => {
    w.api.failNext('sendMessage', tgError(502, 'Bad Gateway'));
    w.api.failNext('sendMessage', 'network');
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'hi'));
    w.clock.advance({ seconds: 2 });
    await w.app.settle();
    w.clock.advance({ seconds: 2 });
    await w.app.settle();
    expect(w.api.callsOf('sendMessage')).toHaveLength(3);
    expect((await jobs())[0]).toMatchObject({ status: 'done', attempts: 3 });
  });

  it('the bot token never appears in logs, action_log, job errors, stored events or HTTP responses', async () => {
    await deliver(ALEX_BOT, textUpdate(ALEX_TG, `/start ${w.alex.pairingCode}`));
    await deliver(SAM_BOT, textUpdate('3303', 'hello'));
    w.api.failNext('sendMessage', 'network');
    w.api.failNext('sendMessage', tgError(429, 'Too Many Requests', { parameters: { retry_after: 1 } }));
    w.api.failNext('sendMessage', tgError(500, 'Internal Server Error'));
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'one'));
    for (let i = 0; i < 4; i += 1) {
      w.clock.advance({ seconds: 5 });
      await w.app.settle();
    }
    w.api.failAlways('sendMessage', tgError(403, 'Forbidden: bot was blocked by the user'));
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'two'));
    w.api.failAlways('sendMessage', null);
    w.api.failAlways('leaveChat', 'network');
    w.api.failAlways('answerCallbackQuery', 'network');
    await deliver(SAM_BOT, textUpdate(SAM_TG, 'group', { chat: { id: -1, type: 'group' } }));
    await deliver(SAM_BOT, buttonUpdate(SAM_TG, 'deny:x', SAM_TG, 101));
    await w.post(SAM_BOT, '{bad', {});
    await w.post(SAM_BOT, '{bad');
    await w.post('42', textUpdate(SAM_TG, 'x'));
    await vi.waitFor(() => expect(w.logs.join('\n')).toMatch(/follow-up call failed[\s\S]*follow-up call failed/));

    const errors: string[] = [];
    for (const send of [
      () => w.transport.send({ agentAddress: SAM_BOT, toAddress: SAM_TG, text: 'x', purpose: 'reply', buttons: [{ id: 'y'.repeat(65), label: 'z' }] }),
      () => w.transport.send({ agentAddress: '1', toAddress: SAM_TG, text: 'x', purpose: 'reply' }),
    ]) {
      await send().catch((e: Error) => errors.push(`${e.message}\n${e.stack}`));
    }
    expect(errors).toHaveLength(2);

    const surface = `${await w.leakSurface()}\n${errors.join('\n')}`;
    expect(surface).toMatch(/outbound send failed/);
    expect(surface).toMatch(/network error/);
    for (const secret of TOKEN_SECRETS) expect(surface).not.toContain(secret);
    expect(surface).not.toContain('api.telegram.org');
  });
});
