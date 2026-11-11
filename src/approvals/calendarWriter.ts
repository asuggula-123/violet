import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { FlagService } from '../core/flags.js';
import type { Repos } from '../core/repos/index.js';
import type { Queryable } from '../db/db.js';
import type { CalendarProvider } from '../google/types.js';
import { codeLine } from './line.js';
import { approvalsRepo } from './repo.js';
import type { ApprovalKind, ApprovalRow, CalendarWriter, ExecuteResult } from './types.js';

/** Thrown when CalendarWriter is asked to write for an approval that is not `approved` (I6). */
export class CalendarWriteRefused extends Error {
  override readonly name = 'CalendarWriteRefused';
}

class PastEvent extends Error {
  readonly ownerMessage = 'the event has already started';
}

const DEFAULT_REASON = "the calendar didn't accept it";
/** Cap for a digest 'Booked' line. */
export const BOOKED_LINE_MAX = 240;

interface Deps {
  db: Queryable;
  clock: Clock;
  repos: Repos;
  calendar: CalendarProvider;
  actionLog: ActionLog;
  flags: FlagService;
  log: Logger;
  kind(name: string): ApprovalKind | undefined;
}

/**
 * I6: the ONLY code that calls CalendarProvider.createEvent / deleteEvent. It loads the
 * approval itself, requires status `approved`, and builds the events from the STORED
 * payload via the kind's calendarEvents(): no caller can pass event data in.
 */
