import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { NowDelivery } from '../core/flags.js';
import type { OutboundGateway } from '../core/outbound.js';
import type { Db, Queryable } from '../db/db.js';
import { TransportError } from '../transport/types.js';
import { isQuietHours, localDate, quietHoursEnd } from './time.js';

/** I17: at most this many 'now' flags are texted per owner-local day. */
export const NOW_BUDGET = 3;
/** A send in flight blocks other deliveries of the same flag this long (a crashed send is retried after it). */
export const SEND_LEASE_MS = 2 * 60_000;
/** Backoff after a retryable send failure: 1 min, doubling per consecutive failure, at most 15 min. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 15 * 60_000;

/** When the n-th consecutive retryable failure may be retried (never before the transport's retryAfterMs). */
export function retryDelayMs(failures: number, retryAfterMs?: number): number {
  const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 10)));
  return Math.max(step, retryAfterMs ?? 0);
}

interface ClaimRow {
  id: string;
  agent_id: string;
  kind: string;
  text: string;
  status: string;
  urgency: string;
  held_until: Date | null;
  budget_date: string | null;
  attempt_at: Date | null;
  overflowed_at: Date | null;
}

interface Claimed {
  id: string;
  agentId: string;
  text: string;
  released: boolean;
}

/** claim() result when older held flags are due first: they are texted before this one decides. */
const HELD_FIRST = 'held_first' as const;

export interface NowPolicy {
  deliver: NowDelivery;
  /** Scheduler task: texts held flags whose quiet hours ended and retries failed sends, oldest first. */
  releaseDue(now: Date): Promise<void>;
}

/**
 * The I17 policy for 'now' flags, per owner, in the owner's zone. Every decision is taken
 * under the agent row lock, so concurrent raises and releases never exceed the budget or
 * text one flag twice. Paused (I14) or over budget → a digest item; quiet hours → held.
 */
