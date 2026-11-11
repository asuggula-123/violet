/**
 * Independent verifier, M5 round 1. Adversarial tests for the urgent-flag policy (I17),
 * the daily digest (8.5, I13, I14) and the proactive conflict check.
 * Tests that currently fail are kept as evidence of findings.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App, type Module } from '../../../src/app.js';
import type { FlagService } from '../../../src/core/flags.js';
import type { DigestService } from '../../../src/core/later.js';
import { flagsModule } from '../../../src/flags/module.js';
import { defaultModules } from '../../../src/modules.js';
import { RetryableTransportError } from '../../../src/transport/types.js';
import type { TestWorld } from '../../helpers/world.js';
import { at, digestsTo, flagsOf, flagsWorld, flagTextsTo, KIRITIMATI, later, local, now, NY, setZone } from '../../unit/flags/helpers.js';

const TITLES = ['Messages taken', 'Agent conversations', 'Drafts', 'Booked', 'Waiting for you', 'Also'];

function digestOf(w: TestWorld): DigestService {
  if (!w.app.digest) throw new Error('flagsModule not installed');
  return w.app.digest;
}

/** Every line of a digest is the header, a known title, a '- ' item, or a count line. */
function assertStructure(body: string): void {
  const lines = body.split('\n');
  expect(lines[0]).toBe('Today:');
  expect(lines.filter((l) => l === 'Today:')).toHaveLength(1);
  for (const line of lines.slice(1)) {
    const ok = TITLES.includes(line) || line.startsWith('- ') || /^\+\d+ more( not shown)?$/.test(line);
    expect(ok, `unexpected line ${JSON.stringify(line)}`).toBe(true);
    expect(line).not.toMatch(/^#\d/);
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
}

async function digestRows(w: TestWorld, agentId: string) {
  const res = await w.db.query<{ local_date: string; status: string; body: string | null }>(
    'SELECT local_date::text AS local_date, status, body FROM digests WHERE agent_id = $1 ORDER BY local_date',
    [agentId],
  );
  return res.rows;
}

describe('M5 verify r1: wiring', () => {
  it('defaultModules installs flagsModule after googleModule (the token store shares the policy)', () => {
    const names = defaultModules.map((m) => m.name);
    expect(names).toContain('flags');
    expect(names.indexOf('flags')).toBeGreaterThan(names.findIndex((n) => /google/.test(n)));
  });

});

describe('M5 verify r1: flag policy (I17)', () => {
  let w: TestWorld;
  let other: App | null = null;
  afterEach(async () => {
    await other?.stop();
    other = null;
    await w.close();
  });

  it('a FlagService captured by a module installed BEFORE flagsModule obeys the budget and quiet hours', async () => {
    let captured: FlagService | null = null;
    const early: Module = {
      name: 'early',
      install(app) {
        const f = app.flags;
        captured = { raise: (a, x) => f.raise(a, x) };
      },
    };
    w = await flagsWorld('2026-11-09T10:00', { modules: [early, flagsModule] });
    for (const t of ['c1', 'c2', 'c3', 'c4']) await captured!.raise(w.alex.agent.id, { kind: 'google.revoked', urgency: 'now', text: t });
    expect(flagTextsTo(w, w.alex)).toEqual(['c1', 'c2', 'c3']);
    w.clock.set(local(NY, '2026-11-09T23:00'));
    await captured!.raise(w.sam.agent.id, { kind: 'google.revoked', urgency: 'now', text: 'night' });
    expect(flagTextsTo(w, w.sam)).toEqual([]);
  });

  it('held flags are texted oldest first at 07:00 even when a fresh flag is raised before the release tick', async () => {
    w = await flagsWorld('2026-11-09T23:00');
    for (const t of ['h1', 'h2', 'h3']) await now(w, w.alex, t);
    // 07:00:05: a fresh urgent flag arrives before the scheduler has ticked.
    w.clock.set(local(NY, '2026-11-10T07:00:05'));
    await now(w, w.alex, 'fresh');
    await w.app.scheduler.runDue();
    await w.app.settle();
    // Contract: held flags are released "oldest first, within that new day's budget".
    expect(flagTextsTo(w, w.alex)).toEqual(['h1', 'h2', 'h3']);
  });

  it('fall-back day (25 h): budget is one local date across both 01:xx hours and the evening', async () => {
    w = await flagsWorld('2026-11-01T07:00');
    for (const t of ['a', 'b', 'c']) await now(w, w.alex, t);
    w.clock.set(local(NY, '2026-11-01T21:59:59'));
    await now(w, w.alex, 'd');
    expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c']);
    expect((await flagsOf(w, w.alex)).at(-1)!.overflowed_at).not.toBeNull();
    w.clock.set(local(NY, '2026-11-02T07:00'));
    await now(w, w.alex, 'e');
    expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('spring-forward day (23 h): budget and quiet start at 22:00 EDT', async () => {
    w = await flagsWorld('2027-03-14T07:00');
    for (const t of ['a', 'b']) await now(w, w.alex, t);
    w.clock.set(local(NY, '2027-03-14T21:59:59'));
    await now(w, w.alex, 'c');
    w.clock.set(local(NY, '2027-03-14T22:00:00'));
    await now(w, w.alex, 'held');
    expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c']);
    const held = (await flagsOf(w, w.alex)).at(-1)!;
    expect(held.held_until!.toISOString()).toBe('2027-03-15T11:00:00.000Z');
  });

  it('half-hour zone (Asia/Kolkata): quiet hours start at 22:00 local, not UTC hour boundaries', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    await setZone(w, w.sam, 'Asia/Kolkata');
    w.clock.set(local('Asia/Kolkata', '2026-11-10T21:59:59'));
    await now(w, w.sam, 'before');
    w.clock.set(local('Asia/Kolkata', '2026-11-10T22:00:00'));
    await now(w, w.sam, 'after');
    expect(flagTextsTo(w, w.sam)).toEqual(['before']);
    const held = (await flagsOf(w, w.sam)).at(-1)!;
    expect(held.held_until).toEqual(local('Asia/Kolkata', '2026-11-11T07:00'));
  });

  it('household spanning the date line (Honolulu and Kiritimati): budgets counted per owner-local date', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    await setZone(w, w.alex, 'Pacific/Honolulu');
    await setZone(w, w.sam, KIRITIMATI);
    // Same instant: 08:00 Nov 9 in Honolulu, 08:00 Nov 10 in Kiritimati.
    w.clock.set(local('Pacific/Honolulu', '2026-11-09T08:00'));
    for (const t of ['a1', 'a2', 'a3', 'a4']) await now(w, w.alex, t);
    for (const t of ['s1', 's2', 's3', 's4']) await now(w, w.sam, t);
    expect(flagTextsTo(w, w.alex)).toEqual(['a1', 'a2', 'a3']);
    expect(flagTextsTo(w, w.sam)).toEqual(['s1', 's2', 's3']);
    const a = await flagsOf(w, w.alex);
    const s = await flagsOf(w, w.sam);
    expect(a[0]!.budget_date).toBe('2026-11-09');
    expect(s[0]!.budget_date).toBe('2026-11-10');
    // 21:00 Honolulu Nov 9 = 21:00 Kiritimati Nov 10: still the same days for both.
    w.clock.set(local('Pacific/Honolulu', '2026-11-09T21:00'));
    await now(w, w.alex, 'a5');
    await now(w, w.sam, 's5');
    expect(flagTextsTo(w, w.alex)).toHaveLength(3);
    expect(flagTextsTo(w, w.sam)).toHaveLength(3);
  });

  it('a retried raise across the quiet-hours boundary: held, then texted once at 07:00', async () => {
    w = await flagsWorld('2026-11-09T21:59:00');
    w.transport.failNext(1);
    await expect(now(w, w.alex, 'k', 'key-1')).rejects.toThrow();
    w.clock.set(local(NY, '2026-11-09T22:00:30'));
    await now(w, w.alex, 'k', 'key-1');
    await now(w, w.alex, 'k', 'key-1');
    expect(flagTextsTo(w, w.alex)).toEqual([]);
    await at(w, '2026-11-09T23:00');
    await at(w, '2026-11-10T03:00');
    expect(flagTextsTo(w, w.alex)).toEqual([]);
    await at(w, '2026-11-10T07:00');
    await at(w, '2026-11-10T07:05');
    await now(w, w.alex, 'k', 'key-1');
    expect(flagTextsTo(w, w.alex)).toEqual(['k']);
  });

  it('a raise retried with the dedupeKey of a flag that became a digest item never texts it', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    for (const t of ['a', 'b', 'c']) await now(w, w.alex, t);
    await now(w, w.alex, 'over', 'over-key');
    w.clock.set(local(NY, '2026-11-10T09:00'));
    await now(w, w.alex, 'over', 'over-key');
    await at(w, '2026-11-10T09:01');
    expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c']);
  });

  it('paused: a flag raised in quiet hours and the owner resuming before 07:00 → nothing texted at 07:00, it is in the digest', async () => {
    w = await flagsWorld('2026-11-09T21:00');
    await w.ownerSays(w.alex, 'pause');
    w.clock.set(local(NY, '2026-11-09T23:00'));
    await now(w, w.alex, 'while paused at night');
    w.clock.set(local(NY, '2026-11-10T06:00'));
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-10T07:00');
    expect(flagTextsTo(w, w.alex)).toEqual([]);
    await at(w, '2026-11-10T18:00');
    expect(digestsTo(w, w.alex)).toEqual(['Today:\nAlso\n- while paused at night']);
  });

  it('two apps on one database releasing the same held flags: budget kept, nothing texted twice', async () => {
    w = await flagsWorld('2026-11-09T23:00');
    other = await buildApp(w.app.deps, [flagsModule]);
    for (const t of ['1', '2', '3', '4', '5']) await now(w, w.alex, t);
    w.clock.set(local(NY, '2026-11-10T07:00'));
    await Promise.all([w.app.scheduler.runDue(), other.scheduler.runDue(), w.app.scheduler.runDue(), other.scheduler.runDue()]);
    expect(flagTextsTo(w, w.alex)).toEqual(['1', '2', '3']);
    const flags = await flagsOf(w, w.alex);
    expect(flags.filter((f) => f.overflowed_at).map((f) => f.text)).toEqual(['4', '5']);
  });

  it('two apps raising the same dedupeKey concurrently: one text', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    other = await buildApp(w.app.deps, [flagsModule]);
    const f = { kind: 'calendar_conflict', urgency: 'now' as const, text: 'once', dedupeKey: 'same' };
    await Promise.all([w.app.flags.raise(w.alex.agent.id, f), other.flags.raise(w.alex.agent.id, f), w.app.flags.raise(w.alex.agent.id, f)]);
    expect(flagTextsTo(w, w.alex)).toEqual(['once']);
  });
});

