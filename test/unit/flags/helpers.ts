import { flagsModule } from '../../../src/flags/module.js';
import { dateTimeInZone } from '../../../src/google/time.js';
import type { FlagRow } from '../../../src/core/types.js';
import { createTestWorld, type Persona, type TestWorld, type WorldOptions } from '../../helpers/world.js';

export const NY = 'America/New_York';
/** UTC+14: its calendar date differs from New York's for most of the day. */
export const KIRITIMATI = 'Pacific/Kiritimati';

/** Wall time `YYYY-MM-DDTHH:MM[:SS]` in `zone` → instant. */
export function local(zone: string, wall: string): Date {
  const at = dateTimeInZone(wall, zone);
  if (!at) throw new Error(`bad wall time ${wall}`);
  return at;
}

/** A test world with flagsModule installed, its clock at `start` New York time. */
export async function flagsWorld(start = '2026-11-09T10:00', opts: WorldOptions = {}): Promise<TestWorld> {
  return createTestWorld({ modules: [flagsModule], start: local(NY, start), ...opts });
}

export async function setZone(w: TestWorld, p: Persona, timezone: string, digestHour?: number): Promise<void> {
  await w.db.query('UPDATE owners SET timezone = $2, digest_hour = coalesce($3, digest_hour) WHERE id = $1', [p.owner.id, timezone, digestHour ?? null]);
}

/** Moves the clock to a New York (or other zone) wall time, then runs the scheduler and settles. */
export async function at(w: TestWorld, wall: string, zone = NY): Promise<void> {
  w.clock.set(local(zone, wall));
  await w.app.scheduler.runDue();
  await w.app.settle();
}

export interface FlagState extends FlagRow {
  overflowed_at: Date | null;
  held_until: Date | null;
  budget_date: string | null;
  digest_id: string | null;
}

export async function flagsOf(w: TestWorld, p: Persona): Promise<FlagState[]> {
  const res = await w.db.query<FlagState>(
    `SELECT id, agent_id, kind, urgency, text, dedupe_key, status, created_at, delivered_at, digest_date::text AS digest_date,
            overflowed_at, held_until, budget_date::text AS budget_date, digest_id
     FROM flags WHERE agent_id = $1 ORDER BY seq`,
    [p.agent.id],
  );
  return res.rows;
}

export function now(w: TestWorld, p: Persona, text: string, dedupeKey?: string): Promise<void> {
  return w.app.flags.raise(p.agent.id, { kind: 'test_now', urgency: 'now', text, ...(dedupeKey ? { dedupeKey } : {}) });
}

export function later(w: TestWorld, p: Persona, text: string, kind = 'message_taken'): Promise<void> {
  return w.app.flags.raise(p.agent.id, { kind, urgency: 'digest', text });
}

/** Texts sent to the owner with purpose 'digest'. */
export function digestsTo(w: TestWorld, p: Persona): string[] {
  return w.transport.sent.filter((m) => m.toAddress === p.address && m.purpose === 'digest').map((m) => m.text);
}

export function flagTextsTo(w: TestWorld, p: Persona): string[] {
  return w.transport.sent.filter((m) => m.toAddress === p.address && m.purpose === 'flag').map((m) => m.text);
}
