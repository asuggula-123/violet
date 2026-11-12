/**
 * R3 ('Calendar write only after owner approval'): a real person is never told "Booked" on a
 * stand-in calendar. With a transport that reaches real people (Telegram) and Google not
 * configured, the providers fail every call whatever NODE_ENV is; the in-memory fakes are only
 * for the fake transport outside production.
 */
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import { parseConfig } from '../../../src/config.js';
import { FakeCalendar, FakeGmail } from '../../../src/google/fake.js';
import { createGoogleProviders } from '../../../src/google/providers.js';
import { NOT_CONFIGURED_REASON, UnconfiguredCalendar, UnconfiguredGmail } from '../../../src/google/unconfigured.js';
import { defaultModules } from '../../../src/modules.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { scriptBrain, toolUse } from '../brain/script.js';

const TELEGRAM = { TRANSPORT: 'telegram', TELEGRAM_MODE: 'polling', TELEGRAM_BOT_TOKENS: '123456789:placeholder_placeholder_placeholder_x' };
const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };

let w: TestWorld | undefined;
let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  await w?.close();
  app = undefined;
  w = undefined;
});

const silent = pino({ level: 'silent' });

describe('R3: which Google providers are used when', () => {
  it('Telegram without Google: failing providers in development, test and production', async () => {
    w = await createTestWorld({ modules: [] });
    for (const NODE_ENV of ['development', 'test', 'production']) {
      const p = createGoogleProviders({ config: parseConfig({ ...TELEGRAM, NODE_ENV }), db: w.db, clock: w.clock, log: silent });
      expect(p.calendar, NODE_ENV).toBeInstanceOf(UnconfiguredCalendar);
      expect(p.gmail, NODE_ENV).toBeInstanceOf(UnconfiguredGmail);
    }
  });

  it('the fake transport keeps the in-memory fakes outside production (tests, the demo, local dev without bots)', async () => {
    w = await createTestWorld({ modules: [] });
    for (const NODE_ENV of ['development', 'test']) {
      const p = createGoogleProviders({ config: parseConfig({ TRANSPORT: 'fake', NODE_ENV }), db: w.db, clock: w.clock, log: silent });
      expect(p.calendar).toBeInstanceOf(FakeCalendar);
      expect(p.gmail).toBeInstanceOf(FakeGmail);
    }
    const prod = createGoogleProviders({ config: parseConfig({ TRANSPORT: 'fake', NODE_ENV: 'production' }), db: w.db, clock: w.clock, log: silent });
    expect(prod.calendar).toBeInstanceOf(UnconfiguredCalendar);
  });

  for (const NODE_ENV of ['development', 'production']) {
    it(`Telegram, ${NODE_ENV}, no Google: an approved booking says Google is not connected and nothing is recorded as booked`, async () => {
      w = await createTestWorld();
      const world = w;
      const providers = createGoogleProviders({ config: parseConfig({ ...TELEGRAM, NODE_ENV }), db: world.db, clock: world.clock, log: silent });
      app = await buildApp({ ...world.app.deps, ...providers, log: silent }, defaultModules);
      const say = async (text: string, n: number) => {
        await app!.ingest({ transport: 'fake', kind: 'text', agentAddress: world.alex.agentAddress, fromAddress: world.alex.address, text, transportMessageId: `r3-${n}`, receivedAt: world.clock.now() });
        await app!.settle();
      };
      scriptBrain(world, world.alex, [[toolUse('c', 'request_calendar_event', DINNER)], 'Asked.']);
      await say('book dinner friday', 1);
      await say('yes', 2);
      expect(world.textsTo(world.alex.address).at(-1)).toBe(`I couldn't book #1: ${NOT_CONFIGURED_REASON}.`);
      expect(world.textsTo(world.alex.address).some((t) => /^Booked/.test(t))).toBe(false);
      expect(await world.actions({ action: 'calendar.event_created' })).toEqual([]);
      expect((await world.db.query(`SELECT 1 FROM calendar_writes WHERE deleted_at IS NULL`)).rowCount).toBe(0);
      expect((await world.db.query<{ status: string }>('SELECT status FROM approvals')).rows).toEqual([{ status: 'failed' }]);
      expect((await world.app.repos.flags.listByAgent(world.alex.agent.id)).filter((f) => f.kind === 'booked')).toEqual([]);
    });
  }
});
