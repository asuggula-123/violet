import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { addMs, type Clock } from '../clock.js';
import { pgErrorCode, type Db, type Queryable } from '../db/db.js';
import type { ActionLog } from './actionLog.js';

/**
 * DB-backed queue; one running job per lane (lane = agent id). Jobs of a lane run
 * in order: a job is claimable only while no older unfinished job of its lane
 * (queued and due, waiting for a retry, or running) exists — whatever row locks
 * other workers hold. A job left `running` by a lost worker or a failed finish is
 * recovered after `staleMs` (a visibility timeout on the Clock), so handlers run
 * at least once.
 */
export interface JobQueue {
  register(type: string, handler: (payload: any) => Promise<void>): void;
  /** `opts.tx` writes the job inside the caller's transaction, so it commits or rolls back with it. */
  enqueue(type: string, payload: unknown, opts?: EnqueueOptions): Promise<void>;
  /** Recover stale running jobs, then run all currently runnable jobs; returns how many ran. */
  pump(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export interface EnqueueOptions {
  lane?: string;
  runAt?: Date;
  dedupeKey?: string;
  tx?: Queryable;
}

export interface JobQueueOptions {
  maxAttempts?: number;
  /** Delay before retry number `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
  pollMs?: number;
  /**
   * Visibility timeout: a job `running` for longer than this (by the Clock) is
   * presumed lost and recovered on the next pump — requeued, or `dead` if it used
   * its last attempt. Handlers must finish well within it.
   */
  staleMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_STALE_MS = 600_000;

export function defaultBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 3_600_000);
}

interface ClaimedJob {
  id: string;
  type: string;
  lane: string | null;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

export function createJobQueue(
  deps: { db: Db; clock: Clock; actionLog: ActionLog; log: Logger },
  opts: JobQueueOptions = {},
): JobQueue {
  const { db, clock, actionLog, log } = deps;
  const handlers = new Map<string, (payload: any) => Promise<void>>();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = opts.backoffMs ?? defaultBackoffMs;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;

  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  /** The lane is an agent id for agent work; only then does the log row carry it. */
  async function laneAgentId(q: Queryable, lane: string | null): Promise<string | null> {
    if (lane === null) return null;
    const res = await q.query<{ id: string }>('SELECT id FROM agents WHERE id = $1', [lane]);
    return res.rows[0]?.id ?? null;
  }

  async function logDead(q: Queryable, job: { id: string; type: string; lane: string | null; attempts: number }, error: string) {
    await actionLog.write(
      {
        actor: 'job',
        action: 'job.dead',
        agentId: await laneAgentId(q, job.lane),
        detail: { jobId: job.id, type: job.type, lane: job.lane, attempts: job.attempts, error },
      },
      q,
    );
    log.error({ jobId: job.id, type: job.type, err: error }, 'job dead');
  }

  /**
   * Visibility timeout. Jobs still `running` after staleMs lost their worker (crash,
   * or a finish that could not be written). Out of attempts → dead; else → retry now.
   * Concurrent recoveries are safe: the second UPDATE re-checks status and skips.
   */
  async function recoverStale(): Promise<void> {
    const now = clock.now();
    const cutoff = addMs(now, -staleMs);
    const error = `worker lost: still running after ${staleMs} ms`;
    await db.tx(async (tx) => {
      const dead = await tx.query<{ id: string; type: string; lane: string | null; attempts: number }>(
        `UPDATE jobs SET status = 'dead', last_error = $2, finished_at = $3, locked_at = NULL
         WHERE status = 'running' AND locked_at < $1 AND attempts >= max_attempts
         RETURNING id, type, lane, attempts`,
        [cutoff, error, now],
      );
      for (const job of dead.rows) await logDead(tx, job, error);
      const requeued = await tx.query(
        `UPDATE jobs SET status = 'failed', last_error = $2, run_at = $3, locked_at = NULL
         WHERE status = 'running' AND locked_at < $1`,
        [cutoff, error, now],
      );
      if (requeued.rowCount > 0) log.warn({ count: requeued.rowCount }, 'requeued stale running jobs');
    });
  }

  async function claim(): Promise<ClaimedJob | null> {
    for (;;) {
      try {
        return await db.tx(async (tx) => {
          const now = clock.now();
          // Lane order does not rely on row locks: while worker 1 holds the head job
          // locked (not yet marked running), that job is still 'queued' in every
          // snapshot, so it holds back the newer jobs of its lane for worker 2 too.
          // A queued job scheduled for later takes its place in the lane when due.
          const found = await tx.query<ClaimedJob>(
            `SELECT id, type, lane, payload, attempts, max_attempts FROM jobs j
             WHERE j.status IN ('queued', 'failed') AND j.run_at <= $1
               AND (j.lane IS NULL OR NOT EXISTS (
                 SELECT 1 FROM jobs o
                 WHERE o.lane = j.lane AND o.id <> j.id
                   AND (o.status = 'running'
                        OR (o.seq < j.seq AND (o.status = 'failed' OR (o.status = 'queued' AND o.run_at <= $1))))))
             ORDER BY j.run_at, j.seq
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [now],
          );
          const job = found.rows[0];
          if (!job) return null;
          await tx.query(`UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = $2 WHERE id = $1`, [
            job.id,
            now,
          ]);
          return { ...job, attempts: job.attempts + 1 };
        });
      } catch (err) {
        // Another worker started a job in the same lane first; look again.
        if (pgErrorCode(err) === '23505') continue;
        throw err;
      }
    }
  }

  /**
   * Writes the outcome of one attempt. Guarded by the attempt number: if stale
   * recovery already took the job and another worker re-claimed it, this is a no-op.
   */
  async function finish(job: ClaimedJob, err: unknown): Promise<void> {
    const now = clock.now();
    const mine = `id = $1 AND attempts = ${Number(job.attempts)} AND status IN ('running', 'failed')`;
    if (err === undefined) {
      await db.query(`UPDATE jobs SET status = 'done', finished_at = $2, locked_at = NULL WHERE ${mine}`, [job.id, now]);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts >= job.max_attempts) {
      await db.tx(async (tx) => {
        const res = await tx.query(
          `UPDATE jobs SET status = 'dead', last_error = $2, finished_at = $3, locked_at = NULL WHERE ${mine}`,
          [job.id, message, now],
        );
        if (res.rowCount > 0) await logDead(tx, job, message);
      });
      return;
    }
    await db.query(`UPDATE jobs SET status = 'failed', last_error = $2, run_at = $3, locked_at = NULL WHERE ${mine}`, [
      job.id,
      message,
      addMs(now, backoff(job.attempts)),
    ]);
    log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: message }, 'job failed, will retry');
  }

  /** A failed finish is retried once; after that the job stays running until stale recovery. */
  async function finishSafely(job: ClaimedJob, err: unknown): Promise<void> {
    try {
      await finish(job, err);
    } catch (first) {
      try {
        await finish(job, err);
      } catch (second) {
        log.error({ jobId: job.id, type: job.type, err: second, first }, 'could not record job outcome; stale recovery will retry it');
      }
    }
  }

  async function runOne(job: ClaimedJob): Promise<void> {
    const handler = handlers.get(job.type);
    if (!handler) {
      await finishSafely({ ...job, max_attempts: job.attempts }, new Error(`no handler for job type ${job.type}`));
      return;
    }
    let outcome: unknown;
    try {
      await handler(job.payload);
    } catch (err) {
      outcome = err ?? new Error('job failed');
    }
    await finishSafely(job, outcome);
  }

  async function drain(): Promise<number> {
    await recoverStale();
    let ran = 0;
    for (let job = await claim(); job; job = await claim()) {
      await runOne(job);
      ran += 1;
    }
    return ran;
  }

  async function tick(): Promise<void> {
    try {
      await queue.pump();
    } catch (err) {
      log.error({ err }, 'job pump failed');
    }
    if (timer) timer = setTimeout(() => void tick(), opts.pollMs ?? 250);
  }

  const queue: JobQueue = {
    register(type, handler) {
      if (handlers.has(type)) throw new Error(`job type already registered: ${type}`);
      handlers.set(type, handler);
    },

    async enqueue(type, payload, o = {}) {
      const now = clock.now();
      await (o.tx ?? db).query(
        `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, dedupe_key, created_at)
         VALUES ($1, $2, $3, $4::jsonb, 'queued', 0, $5, $6, $7, $8)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [randomUUID(), type, o.lane ?? null, JSON.stringify(payload ?? null), maxAttempts, o.runAt ?? now, o.dedupeKey ?? null, now],
      );
    },

    /** Calls made while a pump is in flight wait for it, then drain again. */
    async pump() {
      while (running) await running.catch(() => undefined);
      running = drain();
      try {
        return await running;
      } finally {
        running = null;
      }
    },

    start() {
      if (timer) return;
      // Stale running jobs are recovered by every pump, so the first tick covers a restart.
      timer = setTimeout(() => void tick(), 0);
    },

    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await running.catch(() => undefined);
    },
  };
  return queue;
}