describe('M5 verify r1: digest exactly-once and catch-up', () => {
  let w: TestWorld;
  let other: App | null = null;
  afterEach(async () => {
    await other?.stop();
    other = null;
    await w.close();
  });

  it('send failing from 18:00 into quiet hours: never sent in quiet hours, items roll into the next day exactly once', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    await later(w, w.alex, 'one');
    w.transport.setFailing(true);
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-09T21:00');
    const stored = (await digestRows(w, w.alex.agent.id))[0]!.body;
    w.transport.setFailing(false);
    await at(w, '2026-11-09T22:30');
    await at(w, '2026-11-10T00:30');
    await at(w, '2026-11-10T06:30');
    expect(digestsTo(w, w.alex)).toEqual([]);
    await later(w, w.alex, 'two');
    await at(w, '2026-11-10T07:30');
    await at(w, '2026-11-10T18:00');
    await at(w, '2026-11-10T19:00');
    const sent = digestsTo(w, w.alex);
    expect(sent).toEqual(['Today:\nMessages taken\n- one\n- two']);
    expect(stored).toBe('Today:\nMessages taken\n- one');
    expect((await digestRows(w, w.alex.agent.id)).map((r) => r.status)).toEqual(['rolled_over', 'sent']);
  });

  it('a transient failure re-sends the identical stored body even after new items and live lines changed', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    let live = ['#1 first'];
    digestOf(w).addSection({ key: 'waiting', title: 'Waiting for you', order: 50, lines: async () => live });
    await later(w, w.alex, 'one');
    w.transport.failNext(1);
    await at(w, '2026-11-09T18:00');
    live = ['#2 changed'];
    await later(w, w.alex, 'two');
    await at(w, '2026-11-09T18:01');
    await at(w, '2026-11-09T18:02');
    expect(digestsTo(w, w.alex)).toEqual(['Today:\nMessages taken\n- one\nWaiting for you\n- #1 first']);
  });

  it('paused between the build and the send: nothing texted while paused, same body after resume the same date', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    await later(w, w.alex, 'one');
    w.transport.failNext(1);
    await at(w, '2026-11-09T18:00');
    w.clock.set(local(NY, '2026-11-09T18:10'));
    await w.ownerSays(w.alex, 'pause');
    await at(w, '2026-11-09T18:20');
    await at(w, '2026-11-09T19:00');
    expect(digestsTo(w, w.alex)).toEqual([]);
    w.clock.set(local(NY, '2026-11-09T20:00'));
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-09T20:01');
    expect(digestsTo(w, w.alex)).toEqual(['Today:\nMessages taken\n- one']);
    await at(w, '2026-11-10T18:00');
    expect(digestsTo(w, w.alex)).toHaveLength(1);
  });

  it('paused all day: no digest, nothing lost; first digest after resume (next day) has every item once', async () => {
    w = await flagsWorld('2026-11-09T09:00');
    await w.ownerSays(w.alex, 'pause');
    await later(w, w.alex, 'd1');
    await now(w, w.alex, 'n1');
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-09T21:59');
    await at(w, '2026-11-10T10:00');
    await later(w, w.alex, 'd2');
    w.clock.set(local(NY, '2026-11-10T11:00'));
    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-10T18:00');
    expect(digestsTo(w, w.alex)).toEqual(['Today:\nMessages taken\n- d1\n- d2\nAlso\n- n1']);
    expect(w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose !== 'ack')).toHaveLength(1);
  });

  it('two apps racing while the transport fails intermittently: one digest body per date, each item delivered once', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    other = await buildApp(w.app.deps, [flagsModule]);
    for (let i = 1; i <= 4; i++) await later(w, w.alex, `i${i}`);
    w.transport.failNext(3);
    w.clock.set(local(NY, '2026-11-09T18:00'));
    for (let k = 0; k < 6; k++) {
      await Promise.all([w.app.digest!.runDue(w.clock.now()), other.digest!.runDue(w.clock.now()), w.app.digest!.runDue(w.clock.now())]);
      w.clock.advance({ minutes: 3 });
    }
    const sent = digestsTo(w, w.alex);
    expect(sent).toEqual(['Today:\nMessages taken\n- i1\n- i2\n- i3\n- i4']);
    const rows = await digestRows(w, w.alex.agent.id);
    expect(rows).toHaveLength(1);
    expect(await w.actions({ action: 'digest.sent', agentId: w.alex.agent.id })).toHaveLength(1);
  });

  it('a live section that never resolves does not block other agents’ digests', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    let first = 1;
    digestOf(w).addSection({
      key: 'slow',
      title: 'Waiting for you',
      order: 50,
      // The first agent visited hangs (agent order is by created_at, then a random id).
      lines: () => (first-- > 0 ? new Promise<string[]>(() => undefined) : Promise.resolve([])),
    });
    await later(w, w.sam, 'for sam');
    await later(w, w.alex, 'for alex');
    w.clock.set(local(NY, '2026-11-09T18:00'));
    void digestOf(w).runDue(w.clock.now());
    await new Promise((r) => setTimeout(r, 500));
    // One of the two owners still gets a digest: a hung live section must not stall the others.
    expect(digestsTo(w, w.sam).length + digestsTo(w, w.alex).length).toBe(1);
  });

  it('preview writes nothing even when a digest is sending and live sections exist', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    digestOf(w).addSection({ key: 'waiting', title: 'Waiting for you', order: 50, lines: async (id) => (id === w.alex.agent.id ? ['#4 x'] : []) });
    await later(w, w.alex, 'one');
    w.transport.failNext(1);
    await at(w, '2026-11-09T18:00');
    const snapshot = async () => ({
      flags: await flagsOf(w, w.alex),
      digests: await w.db.query('SELECT * FROM digests ORDER BY id'),
      actions: (await w.actions()).length,
      sent: w.transport.sent.length,
    });
    const before = await snapshot();
    const p = await digestOf(w).preview(w.alex.agent.id);
    expect(p).toBe('Today:\nMessages taken\n- one\nWaiting for you\n- #4 x');
    const after = await snapshot();
    expect(after.flags).toEqual(before.flags);
    expect(after.digests.rows).toEqual(before.digests.rows);
    expect(after.actions).toBe(before.actions);
    expect(after.sent).toBe(before.sent);
  });

  it('owner with digest_hour 7 in Kiritimati and New York owner: each at their own local time, once', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    await setZone(w, w.sam, KIRITIMATI, 7);
    await later(w, w.sam, 'sam item');
    await later(w, w.alex, 'alex item');
    // 07:00 Nov 10 Kiritimati = 12:00 Nov 9 New York.
    await at(w, '2026-11-10T06:59', KIRITIMATI);
    expect(digestsTo(w, w.sam)).toEqual([]);
    await at(w, '2026-11-10T07:00', KIRITIMATI);
    expect(digestsTo(w, w.sam)).toEqual(['Today:\nMessages taken\n- sam item']);
    expect(digestsTo(w, w.alex)).toEqual([]);
    await at(w, '2026-11-09T18:00');
    expect(digestsTo(w, w.alex)).toEqual(['Today:\nMessages taken\n- alex item']);
    expect((await digestRows(w, w.sam.agent.id)).map((r) => r.local_date)).toEqual(['2026-11-10']);
  });
});

