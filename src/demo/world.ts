import pino from 'pino';
import { buildApp, type App } from '../app.js';
import { FakeClock } from '../clock.js';
import { parseConfig } from '../config.js';
import { createHousehold, createOwnerWithAgent } from '../core/setup.js';
import { PgliteDb } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { FakeCalendar, FakeGmail } from '../google/fake.js';
import { defaultModules } from '../modules.js';
import { FakeTransport } from '../transport/fake.js';
import type { DemoModel } from './model.js';
import { seedWeek, START, ZONE } from './seed.js';

export interface DemoPerson {
  name: string;
  ownerId: string;
  agentId: string;
  /** The owner's phone (their address on the transport). */
  phone: string;
  /** Their Violet's address. */
  violet: string;
}

export interface DemoWorld {
  app: App;
  clock: FakeClock;
  transport: FakeTransport;
  calendar: FakeCalendar;
  gmail: FakeGmail;
  model: DemoModel;
  alex: DemoPerson;
  sam: DemoPerson;
  close(): Promise<void>;
}

/**
 * The whole app in this process: real modules (router, approvals, Brain, a2a, flags), with
 * only the edges replaced — Postgres in memory (PGlite, no files), the fake transport,
 * in-memory Google, the demo model and a clock the story moves.
 */
export async function createDemoWorld(model: DemoModel): Promise<DemoWorld> {
  const db = await PgliteDb.open();
  await migrate(db);
  const clock = new FakeClock(START);
  const transport = new FakeTransport();
  const calendar = new FakeCalendar();
  const gmail = new FakeGmail();
  const config = parseConfig({ NODE_ENV: 'development', TRANSPORT: 'fake' });
  const app = await buildApp({ db, clock, transport, llm: model, calendar, gmail, config, log: pino({ level: 'silent' }) }, defaultModules);
  const setup = { repos: app.repos, actionLog: app.actionLog, clock };
  const household = await createHousehold(setup, 'Demo household');

  async function person(name: string, key: string): Promise<DemoPerson> {
    const phone = `${key}-phone`;
    const violet = `violet-${key}`;
    const { owner, agent } = await createOwnerWithAgent(setup, { householdId: household.id, name, timezone: ZONE, transport: 'fake', agentAddress: violet, ownerAddress: phone });
    return { name, ownerId: owner.id, agentId: agent.id, phone, violet };
  }
  const alex = await person('Alex', 'alex');
  const sam = await person('Sam', 'sam');
  model.setCast({ alex: alex.agentId, sam: sam.agentId });
  seedWeek(calendar, gmail, { alex: alex.ownerId, sam: sam.ownerId });

  return {
    app,
    clock,
    transport,
    calendar,
    gmail,
    model,
    alex,
    sam,
    async close() {
      await app.stop();
      await db.close();
    },
  };
}
