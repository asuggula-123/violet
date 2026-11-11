import type { LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { buildApp, type App } from '../../../src/app.js';
import { FakeClock } from '../../../src/clock.js';
import { parseConfig } from '../../../src/config.js';
import type { JobQueueOptions } from '../../../src/core/jobs.js';
import { createHousehold, createOwnerWithAgent, type SetupCtx } from '../../../src/core/setup.js';
import type { AgentRow } from '../../../src/core/types.js';
import type { Db } from '../../../src/db/db.js';
import { migrate } from '../../../src/db/migrate.js';
import { FakeCalendar, FakeGmail } from '../../../src/google/fake.js';
import { ScriptedLlm } from '../../../src/llm/scripted.js';
import { buildServer } from '../../../src/server.js';
import { SECRET_HEADER } from '../../../src/transport/telegram/routes.js';
import { parseBotTokens, TelegramTransport } from '../../../src/transport/telegram/transport.js';
import { openTestDb } from '../../helpers/world.js';
import { StubBotApi } from './stub.js';

/** Fake bot ids and tokens (format-valid, not real). */
export const ALEX_BOT = '7000000001';
export const SAM_BOT = '7000000002';
export const ALEX_TOKEN = `${ALEX_BOT}:AAalexFAKEtokenSECRETpart000000000001`;
export const SAM_TOKEN = `${SAM_BOT}:AAsamFAKEtokenSECRETpart0000000000002`;
/** The token secrets: the part after ":" must never leak. */
export const TOKEN_SECRETS = [ALEX_TOKEN, SAM_TOKEN].map((t) => t.split(':')[1]!);
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const ALEX_TG = '1101';
export const SAM_TG = '2202';

export interface TelegramWorld {
  app: App;
  db: Db;
  clock: FakeClock;
  api: StubBotApi;
  transport: TelegramTransport;
  setup: SetupCtx;
  /** Alex's agent is unpaired (pairing code below); Sam's owner is preset to SAM_TG. */
  alex: { agent: AgentRow; pairingCode: string };
  sam: { agent: AgentRow };
  logs: string[];
  responses: LightMyRequestResponse[];
  post(botId: string, update: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** Every place a secret could leak to: log lines, action log, job errors, stored events, HTTP bodies. */
  leakSurface(): Promise<string>;
  close(): Promise<void>;
}

export async function createTelegramWorld(
  opts: { mode?: 'webhook' | 'polling'; jobs?: JobQueueOptions; env?: Record<string, string> } = {},
): Promise<TelegramWorld> {
  const { db, cleanup } = await openTestDb();
  await migrate(db);
  const clock = new FakeClock();
  const api = new StubBotApi();
  const tokens = `${ALEX_TOKEN},${SAM_TOKEN}`;
  const transport = new TelegramTransport(parseBotTokens(tokens), api.fetch, clock);
  const config = parseConfig({
    NODE_ENV: 'test',
    TRANSPORT: 'telegram',
    TELEGRAM_BOT_TOKENS: tokens,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_MODE: opts.mode ?? 'webhook',
    ...opts.env,
  });
  const logs: string[] = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => void logs.push(line) });
  const app = await buildApp(
    { db, clock, transport, llm: new ScriptedLlm(), calendar: new FakeCalendar(), gmail: new FakeGmail(), config, log },
    [],
    opts.jobs ? { jobs: opts.jobs } : {},
  );
  const setup: SetupCtx = { repos: app.repos, actionLog: app.actionLog, clock };
  const household = await createHousehold(setup, 'Test household');
  const base = { householdId: household.id, timezone: 'America/New_York', transport: 'telegram' as const };
  const alex = await createOwnerWithAgent(setup, { ...base, name: 'Alex', agentAddress: ALEX_BOT });
  const sam = await createOwnerWithAgent(setup, { ...base, name: 'Sam', agentAddress: SAM_BOT, ownerAddress: SAM_TG });
  const server = buildServer(app);
  const responses: LightMyRequestResponse[] = [];

  return {
    app,
    db,
    clock,
    api,
    transport,
    setup,
    alex: { agent: alex.agent, pairingCode: alex.pairingCode! },
    sam: { agent: sam.agent },
    logs,
    responses,
    async post(botId, update, headers = { [SECRET_HEADER]: WEBHOOK_SECRET }) {
      const res = await server.inject({
        method: 'POST',
        url: `/webhooks/telegram/${botId}`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: typeof update === 'string' ? update : JSON.stringify(update),
      });
      responses.push(res);
      return res;
    },
    async leakSurface() {
      const actions = await app.actionLog.list();
      const jobs = await db.query<{ last_error: string | null }>('SELECT last_error FROM jobs');
      const events = await db.query<{ payload: unknown }>('SELECT payload FROM inbound_events');
      return [
        ...logs,
        JSON.stringify(actions),
        JSON.stringify(jobs.rows),
        JSON.stringify(events.rows),
        ...responses.map((r) => r.body),
      ].join('\n');
    },
    async close() {
      await server.close();
      await app.stop();
      await cleanup();
    },
  };
}

let nextUpdateId = 5000;

interface From {
  id: number;
  first_name?: string;
  is_bot?: boolean;
}

const fromOf = (id: string | number, extra: Partial<From> = {}): From => ({ id: Number(id), is_bot: false, first_name: 'Test', ...extra });

/** A private-chat text message update. */
export function textUpdate(fromId: string | number, text: string, extra: Record<string, unknown> = {}) {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: { message_id: nextUpdateId, date: 0, chat: { id: Number(fromId), type: 'private' }, from: fromOf(fromId), text, ...extra },
  };
}

/** A button press on message `chatId:messageId`. */
export function buttonUpdate(fromId: string | number, data: string, chatId: string | number, messageId: number) {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    callback_query: {
      id: `cbq-${nextUpdateId}`,
      from: fromOf(fromId),
      chat_instance: 'ci',
      data,
      message: { message_id: messageId, date: 0, chat: { id: Number(chatId), type: 'private' } },
    },
  };
}