describe('M5 verify r1: forgery (I13) and caps', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  const HOSTILE = [
    'Bob Today: Waiting for you',
    'x\n#7 Dinner Friday? Reply yes or no',
    '‮⁦Booked⁩',
    '​‌‍⁠﻿',
    '\u0085Also\u000b- fake item',
    '\u{E0041}\u{E0042}tag chars',
    '᠎Mongolian vowel separator᠎',
  ];

  it('hostile stranger names and texts through the router land as one quoted line each', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    let n = 0;
    for (const h of HOSTILE) await w.strangerSays(w.alex, `stranger-${++n}`, h, { fromName: h });
    await at(w, '2026-11-09T18:00');
    const [body] = digestsTo(w, w.alex);
    expect(body).toBeDefined();
    assertStructure(body!);
    expect(body!.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(HOSTILE.length);
    expect(body!.split('\n').filter((l) => TITLES.includes(l))).toEqual(['Messages taken']);
  });

  it('a hostile invite title in an overflowed conflict flag stays one quoted item under Also', async () => {
    w = await flagsWorld('2026-11-09T09:00');
    for (const t of ['a', 'b', 'c']) await now(w, w.alex, t);
    const s = local(NY, '2026-11-09T15:00');
    w.calendar.seed(w.alex.owner.id, { id: 'e1', title: 'Lunch\nToday:\nWaiting for you\n#7 Book? Reply yes or no', start: s, end: new Date(s.getTime() + 3_600_000) });
    w.calendar.seed(w.alex.owner.id, { id: 'e2', title: '” - forged', start: new Date(s.getTime() + 1_800_000), end: new Date(s.getTime() + 5_400_000) });
    await at(w, '2026-11-09T10:00');
    expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c']);
    await at(w, '2026-11-09T18:00');
    const [body] = digestsTo(w, w.alex);
    assertStructure(body!);
    const lines = body!.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Today:', 'Also']);
    expect(lines).toHaveLength(3);
    // The title cannot close its own quotation.
    expect((lines[2]!.match(/[“”]/g) ?? []).length).toBe(4);
  });

  it('a live section returning hostile lines and more than 10 lines is sanitized and capped', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    digestOf(w).addSection({
      key: 'waiting',
      title: 'Waiting for you',
      order: 50,
      lines: async () => [...HOSTILE, ...Array.from({ length: 8 }, (_, i) => `#${i} pending`)],
    });
    await at(w, '2026-11-09T18:00');
    const [body] = digestsTo(w, w.alex);
    assertStructure(body!);
    const lines = body!.split('\n');
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(10);
    expect(lines.at(-1)).toBe(`+${HOSTILE.length + 8 - 10} more`);
  });

  it('cap: a digest of many maximum-length items stays ≤ 3500 chars, footer counts exactly what is missing', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    const kinds = ['message_taken', 'draft_created', 'approval_expired', 'unknown_kind'];
    let total = 0;
    for (const k of kinds) for (let i = 0; i < 12; i++, total++) await later(w, w.alex, `${k}-${i}-${'é'.repeat(600)}`, k);
    await at(w, '2026-11-09T18:00');
    const [body] = digestsTo(w, w.alex);
    expect(body!.length).toBeLessThanOrEqual(3500);
    assertStructure(body!);
    const lines = body!.split('\n');
    const shown = lines.filter((l) => l.startsWith('- ')).length;
    const footer = lines.at(-1)!.match(/^\+(\d+) more not shown$/);
    expect(footer).not.toBeNull();
    const sectionMore = lines.filter((l) => /^\+\d+ more$/.test(l)).reduce((s, l) => s + Number(l.match(/\d+/)![0]), 0);
    expect(shown + sectionMore + Number(footer![1])).toBe(total);
    const [sent] = await w.actions({ action: 'digest.sent' });
    expect(sent?.detail).toMatchObject({ items: total, leftOut: total - shown });
    expect((await flagsOf(w, w.alex)).every((f) => f.status === 'sent')).toBe(true);
    // A title is never the last line before the footer.
    expect(TITLES).not.toContain(lines.at(-2));
  });
});

