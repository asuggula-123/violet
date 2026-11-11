import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { Queryable } from '../db/db.js';
import type { ActionLog } from './actionLog.js';
import type { Repos } from './repos/index.js';

export interface Scheduler {
  register(name: string, everyMs: number, fn: (now: Date) => Promise<void>): void;
  /** Like register, but runs once per active agent; paused agents are skipped (I14). */
  registerPerAgent(name: string, everyMs: number, fn: (agentId: string, now: Date) => Promise<void>): void;
  runDue(): Promise<void>;
}

interface Task {
  name: string;
  everyMs: number;
  perAgent: boolean;
  fn: (scope: string, now: Date) => Promise<void>;
}

const GLOBAL = 'global';

export function createScheduler(deps: { db: Queryable; clock: Clock; repos: Repos; actionLog: ActionLog; log: Logger }): Scheduler {
  const { db, clock, repos, actionLog, log } = deps;
  const tasks: Task[] = [];

  function add(task: Task): void {
    if (tasks.some((t) => t.name === task.name)) throw new Error(`scheduler task already registered: ${task.name}`);
    tasks.push(task);
  }

  async function isDue(name: string, scope: string, everyMs: number, now: Date): Promise<boolean> {
    const res = await db.query<{ last_run_at: Date }>('SELECT last_run_at FROM scheduler_state WHERE name = $1 AND scope = $2', [
      name,
      scope,
    ]);
    const last = res.rows[0]?.last_run_at;
    return !last || now.getTime() - last.getTime() >= everyMs;
  }

  async function runScoped(task: Task, scope: string, now: Date): Promise<void> {
    if (!(await isDue(task.name, scope, task.everyMs, now))) return;
    try {
      await task.fn(scope, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ task: task.name, scope, err: message }, 'scheduled task failed');
      await actionLog.write({
        actor: 'scheduler',
        action: 'scheduler.failed',
        agentId: scope === GLOBAL ? null : scope,
        detail: { task: task.name, error: message },
      });
      return;
    }
    await db.query(
      `INSERT INTO scheduler_state (name, scope, last_run_at) VALUES ($1, $2, $3)
       ON CONFLICT (name, scope) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
      [task.name, scope, now],
    );
  }

  return {
    register(name, everyMs, fn) {
      add({ name, everyMs, perAgent: false, fn: (_scope, now) => fn(now) });
    },
    registerPerAgent(name, everyMs, fn) {
      add({ name, everyMs, perAgent: true, fn });
    },
    async runDue() {
      const now = clock.now();
      for (const task of tasks) {
        if (!task.perAgent) {
          await runScoped(task, GLOBAL, now);
          continue;
        }
        for (const agent of await repos.agents.listActive()) await runScoped(task, agent.id, now);
      }
    },
  };
}
