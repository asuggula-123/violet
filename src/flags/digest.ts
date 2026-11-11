import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { OutboundGateway } from '../core/outbound.js';
import type { Db } from '../db/db.js';
import { TransportError } from '../transport/types.js';
import { digestStore as store, type DigestAgent, type DigestItem, type DigestRow } from './digestStore.js';
import { retryDelayMs } from './policy.js';
import { renderDigest, type DigestGroup } from './render.js';
import { isQuietHours, localDate, localParts, startOfLocalDate } from './time.js';
import type { DigestRange, DigestSection, DigestService } from './types.js';

/** A built digest's send lease: a worker that crashed mid-send is retried after it. */
export const DIGEST_LEASE_MS = 2 * 60_000;
/** A live section that has not answered by then is left out (logged), like one that throws. */
export const LIVE_SECTION_TIMEOUT_MS = 5_000;
/** Agents whose digests runDue works on at once, so one slow agent does not hold back the rest. */
export const DIGEST_CONCURRENCY = 4;

export const DEFAULT_SECTIONS: readonly DigestSection[] = [
  { key: 'messages', title: 'Messages taken', order: 10 },
  { key: 'conversations', title: 'Agent conversations', order: 20 },
  { key: 'drafts', title: 'Drafts', order: 30 },
  { key: 'booked', title: 'Booked', order: 40 },
  { key: 'waiting', title: 'Waiting for you', order: 50 },
  { key: 'also', title: 'Also', order: 90 },
];

/** Flag kind → section (8.5). The a2a_* kinds are raised by the agent-to-agent milestone (M4). */
const DEFAULT_KINDS: Record<string, string> = {
  message_taken: 'messages',
  a2a_opened: 'conversations',
  a2a_closed: 'conversations',
  // A conversation whose Envoy made no move and needs the owner's guidance (M4).
  a2a_stalled: 'conversations',
  draft_created: 'drafts',
  booked: 'booked',
  a2a_booked: 'booked',
  approval_expired: 'also',
};

/** Why a due digest is not sent yet (logged once per date and reason as digest.deferred). */
type Blocker = 'paused' | 'quiet_hours' | 'no_owner';

/**
 * The daily digest (8.5). Once per owner-local date, from digest_hour on, code renders one
 * message from the agent's undelivered digest items and live sections. Building it is one
 * transaction under the agent row lock: the stored body and the items it carries are fixed
 * together, so a retry re-sends exactly that body, and items raised later wait for the next
 * date. A digest not delivered before its date ends rolls its items into the next one.
 */
