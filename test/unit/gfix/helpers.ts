import pino, { type Logger } from 'pino';
import { buildApp, type App } from '../../../src/app.js';
import { UnconfiguredCalendar, UnconfiguredGmail } from '../../../src/google/unconfigured.js';
import { defaultModules } from '../../../src/modules.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';

/** Captures pino lines as parsed objects. */
export function captureLog(level = 'info'): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const log = pino({ level }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return { log, lines };
}

export interface NoGoogleWorld {
  w: TestWorld;
  /** The full app wired as production wires it without Google settings. */
  app: App;
  lines: Array<Record<string, unknown>>;
  ownerSays(p: Persona, text: string): Promise<void>;
  advance(by: Parameters<TestWorld['clock']['advance']>[0]): Promise<void>;
  close(): Promise<void>;
}

let counter = 0;

/**
 * A test world whose app runs on the not-configured providers (production without Google).
 * It shares the world's database, clock, transport and scripted model; only this app
 * pumps jobs and runs the scheduler.
 */
export async function noGoogleWorld(): Promise<NoGoogleWorld> {
  const w = await createTestWorld();
  const { log, lines } = captureLog('warn');
  const app = await buildApp({ ...w.app.deps, calendar: new UnconfiguredCalendar(), gmail: new UnconfiguredGmail(), log }, defaultModules);
  return {
    w,
    app,
    lines,
    async ownerSays(p, text) {
      counter += 1;
      await app.ingest({
        transport: 'fake',
        kind: 'text',
        agentAddress: p.agentAddress,
        fromAddress: p.address,
        text,
        transportMessageId: `nog-${counter}`,
        receivedAt: w.clock.now(),
      });
      await app.settle();
    },
    async advance(by) {
      w.clock.advance(by);
      await app.scheduler.runDue();
      await app.settle();
    },
    async close() {
      await app.stop();
      await w.close();
    },
  };
}
