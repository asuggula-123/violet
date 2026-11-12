import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CalendarWriteRefused } from '../../../src/approvals/calendarWriter.js';
import { ToolError } from '../../../src/llm/tools.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

const dinner = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00', location: 'Luigi' };

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('CalendarWriter (I6)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  const approve = (id: string) => w.db.query(`UPDATE approvals SET status = 'approved' WHERE id = $1`, [id]);

  it('refuses unless the approval is approved', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await expect(w.app.approvals!.calendar.executeApproved(a.id)).rejects.toBeInstanceOf(CalendarWriteRefused);
    await w.app.approvals!.cancel(a.id, 'x');
    await expect(w.app.approvals!.calendar.executeApproved(a.id)).rejects.toBeInstanceOf(CalendarWriteRefused);
    await expect(w.app.approvals!.calendar.executeApproved('no-such-id')).rejects.toBeInstanceOf(CalendarWriteRefused);
    expect(w.calendar.writes).toEqual([]);
    expect((await w.actions({ action: 'calendar.write_refused' })).map((r) => r.detail.reason)).toEqual(['status_pending', 'status_cancelled', 'unknown_approval']);
  });

  it('books from the STORED payload, with approval idempotency keys, records and logs it, marks executed; a repeat is a no-op', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await approve(a.id);
    const res = await w.app.approvals!.calendar.executeApproved(a.id);
    expect(res).toEqual({ ok: true, eventIds: ['fake-event-1'] });
    expect(w.calendar.writes).toEqual([
      {
        op: 'create',
        ownerId: w.alex.owner.id,
        eventId: 'fake-event-1',
        idempotencyKey: `approval:${a.id}:0`,
        event: { title: 'Dinner', start: new Date(dinner.start), end: new Date(dinner.end), location: 'Luigi' },
      },
    ]);
    const writes = await w.db.query<{ approval_id: string; event_id: string; idempotency_key: string }>('SELECT approval_id, event_id, idempotency_key FROM calendar_writes');
    expect(writes.rows).toEqual([{ approval_id: a.id, event_id: 'fake-event-1', idempotency_key: `approval:${a.id}:0` }]);
    expect((await w.app.approvals!.get(a.id))!.status).toBe('executed');
    expect(await w.app.approvals!.calendar.executeApproved(a.id)).toEqual({ ok: true, eventIds: ['fake-event-1'] });
    expect(w.calendar.writes).toHaveLength(1);
    expect((await w.actions({ action: 'calendar.event_created' })).length).toBe(1);
  });

  it('a guard that throws, or a provider failure, marks the approval failed with a safe reason and writes nothing', async () => {
    w.app.approvals!.registerKind('guarded', {
      schema: z.object({ n: z.number() }),
      render: () => 'Guarded?',
      calendarEvents: () => [{ title: 'G', start: new Date(dinner.start), end: new Date(dinner.end) }],
      guard: async () => {
        throw new ToolError('the time is no longer free');
      },
    });
    const g = await w.app.approvals!.request(w.alex.agent.id, { kind: 'guarded', payload: { n: 1 } });
    await approve(g.id);
    expect(await w.app.approvals!.calendar.executeApproved(g.id)).toEqual({ ok: false, reason: 'the time is no longer free' });
    expect((await w.app.approvals!.get(g.id))!).toMatchObject({ status: 'failed', error: 'the time is no longer free' });

    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    w.calendar.createEvent = async () => {
      throw new Error('HTTP 500 from googleapis: token=abc');
    };
    await w.ownerSays(w.alex, 'yes #2');
    expect((await w.app.approvals!.get(a.id))!).toMatchObject({ status: 'failed', error: "the calendar didn't accept it" });
    expect(w.lastTo(w.alex.address)).toBe("I couldn't book #2: the calendar didn't accept it.");
    expect(w.calendar.writes).toEqual([]);
    expect((await w.actions({ action: 'approval.failed' })).length).toBe(2);
  });

  it('a multi-event kind that fails halfway undoes the events it created', async () => {
    let n = 0;
    const original = w.calendar.createEvent.bind(w.calendar);
    w.calendar.createEvent = async (...args) => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return original(...args);
    };
    w.app.approvals!.registerKind('pair', {
      schema: z.object({}),
      render: () => 'One and Two?', // the prompt shows every booked title (CalendarWriter checks it)
      calendarEvents: () => [
        { title: 'One', start: new Date(dinner.start), end: new Date(dinner.end) },
        { title: 'Two', start: new Date(dinner.start), end: new Date(dinner.end) },
      ],
    });
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'pair', payload: {} });
    await approve(a.id);
    expect((await w.app.approvals!.calendar.executeApproved(a.id)).ok).toBe(false);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([]);
    expect(w.calendar.writes.map((x) => x.op)).toEqual(['create', 'delete']);
  });

  it('I7 (M4): an event the provider made but reported as failed (lost response) is found by its key and undone', async () => {
    const original = w.calendar.createEvent.bind(w.calendar);
    w.calendar.createEvent = async (...args) => {
      await original(...args);
      throw new Error('timeout after the write');
    };
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await approve(a.id);
    expect((await w.app.approvals!.calendar.executeApproved(a.id)).ok).toBe(false);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([]);
    expect(w.calendar.writes.map((x) => x.op)).toEqual(['create', 'delete']);
    const rows = await w.db.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM calendar_writes WHERE approval_id = $1', [a.id]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.deleted_at).not.toBeNull();
  });

  it('I7 (M4): a crash between createEvent and recording its id leaves an intent row; a retry completes it once', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await approve(a.id);
    // Simulate the crash: the intent row exists, the provider made the event, the id never got stored.
    const key = `approval:${a.id}:0`;
    await w.db.query(`INSERT INTO calendar_writes (id, owner_id, approval_id, event_id, idempotency_key, created_at) VALUES ('cw1', $1, $2, NULL, $3, $4)`, [
      w.alex.owner.id,
      a.id,
      key,
      w.clock.now(),
    ]);
    await w.calendar.createEvent(w.alex.owner.id, { title: 'Dinner', start: new Date(dinner.start), end: new Date(dinner.end) }, key);
    expect(await w.app.approvals!.calendar.executeApproved(a.id)).toEqual({ ok: true, eventIds: ['fake-event-1'] });
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    expect(await w.app.approvals!.calendar.undo(a.id)).toBe(1);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([]);
  });

  it('undo deletes the recorded events once (compensation)', async () => {
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: dinner });
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.eventsOf(w.alex.owner.id)).toHaveLength(1);
    expect(await w.app.approvals!.calendar.undo(a.id)).toBe(1);
    expect(await w.app.approvals!.calendar.undo(a.id)).toBe(0);
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([]);
    expect((await w.actions({ action: 'calendar.event_deleted' })).length).toBe(1);
  });

  it('structural: nothing under src/ calls createEvent( or deleteEvent( except CalendarWriter and the providers', () => {
    const root = join(import.meta.dirname, '../../../src');
    const callers = srcFiles(root)
      .filter((f) => /\b(createEvent|deleteEvent)\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith('google/'));
    expect(callers).toEqual(['approvals/calendarWriter.ts']);
  });
});