export function createDigestService(deps: {
  db: Db;
  clock: Clock;
  gateway: OutboundGateway;
  actionLog: ActionLog;
  log: Logger;
  liveSectionTimeoutMs?: number;
}): DigestService {
  const { db, clock, gateway, actionLog, log } = deps;
  const liveTimeoutMs = deps.liveSectionTimeoutMs ?? LIVE_SECTION_TIMEOUT_MS;
  const sections = new Map<string, DigestSection>(DEFAULT_SECTIONS.map((s) => [s.key, s]));
  const kinds = new Map<string, string>(Object.entries(DEFAULT_KINDS));

  function sectionOf(item: DigestItem): string {
    if (item.overflowed) return 'also';
    const key = kinds.get(item.kind);
    return key && sections.has(key) ? key : 'also';
  }

  /** s.lines(), or a rejection once it has taken longer than the live-section timeout. */
  function withTimeout(s: DigestSection, agentId: string, range: DigestRange): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${liveTimeoutMs} ms`)), liveTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([Promise.resolve().then(() => s.lines!(agentId, range)), timeout]).finally(() => clearTimeout(timer));
  }

  async function liveLines(agentId: string, range: DigestRange): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const live = [...sections.values()].filter((s) => s.lines);
    await Promise.all(
      live.map(async (s) => {
        try {
          out.set(s.key, await withTimeout(s, agentId, range));
        } catch (err) {
          // A broken or hung live section never blocks the digest: it is left out.
          log.warn({ agentId, section: s.key, err: err instanceof Error ? err.message : String(err) }, 'digest section failed; omitted');
        }
      }),
    );
    return out;
  }

  function render(items: DigestItem[], live: Map<string, string[]>) {
    const groups: DigestGroup[] = [...sections.values()]
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
      .map((s) => ({
        title: s.title,
        items: [...items.filter((i) => sectionOf(i) === s.key).map((i) => i.text), ...(live.get(s.key) ?? [])],
      }));
    return renderDigest(groups);
  }

  function rangeOf(a: DigestAgent, now: Date): DigestRange {
    const date = localDate(a.timezone, now);
    return { date, from: startOfLocalDate(a.timezone, date), to: now };
  }

  /** Builds and claims the date's digest. claimed = this worker holds its send lease. */
  async function build(a: DigestAgent, now: Date): Promise<{ row: DigestRow; claimed: boolean } | null> {
    const range = rangeOf(a, now);
    const live = await liveLines(a.id, range);
    return db.tx(async (tx) => {
      await store.lockAgent(tx, a.id);
      const existing = await store.get(tx, a.id, range.date);
      if (existing) return { row: existing, claimed: false };
      const items = await store.items(tx, a.id, true);
      const r = render(items, live);
      const row = await store.insert(tx, {
        agentId: a.id,
        date: range.date,
        body: r.body,
        itemCount: r.itemCount,
        leftOut: r.leftOut,
        now,
        leaseUntil: r.body === null ? null : new Date(now.getTime() + DIGEST_LEASE_MS),
      });
      if (!row) return null;
      if (r.body === null) {
        await actionLog.write({ agentId: a.id, actor: 'scheduler', action: 'digest.empty', detail: { date: range.date } }, tx);
        return { row, claimed: false };
      }
      await store.assign(tx, row, items.map((i) => i.id));
      return { row, claimed: true };
    });
  }

  async function defer(agentId: string, date: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    await actionLog.write({ agentId, actor: 'scheduler', action: 'digest.deferred', detail: { date, reason, ...extra } });
  }

  async function deferOnce(agentId: string, date: string, reason: Blocker): Promise<void> {
    if (!(await store.deferredLogged(db, agentId, date, reason))) await defer(agentId, date, reason);
  }

  async function markSent(row: DigestRow, at: Date): Promise<void> {
    await db.tx(async (tx) => {
      if (!(await store.markSent(tx, row.id, at))) return;
      await actionLog.write(
        { agentId: row.agent_id, actor: 'scheduler', action: 'digest.sent', detail: { date: row.local_date, digestId: row.id, items: row.item_count, leftOut: row.left_out } },
        tx,
      );
    });
  }

  async function rollOver(row: DigestRow, reason: string): Promise<void> {
    await db.tx(async (tx) => {
      const returned = await store.rollOver(tx, row.id);
      if (returned === null) return;
      await actionLog.write(
        { agentId: row.agent_id, actor: 'scheduler', action: 'digest.deferred', detail: { date: row.local_date, reason, rolledOver: returned } },
        tx,
      );
    });
  }

  /** Sends a claimed digest's stored body. Failures are logged, never thrown. */
  async function send(row: DigestRow, now: Date): Promise<void> {
    const recorded = await store.recordedAt(db, row);
    if (recorded) return markSent(row, recorded);
    let sent;
    try {
      sent = await gateway.sendToOwner(row.agent_id, row.body!, { purpose: 'digest' });
    } catch (err) {
      if (err instanceof TransportError && err.permanent) return rollOver(row, 'send_failed');
      // Back off (1 min doubling to 15 min, or the transport's retryAfterMs) by keeping the
      // lease until then; one digest.deferred per backoff step, the same body on retry.
      const failures = await store.countFailure(db, row.id);
      if (failures === null) return;
      const retryAt = new Date(now.getTime() + retryDelayMs(failures, err instanceof TransportError ? err.retryAfterMs : undefined));
      await store.extendLease(db, row.id, retryAt);
      return defer(row.agent_id, row.local_date, 'send_failed', {
        attempt: failures,
        retryAt: retryAt.toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!sent) {
      await store.releaseLease(db, row.id);
      return deferOnce(row.agent_id, row.local_date, 'paused');
    }
    await markSent(row, now);
  }

  /** Due from digest_hour on; inside quiet hours only during digest_hour itself (catch-up never is). */
  function blocker(a: DigestAgent, now: Date): Blocker | null {
    if (!a.owner_address) return 'no_owner';
    if (a.paused) return 'paused';
    if (isQuietHours(a.timezone, now) && localParts(a.timezone, now).hour !== a.digest_hour) return 'quiet_hours';
    return null;
  }

  async function runAgent(a: DigestAgent, now: Date): Promise<void> {
    const date = localDate(a.timezone, now);
    for (const old of await store.stale(db, a.id, date, now)) {
      const recorded = await store.recordedAt(db, old);
      if (recorded) await markSent(old, recorded);
      else await rollOver(old, 'day_ended');
    }
    let row = await store.get(db, a.id, date);
    if (row && row.status !== 'sending') return;
    if (!row && localParts(a.timezone, now).hour < a.digest_hour) return;
    const blocked = blocker(a, now);
    if (blocked) return deferOnce(a.id, date, blocked);
    let claimed = false;
    if (row) {
      claimed = await store.claim(db, row.id, now, new Date(now.getTime() + DIGEST_LEASE_MS));
    } else {
      const built = await build(a, now);
      row = built?.row ?? null;
      claimed = built?.claimed ?? false;
    }
    if (row && claimed) await send(row, now);
  }

  return {
    registerKind(kind, sectionKey) {
      kinds.set(kind, sectionKey);
    },

    addSection(section) {
      sections.set(section.key, section);
    },

    async runDue(now) {
      const queue = await store.agents(db);
      const worker = async (): Promise<void> => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            await runAgent(a, now);
          } catch (err) {
            // One agent's failure never holds back the others; the next run retries.
            log.error({ agentId: a.id, err: err instanceof Error ? err.message : String(err) }, 'digest run failed');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DIGEST_CONCURRENCY, queue.length) }, worker));
    },

    async preview(agentId) {
      const [a] = await store.agents(db, agentId);
      if (!a) throw new Error(`unknown agent ${agentId}`);
      const now = clock.now();
      const row = await store.get(db, a.id, localDate(a.timezone, now));
      if (row?.status === 'sending') return row.body;
      return render(await store.items(db, a.id, false), await liveLines(a.id, rangeOf(a, now))).body;
    },
  };
}
