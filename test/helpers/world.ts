import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pino from 'pino';
import { buildApp, type App, type Module } from '../../src/app.js';
import { FakeClock, type Duration } from '../../src/clock.js';
import { parseConfig } from '../../src/config.js';
import type { ActionFilter, ActionRow } from '../../src/core/actionLog.js';
import type { JobQueueOptions } from '../../src/core/jobs.js';
import { createHousehold, createOwnerWithAgent, type SetupCtx } from '../../src/core/setup.js';
import type { AgentRow, HouseholdRow, OwnerRow } from '../../src/core/types.js';
import { PgDb, PgliteDb, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { FakeCalendar, FakeGmail } from '../../src/google/fake.js';
import { ScriptedLlm } from '../../src/llm/scripted.js';
import { FakeTransport } from '../../src/transport/fake.js';
import type { InboundMessage } from '../../src/transport/types.js';

export interface Persona {
  owner: OwnerRow;
  agent: AgentRow;
  /** The owner's own address on the transport. */
  address: string;
  /** The agent's address (where the owner writes to). */
  agentAddress: string;
}

export interface SayOptions {
  fromName?: string;
  kind?: InboundMessage['kind'];
  buttonPayload?: string;
  transportMessageId?: string;
  replyToTransportMessageId?: string;
}

export interface WorldOptions {
  modules?: Module[];
  jobs?: JobQueueOptions;
  start?: Date | string;
}

export interface TestWorld {
  app: App;
  db: Db;
  clock: FakeClock;
  transport: FakeTransport;
  llm: ScriptedLlm;
  calendar: FakeCalendar;
  gmail: FakeGmail;
  household: HouseholdRow;
  alex: Persona;
  sam: Persona;
  setup: SetupCtx;
  /** Ingest one inbound message (no settle). */
  inbound(msg: Partial<InboundMessage> & Pick<InboundMessage, 'agentAddress' | 'fromAddress' | 'text'>): Promise<void>;
  ownerSays(p: Persona, text: string, opts?: SayOptions): Promise<void>;
  strangerSays(p: Persona, fromAddress: string, text: string, opts?: SayOptions): Promise<void>;
  textsTo(address: string): string[];
  lastTo(address: string): string | undefined;
  advance(by: Duration): Promise<void>;
  actions(filter?: ActionFilter): Promise<ActionRow[]>;
  close(): Promise<void>;
}

let pgliteTemplate: Promise<Blob | File> | null = null;

/** initdb is the slow part of PGlite start-up, so each worker does it once and loads copies. */
async function freshPglite(): Promise<PgliteDb> {
  pgliteTemplate ??= PGlite.create().then(async (pg) => {
    const dump = await pg.dumpDataDir('none');
    await pg.close();
    return dump;
  });
  return new PgliteDb(await PGlite.create({ loadDataDir: await pgliteTemplate }));
}

/** An empty database: PGlite in memory, or a fresh schema in TEST_DATABASE_URL. */
export async function openTestDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const db = await freshPglite();
    return { db, cleanup: () => db.close() };
  }
  const schema = `w_${randomBytes(6).toString('hex')}`;
  const admin = new PgDb({ connectionString: url, max: 1 });
  await admin.exec(`CREATE SCHEMA ${schema}`);
  const db = new PgDb({ connectionString: url, schema, max: 4 });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}

export async function createTestWorld(opts: WorldOptions = {}): Promise<TestWorld> {
  const { db, cleanup } = await openTestDb();
  await migrate(db);
  const clock = new FakeClock(opts.start);
  const transport = new FakeTransport();
  const llm = new ScriptedLlm();
  const calendar = new FakeCalendar();
  const gmail = new FakeGmail();
  const config = parseConfig({ NODE_ENV: 'test', TRANSPORT: 'fake' });
  const log = pino({ level: 'silent' });
  const app = await buildApp(
    { db, clock, transport, llm, calendar, gmail, config, log },
    opts.modules ?? [],
    opts.jobs ? { jobs: opts.jobs } : {},
  );
  const setup: SetupCtx = { repos: app.repos, actionLog: app.actionLog, clock };
  const household = await createHousehold(setup, 'Test household');

  async function persona(name: string, address: string, agentAddress: string): Promise<Persona> {
    const { owner, agent } = await createOwnerWithAgent(setup, {
      householdId: household.id,
      name,
      timezone: 'America/New_York',
      transport: 'fake',
      agentAddress,
      ownerAddress: address,
    });
    return { owner, agent, address, agentAddress };
  }

  const alex = await persona('Alex', 'alex-phone', 'violet-alex');
  const sam = await persona('Sam', 'sam-phone', 'violet-sam');
  let counter = 0;

  const world: TestWorld = {
    app,
    db,
    clock,
    transport,
    llm,
    calendar,
    gmail,
    household,
    alex,
    sam,
    setup,

    async inbound(msg) {
      counter += 1;
      await app.ingest({
        transport: 'fake',
        kind: 'text',
        transportMessageId: `in-${counter}`,
        receivedAt: clock.now(),
        ...msg,
      });
    },

    async ownerSays(p, text, o = {}) {
      await world.inbound({ agentAddress: p.agentAddress, fromAddress: p.address, text, ...o });
      await app.settle();
    },

    async strangerSays(p, fromAddress, text, o = {}) {
      await world.inbound({ agentAddress: p.agentAddress, fromAddress, text, ...o });
      await app.settle();
    },

    textsTo: (address) => transport.textsTo(address),
    lastTo: (address) => transport.textsTo(address).at(-1),

    async advance(by) {
      clock.advance(by);
      await app.scheduler.runDue();
      await app.settle();
    },

    actions: (filter) => app.actionLog.list(filter),

    async close() {
      await app.stop();
      await cleanup();
    },
  };
  return world;
}