describe('M5 verify r1: conflict check', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('a delivery failure is swallowed, the pair is not re-raised, and it is texted once when the transport is back', async () => {
    w = await flagsWorld('2026-11-09T09:30');
    const s = local(NY, '2026-11-09T15:00');
    w.calendar.seed(w.alex.owner.id, { id: 'a', title: 'A', start: s, end: new Date(s.getTime() + 3_600_000) });
    w.calendar.seed(w.alex.owner.id, { id: 'b', title: 'B', start: s, end: new Date(s.getTime() + 3_600_000) });
    const send = w.transport.send.bind(w.transport);
    let fail = true;
    w.transport.send = async (m) => {
      if (fail) throw new RetryableTransportError('down', 'network');
      return send(m);
    };
    await at(w, '2026-11-09T10:00');
    expect(await w.actions({ action: 'scheduler.failed' })).toEqual([]);
    await at(w, '2026-11-09T11:00');
    fail = false;
    await at(w, '2026-11-09T11:01');
    await at(w, '2026-11-09T12:00');
    expect(flagTextsTo(w, w.alex)).toEqual(['Conflict today: “A” 3:00-4:00 PM overlaps “B” 3:00-4:00 PM.']);
    expect(await flagsOf(w, w.alex)).toHaveLength(1);
  });

  it('a provider that throws a non-Error value or returns garbage never fails the scheduler', async () => {
    w = await flagsWorld('2026-11-09T09:30');
    w.calendar.listEvents = async () => {
      throw 'string failure';
    };
    await at(w, '2026-11-09T10:00');
    w.calendar.listEvents = async () => null as unknown as [];
    await at(w, '2026-11-09T11:00');
    expect(await w.actions({ action: 'scheduler.failed' })).toEqual([]);
    expect(await flagsOf(w, w.alex)).toEqual([]);
  });

  it('event details reach only the owner’s own thread: no action_log row, no other owner', async () => {
    w = await flagsWorld('2026-11-09T09:30');
    const s = local(NY, '2026-11-09T15:00');
    w.calendar.seed(w.alex.owner.id, { id: 'a', title: 'SecretTitleAlpha', start: s, end: new Date(s.getTime() + 3_600_000) });
    w.calendar.seed(w.alex.owner.id, { id: 'b', title: 'SecretTitleBeta', start: s, end: new Date(s.getTime() + 3_600_000) });
    for (const t of ['x', 'y', 'z']) await now(w, w.sam, t);
    await at(w, '2026-11-09T10:00');
    expect(w.transport.sent.filter((m) => m.text.includes('SecretTitle')).map((m) => m.toAddress)).toEqual(['alex-phone']);
    const rows = await w.actions();
    expect(rows.filter((r) => JSON.stringify(r.detail).includes('SecretTitle'))).toEqual([]);
  });

  it('Kiritimati owner: day words follow the owner’s date, not the server’s', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    await setZone(w, w.alex, KIRITIMATI);
    // now = 10:00 Nov 9 NY = 05:00 Nov 10 Kiritimati (quiet; delivery at 07:00 Nov 10 there).
    const s = local(KIRITIMATI, '2026-11-10T15:00');
    w.calendar.seed(w.alex.owner.id, { id: 'a', title: 'A', start: s, end: new Date(s.getTime() + 3_600_000) });
    w.calendar.seed(w.alex.owner.id, { id: 'b', title: 'B', start: new Date(s.getTime() + 1_800_000), end: new Date(s.getTime() + 3_600_000) });
    await at(w, '2026-11-09T10:00');
    await at(w, '2026-11-10T07:00', KIRITIMATI);
    expect(flagTextsTo(w, w.alex)).toEqual(['Conflict today: “A” 3:00-4:00 PM overlaps “B” 3:30-4:00 PM.']);
  });

  it('an event spanning midnight: one line, both day words right', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    w.calendar.seed(w.alex.owner.id, { id: 'a', title: 'Night shift', start: local(NY, '2026-11-09T20:00'), end: local(NY, '2026-11-10T02:00') });
    w.calendar.seed(w.alex.owner.id, { id: 'b', title: 'Early call', start: local(NY, '2026-11-10T01:00'), end: local(NY, '2026-11-10T01:30') });
    await at(w, '2026-11-09T12:00');
    const [t] = flagTextsTo(w, w.alex);
    expect(t).toBeDefined();
    expect(t!.split('\n')).toHaveLength(1);
    expect(t).toContain('“Early call” tomorrow 1:00-1:30 AM');
  });
});
