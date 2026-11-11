import type { Logger } from 'pino';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import { createActionLog, type ActionLog } from './core/actionLog.js';
import { createFlagService, type FlagHub } from './core/flags.js';
import { createJobQueue, type JobQueue, type JobQueueOptions } from './core/jobs.js';
import type { A2AService, ApprovalService, Brain, DigestService } from './core/later.js';
import { createOutbound, type OutboundGateway } from './core/outbound.js';
import { createRepos, type Repos } from './core/repos/index.js';
import { applyPauseCommand, createRouter, ownerPauseCommand, PAUSE_STATE_STEP, PAUSED_AT_ARRIVAL_STEP, type Router } from './core/router.js';
import { createScheduler, type Scheduler } from './core/scheduler.js';
import type { Db } from './db/db.js';
import type { CalendarProvider, GmailProvider } from './google/types.js';
import type { LlmClient } from './llm/types.js';
import type { InboundMessage, Transport } from './transport/types.js';

export interface AppDeps {
  db: Db;
  clock: Clock;
  transport: Transport;
  llm: LlmClient;
  calendar: CalendarProvider;
  gmail: GmailProvider;
  config: Config;
  log: Logger;
}

export interface Module {
  name: string;
  install(app: App): void | Promise<void>;
}

export interface App {
  deps: AppDeps;
  repos: Repos;
  actionLog: ActionLog;
  gateway: OutboundGateway;
  jobs: JobQueue;
  scheduler: Scheduler;
  /** FlagService; flagsModule (M5) installs the I17 policy through its hook. */
  flags: FlagHub;
  router: Router;
  /** Persist + enqueue, fast. */
  ingest(msg: InboundMessage): Promise<void>;
  /** Pump until idle (tests, demo). */
  settle(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  // installed by later modules:
  approvals?: ApprovalService;
  brain?: Brain;
  a2a?: A2AService;
  digest?: DigestService;
}

export const INBOUND_JOB = 'inbound.process';

export interface BuildOptions {
  jobs?: JobQueueOptions;
  /** Real-time interval for scheduler.runDue while started. */
  schedulerTickMs?: number;
}

export async function buildApp(deps: AppDeps, modules: readonly Module[], opts: BuildOptions = {}): Promise<App> {
  const { db, clock, transport, log } = deps;
  const repos = createRepos(db, clock);
  const actionLog = createActionLog(db, clock);
  const { gateway, control } = createOutbound({ transport, repos, actionLog, log });
  const jobs = createJobQueue({ db, clock, actionLog, log }, opts.jobs);
  const scheduler = createScheduler({ db, clock, repos, actionLog, log });
  const flags = createFlagService({ repos, gateway, actionLog });
  const router = createRouter({ db, clock, repos, actionLog, gateway, control, flags });

  jobs.register(INBOUND_JOB, (p: { inboundEventId: string }) => router.process(p.inboundEventId));

  let schedulerTimer: NodeJS.Timeout | null = null;
  /** The scheduler tick in flight, awaited by stop() so the db is not closed under it. */
  let schedulerRun: Promise<void> | null = null;

  const app: App = {
    deps,
    repos,
    actionLog,
    gateway,
    jobs,
    scheduler,
    flags,
    router,

    async ingest(msg) {
      // I18: the event row and its job commit together. If the enqueue fails, the
      // insert rolls back too, so the transport's redelivery is not taken for a duplicate.
      const event = await db.tx(async (tx) => {
        const txRepos = createRepos(tx, clock);
        const inserted = await txRepos.inboundEvents.insert(msg);
        if (!inserted) return null;
        const agent = await txRepos.agents.findByAddress(msg.transport, msg.agentAddress);
        // Pause is immediate (I14): the owner's pause/resume flips state here, in the
        // transaction that stores the event, never behind the lane's backlog. The gateway
        // checks `paused` at send time, so older jobs and their retries cannot send after
        // this commits. The job still stores the message, acks and runs hooks in lane order.
        const command = agent ? ownerPauseCommand(agent, msg) : null;
        if (agent && command) {
          const result = await applyPauseCommand({ repos: txRepos, log: (entry) => actionLog.write(entry, tx) }, agent.id, command);
          await txRepos.inboundEvents.markStep(inserted.id, PAUSE_STATE_STEP, result);
        } else if (agent?.paused) {
          // I14: a message that reaches a paused agent stays held even if a resume is
          // ingested before its job runs (the router holds on arrival OR processing state).
          await txRepos.inboundEvents.markStep(inserted.id, PAUSED_AT_ARRIVAL_STEP, true);
        }
        await jobs.enqueue(
          INBOUND_JOB,
          { inboundEventId: inserted.id },
          { dedupeKey: `inbound:${inserted.id}`, tx, ...(agent ? { lane: agent.id } : {}) },
        );
        return inserted;
      });
      if (!event) {
        await actionLog.write({
          actor: 'system',
          action: 'inbound.duplicate',
          detail: { transport: msg.transport, transportMessageId: msg.transportMessageId },
        });
      }
    },

    async settle() {
      while ((await jobs.pump()) > 0);
    },

    async start() {
      jobs.start();
      const tick = async () => {
        schedulerRun = scheduler.runDue().catch((err: unknown) => log.error({ err }, 'scheduler tick failed'));
        await schedulerRun;
        schedulerRun = null;
        if (schedulerTimer) schedulerTimer = setTimeout(() => void tick(), opts.schedulerTickMs ?? 30_000);
      };
      schedulerTimer = setTimeout(() => void tick(), 0);
    },

    async stop() {
      if (schedulerTimer) clearTimeout(schedulerTimer);
      schedulerTimer = null;
      await schedulerRun;
      await jobs.stop();
    },
  };

  for (const m of modules) {
    await m.install(app);
    log.debug({ module: m.name }, 'module installed');
  }
  return app;
}