export function createCalendarWriter(deps: Deps): CalendarWriter {
  const { db, clock, repos, calendar, actionLog, flags, log } = deps;
  const approvals = approvalsRepo(db, clock);

  async function writesOf(approvalId: string) {
    const res = await db.query<{ id: string; owner_id: string; event_id: string | null; idempotency_key: string; deleted_at: Date | null }>(
      'SELECT id, owner_id, event_id, idempotency_key, deleted_at FROM calendar_writes WHERE approval_id = $1 ORDER BY seq',
      [approvalId],
    );
    return res.rows;
  }

  async function refuse(agentId: string | null, approvalId: string, reason: string): Promise<never> {
    await actionLog.write({ agentId, actor: 'system', action: 'calendar.write_refused', detail: { approvalId, reason } });
    throw new CalendarWriteRefused(`calendar write refused for approval ${approvalId}: ${reason}`);
  }

  /**
   * 8.5: a booked approval of a kind with `booked()` becomes one 'booked' digest item,
   * code-rendered from the stored payload (I13). The dedupe key makes it once per approval,
   * so it is raised again (a no-op) on every call that finds the approval executed: a
   * failure between the booking and the flag is repaired by the retry.
   */
  async function flagBooked(approval: ApprovalRow, kind: ApprovalKind | undefined): Promise<void> {
    if (!kind?.booked) return;
    const agent = await repos.agents.get(approval.agent_id);
    const owner = agent ? await repos.owners.get(agent.owner_id) : null;
    if (!agent || !owner) return;
    const line = codeLine(kind.booked(kind.schema.parse(approval.payload), { timezone: owner.timezone }), BOOKED_LINE_MAX);
    await flags.raise(agent.id, { kind: 'booked', urgency: 'digest', text: line, dedupeKey: `booked:${approval.id}` });
  }

  const writer: CalendarWriter = {
    async executeApproved(approvalId) {
      const approval = await approvals.get(approvalId);
      if (!approval) return refuse(null, approvalId, 'unknown_approval');
      if (approval.status === 'executed') {
        await flagBooked(approval, deps.kind(approval.kind));
        return { ok: true, eventIds: (await writesOf(approvalId)).flatMap((w) => (w.event_id ? [w.event_id] : [])) };
      }
      if (approval.status === 'failed') return { ok: false, reason: approval.error ?? DEFAULT_REASON };
      if (approval.status !== 'approved') return refuse(approval.agent_id, approvalId, `status_${approval.status}`);
      // Defence in depth: an approval must have been resolved before it expired.
      if (approval.resolved_at && approval.resolved_at.getTime() > approval.expires_at.getTime()) {
        return refuse(approval.agent_id, approvalId, 'resolved_after_expiry');
      }
      const kind = deps.kind(approval.kind);
      if (!kind?.calendarEvents) return refuse(approval.agent_id, approvalId, 'kind_has_no_events');
      const agent = await repos.agents.get(approval.agent_id);
      if (!agent) return refuse(approval.agent_id, approvalId, 'unknown_agent');

      let result: ExecuteResult;
      try {
        await kind.guard?.(approval);
        const events = kind.calendarEvents(kind.schema.parse(approval.payload));
        // Never book something that has already started (an approval resolved just in
        // time can still reach this after the start).
        if (events.some((ev) => ev.start.getTime() <= clock.now().getTime())) throw new PastEvent();
        const eventIds: string[] = [];
        for (const [n, ev] of events.entries()) {
          const idempotencyKey = `approval:${approval.id}:${n}`;
          // I7: the intent is recorded first, so an event the provider made but whose
          // response was lost (or a crash before the id is stored) can still be undone by key.
          await db.query(
            `INSERT INTO calendar_writes (id, owner_id, approval_id, event_id, idempotency_key, created_at)
             VALUES ($1, $2, $3, NULL, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
            [randomUUID(), agent.owner_id, approval.id, idempotencyKey, clock.now()],
          );
          const { eventId } = await calendar.createEvent(agent.owner_id, ev, idempotencyKey);
          await db.query('UPDATE calendar_writes SET event_id = $2 WHERE idempotency_key = $1 AND event_id IS NULL', [idempotencyKey, eventId]);
          await actionLog.write({ agentId: agent.id, actor: 'system', action: 'calendar.event_created', detail: { approvalId, eventId, n } });
          eventIds.push(eventId);
        }
        result = { ok: true, eventIds };
      } catch (err) {
        log.warn({ approvalId, err: err instanceof Error ? err.message : String(err) }, 'calendar write failed');
        result = { ok: false, reason: ownerReason(err) };
        try {
          await writer.undo(approvalId);
        } catch (undoErr) {
          // Left in calendar_writes (deleted_at NULL): a caller that must never leave a
          // half-booking (a2a) sees it as still live and retries the undo.
          log.warn({ approvalId, err: undoErr instanceof Error ? undoErr.message : String(undoErr) }, 'calendar undo after a failed write failed');
        }
      }
      if (await approvals.finishExecution(approvalId, result.ok ? 'executed' : 'failed', result.ok ? null : result.reason)) {
        await actionLog.write({
          agentId: agent.id,
          actor: 'system',
          action: result.ok ? 'approval.executed' : 'approval.failed',
          detail: { approvalId, ref: approval.ref, ...(result.ok ? { events: result.eventIds.length } : { reason: result.reason }) },
        });
      }
      if (result.ok) await flagBooked(approval, kind);
      return result;
    },

    async undo(approvalId) {
      const approval = await approvals.get(approvalId);
      let undone = 0;
      for (const w of await writesOf(approvalId)) {
        if (w.deleted_at) continue;
        // An unconfirmed write (the provider's answer never arrived): find the event by key.
        const eventId = w.event_id ?? (await calendar.eventIdForKey(w.owner_id, w.idempotency_key));
        if (eventId) await calendar.deleteEvent(w.owner_id, eventId);
        await db.query('UPDATE calendar_writes SET deleted_at = $2 WHERE id = $1', [w.id, clock.now()]);
        if (!eventId) continue; // never reached the calendar
        await actionLog.write({ agentId: approval?.agent_id ?? null, actor: 'system', action: 'calendar.event_deleted', detail: { approvalId, eventId } });
        undone += 1;
      }
      return undone;
    },
  };
  return writer;
}

function ownerReason(err: unknown): string {
  const m = typeof err === 'object' && err !== null ? (err as { ownerMessage?: unknown }).ownerMessage : undefined;
  return typeof m === 'string' && m.trim() !== '' ? m.slice(0, 200) : DEFAULT_REASON;
}