export function createNowPolicy(deps: { db: Db; gateway: OutboundGateway; actionLog: ActionLog; log: Logger; clock: Clock }): NowPolicy {
  const { db, gateway, actionLog, log, clock } = deps;

  async function overflow(q: Queryable, f: { id: string; agent_id: string; kind: string }, reason: string, now: Date, extra: Record<string, unknown> = {}): Promise<void> {
    await q.query(
      `UPDATE flags SET overflowed_at = $2, budget_date = NULL, held_until = NULL, attempt_at = NULL WHERE id = $1 AND status = 'pending'`,
      [f.id, now],
    );
    await actionLog.write({ agentId: f.agent_id, actor: 'system', action: 'flag.overflow', detail: { flagId: f.id, kind: f.kind, reason, ...extra } }, q);
  }

  /** Decides, under the agent lock, whether this flag is texted now; returns it if so. */
  async function claim(flagId: string, now: Date): Promise<Claimed | typeof HELD_FIRST | null> {
    return db.tx(async (tx) => {
      const agent = await tx.query<{ paused: boolean; timezone: string }>(
        `SELECT a.paused, o.timezone FROM agents a JOIN owners o ON o.id = a.owner_id
         WHERE a.id = (SELECT agent_id FROM flags WHERE id = $1) FOR UPDATE OF a`,
        [flagId],
      );
      const a = agent.rows[0];
      if (!a) return null;
      const res = await tx.query<ClaimRow>(
        `SELECT id, agent_id, kind, text, status, urgency, held_until, budget_date::text AS budget_date, attempt_at, overflowed_at
         FROM flags WHERE id = $1 FOR UPDATE`,
        [flagId],
      );
      const f = res.rows[0];
      if (!f || f.status !== 'pending' || f.urgency !== 'now' || f.overflowed_at) return null;
      if (f.attempt_at) {
        if (now.getTime() - f.attempt_at.getTime() < SEND_LEASE_MS) return null;
        // A send that crashed after the gateway recorded it: delivered, do not text again.
        const sent = await tx.query<{ created_at: Date }>(
          `SELECT created_at FROM messages WHERE agent_id = $1 AND thread = 'owner' AND direction = 'out'
           AND purpose = 'flag' AND body = $2 AND created_at >= $3 ORDER BY seq LIMIT 1`,
          [f.agent_id, f.text, f.attempt_at],
        );
        if (sent.rows[0]) {
          await tx.query(`UPDATE flags SET status = 'sent', delivered_at = $2, attempt_at = NULL WHERE id = $1`, [f.id, sent.rows[0].created_at]);
          return null;
        }
      }
      if (a.paused) {
        await overflow(tx, f, 'paused', now);
        return null;
      }
      if (isQuietHours(a.timezone, now)) {
        if (f.held_until && f.held_until.getTime() > now.getTime()) return null;
        const until = quietHoursEnd(a.timezone, now);
        await tx.query('UPDATE flags SET held_until = $2, attempt_at = NULL WHERE id = $1', [f.id, until]);
        await actionLog.write({ agentId: f.agent_id, actor: 'system', action: 'flag.held', detail: { flagId: f.id, kind: f.kind, until: until.toISOString() } }, tx);
        return null;
      }
      const released = f.held_until !== null;
      const date = localDate(a.timezone, now);
      if (f.budget_date !== date) {
        if (!released) {
          // Held flags whose quiet hours are over go out first, oldest first, within the
          // new day's budget: a fresh flag raised before the release tick waits for them.
          const held = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM flags WHERE agent_id = $1 AND status = 'pending' AND urgency = 'now'
             AND overflowed_at IS NULL AND held_until IS NOT NULL AND held_until <= $2 AND id <> $3`,
            [f.agent_id, now, f.id],
          );
          if ((held.rows[0]?.n ?? 0) > 0) return HELD_FIRST;
        }
        const used = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM flags WHERE agent_id = $1 AND budget_date = $2 AND id <> $3
           AND (status = 'sent' OR (status = 'pending' AND overflowed_at IS NULL))`,
          [f.agent_id, date, f.id],
        );
        if ((used.rows[0]?.n ?? 0) >= NOW_BUDGET) {
          await overflow(tx, f, 'budget', now, { date, ...(released ? { held: true } : {}) });
          return null;
        }
      }
      await tx.query('UPDATE flags SET budget_date = $2, attempt_at = $3, held_until = NULL WHERE id = $1', [f.id, date, now]);
      return { id: f.id, agentId: f.agent_id, text: f.text, released };
    });
  }

  /** Texts (or turns into digest items) the agent's held flags that are due, oldest first. */
  async function releaseHeld(agentId: string, now: Date): Promise<void> {
    const due = await db.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM flags WHERE agent_id = $1 AND status = 'pending' AND urgency = 'now'
       AND overflowed_at IS NULL AND held_until IS NOT NULL AND held_until <= $2 ORDER BY seq`,
      [agentId, now],
    );
    for (const f of due.rows) {
      try {
        await deliverById(f.id, f.kind, now, false);
      } catch (err) {
        log.warn({ agentId, flagId: f.id, err: err instanceof Error ? err.message : String(err) }, 'flag delivery failed; will retry');
      }
    }
  }

  async function deliverById(flagId: string, kind: string, now: Date, releaseFirst = true): Promise<void> {
    const c = await claim(flagId, now);
    if (c === HELD_FIRST) {
      // Once: if held flags are still due after this (a send of one is in flight elsewhere),
      // this flag stays pending and the release task delivers it in seq order.
      if (!releaseFirst) return;
      const agentId = await db.query<{ agent_id: string }>('SELECT agent_id FROM flags WHERE id = $1', [flagId]);
      if (!agentId.rows[0]) return;
      await releaseHeld(agentId.rows[0].agent_id, now);
      return deliverById(flagId, kind, now, false);
    }
    if (!c) return;
    let sent;
    try {
      sent = await gateway.sendToOwner(c.agentId, c.text, { purpose: 'flag' });
    } catch (err) {
      if (err instanceof TransportError && err.permanent) {
        // Retrying cannot help: keep it for the digest instead of losing it.
        await overflow(db, { id: c.id, agent_id: c.agentId, kind }, 'send_failed', now);
        return;
      }
      // Free the lease so a retried raise tries again at once; the release task backs off.
      const res = await db.query<{ send_failures: number }>(
        `UPDATE flags SET attempt_at = NULL, send_failures = send_failures + 1 WHERE id = $1 AND status = 'pending' RETURNING send_failures`,
        [c.id],
      );
      const failures = res.rows[0]?.send_failures;
      if (failures !== undefined) {
        const retryAfterMs = err instanceof TransportError ? err.retryAfterMs : undefined;
        await db.query('UPDATE flags SET retry_at = $2 WHERE id = $1', [c.id, new Date(now.getTime() + retryDelayMs(failures, retryAfterMs))]);
      }
      throw err;
    }
    if (!sent) {
      // Suppressed at send time (paused meanwhile): not lost, it waits for the digest.
      await overflow(db, { id: c.id, agent_id: c.agentId, kind }, 'suppressed', now);
      return;
    }
    await db.query(`UPDATE flags SET status = 'sent', delivered_at = $2, attempt_at = NULL WHERE id = $1`, [c.id, now]);
    if (c.released) await actionLog.write({ agentId: c.agentId, actor: 'system', action: 'flag.released', detail: { flagId: c.id, kind } });
  }

  return {
    deliver: (flag) => deliverById(flag.id, flag.kind, clock.now()),

    async releaseDue(now) {
      const due = await db.query<{ id: string; kind: string; agent_id: string }>(
        `SELECT id, kind, agent_id FROM flags
         WHERE status = 'pending' AND urgency = 'now' AND overflowed_at IS NULL
           AND ((held_until IS NOT NULL AND held_until <= $1)
             OR (held_until IS NULL AND (attempt_at IS NULL OR attempt_at <= $2)))
           AND (retry_at IS NULL OR retry_at <= $1)
         ORDER BY seq LIMIT 500`,
        [now, new Date(now.getTime() - SEND_LEASE_MS)],
      );
      for (const f of due.rows) {
        try {
          await deliverById(f.id, f.kind, now, false);
        } catch (err) {
          log.warn({ agentId: f.agent_id, flagId: f.id, err: err instanceof Error ? err.message : String(err) }, 'flag delivery failed; will retry');
        }
      }
    },
  };
}
