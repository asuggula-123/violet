import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { PermanentTransportError, RetryableTransportError } from '../../../src/transport/types.js';
import type { TestWorld } from '../../helpers/world.js';
import { at, flagsOf, flagsWorld, flagTextsTo, KIRITIMATI, local, now, NY, setZone } from './helpers.js';

describe('urgent flag policy (I17)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  describe('budget', () => {
    it('texts 3 per owner-local day; the 4th becomes a digest item (flag.overflow)', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      for (const t of ['one', 'two', 'three', 'four']) await now(w, w.alex, t);
      expect(flagTextsTo(w, w.alex)).toEqual(['one', 'two', 'three']);
      const flags = await flagsOf(w, w.alex);
      expect(flags.map((f) => [f.text, f.status, f.overflowed_at !== null])).toEqual([
        ['one', 'sent', false],
        ['two', 'sent', false],
        ['three', 'sent', false],
        ['four', 'pending', true],
      ]);
      const [row] = await w.actions({ action: 'flag.overflow' });
      expect(row).toMatchObject({ agent_id: w.alex.agent.id, detail: { reason: 'budget', date: '2026-11-09' } });
    });

    it('resets at local midnight', async () => {
      w = await flagsWorld('2026-11-09T19:00');
      for (const t of ['a', 'b', 'c', 'd']) await now(w, w.alex, t);
      w.clock.set(local(NY, '2026-11-10T07:00'));
      await now(w, w.alex, 'next day');
      expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c', 'next day']);
    });

    it('counts owners separately, each by their own calendar date', async () => {
      w = await flagsWorld('2026-11-09T14:00');
      await setZone(w, w.sam, KIRITIMATI); // 2026-11-10 09:00 there
      for (const t of ['a1', 'a2', 'a3']) await now(w, w.alex, t);
      for (const t of ['s1', 's2', 's3']) await now(w, w.sam, t);
      // 21:00 Nov 9 in New York, 16:00 Nov 10 in Kiritimati: both days used up.
      w.clock.set(local(NY, '2026-11-09T21:00'));
      await now(w, w.alex, 'a4');
      await now(w, w.sam, 's4');
      // 07:30 Nov 10 in New York (a new day), 02:30 Nov 11 in Kiritimati (quiet hours: held).
      w.clock.set(local(NY, '2026-11-10T07:30'));
      await now(w, w.alex, 'a5');
      await now(w, w.sam, 's5');
      expect(flagTextsTo(w, w.alex)).toEqual(['a1', 'a2', 'a3', 'a5']);
      expect(flagTextsTo(w, w.sam)).toEqual(['s1', 's2', 's3']);
      const sam = await flagsOf(w, w.sam);
      expect(sam.map((f) => f.budget_date)).toEqual(['2026-11-10', '2026-11-10', '2026-11-10', null, null]);
      expect(sam[4]!.held_until).toEqual(local(KIRITIMATI, '2026-11-11T07:00'));
    });

    it('concurrent raises never exceed the budget', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => now(w, w.alex, t)));
      expect(flagTextsTo(w, w.alex)).toHaveLength(3);
      expect((await flagsOf(w, w.alex)).filter((f) => f.overflowed_at)).toHaveLength(3);
    });
  });

  describe('quiet hours 22:00-07:00 owner time', () => {
    it('a flag raised at 23:00 is held and texted at 07:00', async () => {
      w = await flagsWorld('2026-11-09T23:00');
      await now(w, w.alex, 'late news');
      expect(flagTextsTo(w, w.alex)).toEqual([]);
      const [held] = await w.actions({ action: 'flag.held' });
      expect(held?.detail).toMatchObject({ until: local(NY, '2026-11-10T07:00').toISOString() });
      await at(w, '2026-11-10T06:59:59');
      expect(flagTextsTo(w, w.alex)).toEqual([]);
      await at(w, '2026-11-10T07:00');
      expect(flagTextsTo(w, w.alex)).toEqual(['late news']);
      expect(await w.actions({ action: 'flag.released' })).toHaveLength(1);
      await at(w, '2026-11-10T08:00');
      expect(flagTextsTo(w, w.alex)).toEqual(['late news']);
    });

    it.each([
      ['2026-11-09T21:59:59', true],
      ['2026-11-09T22:00:00', false],
      ['2026-11-10T06:59:59', false],
      ['2026-11-10T07:00:00', true],
    ])('boundary %s → texted at once: %s', async (wall, texted) => {
      w = await flagsWorld(wall);
      await now(w, w.alex, 'x');
      expect(flagTextsTo(w, w.alex)).toEqual(texted ? ['x'] : []);
    });

    it('releases oldest first within the new day budget; the rest goes to the digest', async () => {
      w = await flagsWorld('2026-11-09T22:30');
      for (const t of ['1', '2', '3', '4', '5']) await now(w, w.alex, t);
      await at(w, '2026-11-10T07:00');
      expect(flagTextsTo(w, w.alex)).toEqual(['1', '2', '3']);
      const over = await w.actions({ action: 'flag.overflow' });
      expect(over.map((r) => r.detail)).toEqual([
        expect.objectContaining({ reason: 'budget', held: true }),
        expect.objectContaining({ reason: 'budget', held: true }),
      ]);
    });

    it('spring forward (23-hour day): held at 23:00 EST, texted at 07:00 EDT', async () => {
      w = await flagsWorld('2027-03-13T23:00');
      await now(w, w.alex, 'dst');
      const [flag] = await flagsOf(w, w.alex);
      expect(flag!.held_until!.toISOString()).toBe('2027-03-14T11:00:00.000Z');
      await at(w, '2027-03-14T06:59');
      expect(flagTextsTo(w, w.alex)).toEqual([]);
      await at(w, '2027-03-14T07:00');
      expect(flagTextsTo(w, w.alex)).toEqual(['dst']);
    });

    it('fall back (25-hour day): held at 23:00 EDT, texted at 07:00 EST', async () => {
      w = await flagsWorld('2026-10-31T23:00');
      await now(w, w.alex, 'dst');
      const [flag] = await flagsOf(w, w.alex);
      expect(flag!.held_until!.toISOString()).toBe('2026-11-01T12:00:00.000Z');
      w.clock.set('2026-11-01T11:30:00Z'); // 06:30 EST
      await w.app.scheduler.runDue();
      expect(flagTextsTo(w, w.alex)).toEqual([]);
      await at(w, '2026-11-01T07:00');
      expect(flagTextsTo(w, w.alex)).toEqual(['dst']);
    });

    it('uses each owner’s own zone', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      await setZone(w, w.sam, 'Asia/Tokyo'); // 00:00 Nov 10 there
      await now(w, w.alex, 'alex');
      await now(w, w.sam, 'sam');
      expect(flagTextsTo(w, w.alex)).toEqual(['alex']);
      expect(flagTextsTo(w, w.sam)).toEqual([]);
    });
  });

  describe('paused agent (I14)', () => {
    it('texts nothing; the flag becomes a digest item', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      await w.ownerSays(w.alex, 'pause');
      await now(w, w.alex, 'while paused');
      expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
      const [flag] = await flagsOf(w, w.alex);
      expect(flag).toMatchObject({ status: 'pending' });
      expect(flag!.overflowed_at).not.toBeNull();
      const [row] = await w.actions({ action: 'flag.overflow' });
      expect(row?.detail).toMatchObject({ reason: 'paused' });
    });

    it('a held flag released while paused becomes a digest item', async () => {
      w = await flagsWorld('2026-11-09T23:00');
      await now(w, w.alex, 'held');
      await w.ownerSays(w.alex, 'pause');
      await at(w, '2026-11-10T07:00');
      expect(flagTextsTo(w, w.alex)).toEqual([]);
      expect((await flagsOf(w, w.alex))[0]!.overflowed_at).not.toBeNull();
    });
  });

  describe('delivery failures (M1 semantics kept)', () => {
    it('a retried raise finishes a failed delivery and never double-texts', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      w.transport.failNext(1);
      await expect(now(w, w.alex, 'retry me', 'k1')).rejects.toThrow();
      expect((await flagsOf(w, w.alex))[0]).toMatchObject({ status: 'pending' });
      await now(w, w.alex, 'retry me', 'k1');
      await now(w, w.alex, 'retry me', 'k1');
      expect(flagTextsTo(w, w.alex)).toEqual(['retry me']);
    });

    it('the release task retries a failed send once the transport is back', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      w.transport.failNext(1);
      await expect(now(w, w.alex, 'later')).rejects.toThrow();
      w.transport.setFailing(true);
      await w.advance({ minutes: 1 });
      w.transport.setFailing(false);
      await w.advance({ minutes: 1 });
      await w.advance({ minutes: 1 });
      expect(flagTextsTo(w, w.alex)).toEqual(['later']);
    });

    it('a retryable transport error rethrows and keeps the budget reservation', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      const send = w.transport.send.bind(w.transport);
      let fail = true;
      w.transport.send = async (m) => {
        if (fail) throw new RetryableTransportError('down', 'network');
        return send(m);
      };
      await expect(now(w, w.alex, 'x')).rejects.toThrow('down');
      expect((await flagsOf(w, w.alex))[0]!.budget_date).toBe('2026-11-09');
      fail = false;
      await w.advance({ minutes: 1 });
      expect(flagTextsTo(w, w.alex)).toEqual(['x']);
    });

    it('a permanent transport error keeps the flag for the digest and frees its budget', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      const send = w.transport.send.bind(w.transport);
      let fail = true;
      w.transport.send = async (m) => {
        if (fail) throw new PermanentTransportError('blocked', 'forbidden');
        return send(m);
      };
      await now(w, w.alex, 'x');
      const [flag] = await flagsOf(w, w.alex);
      expect(flag!.overflowed_at).not.toBeNull();
      expect(flag!.budget_date).toBeNull();
      fail = false;
      for (const t of ['a', 'b', 'c']) await now(w, w.alex, t);
      expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b', 'c']);
    });

    it('a send that crashed after the gateway recorded it is not texted again', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      // The crash: delivered and recorded by the gateway, the flag row never updated.
      const realSend = w.transport.send.bind(w.transport);
      w.transport.send = async (m) => {
        const r = await realSend(m);
        w.transport.send = realSend;
        await w.app.repos.messages.add({ agentId: w.alex.agent.id, thread: 'owner', direction: 'out', body: m.text, purpose: 'flag', transportMessageId: r.transportMessageId });
        throw new Error('crash');
      };
      await expect(now(w, w.alex, 'once')).rejects.toThrow('crash');
      // The rejected flag row says attempt_at = NULL after a plain error; simulate the real
      // crash (no cleanup ran) by restoring the lease the attempt held.
      await w.db.query('UPDATE flags SET attempt_at = $1', [w.clock.now()]);
      await w.advance({ minutes: 5 });
      expect(flagTextsTo(w, w.alex)).toEqual(['once']);
      expect((await flagsOf(w, w.alex))[0]).toMatchObject({ status: 'sent' });
    });
  });

  describe('held flags go first at 07:00', () => {
    it('a fresh flag raised before the release tick waits behind the held ones (oldest first)', async () => {
      w = await flagsWorld('2026-11-09T23:00');
      for (const t of ['h1', 'h2', 'h3']) await now(w, w.alex, t);
      w.clock.set(local(NY, '2026-11-10T07:00:05'));
      await now(w, w.alex, 'fresh');
      // The raise itself released the held flags first; the fresh one is over budget.
      expect(flagTextsTo(w, w.alex)).toEqual(['h1', 'h2', 'h3']);
      await w.app.scheduler.runDue();
      expect(flagTextsTo(w, w.alex)).toEqual(['h1', 'h2', 'h3']);
      const fresh = (await flagsOf(w, w.alex)).at(-1)!;
      expect(fresh.text).toBe('fresh');
      expect(fresh.overflowed_at).not.toBeNull();
    });

    it('with budget left, held flags then the fresh one are texted in order', async () => {
      w = await flagsWorld('2026-11-09T23:00');
      await now(w, w.alex, 'h1');
      w.clock.set(local(NY, '2026-11-10T07:00:01'));
      await now(w, w.alex, 'fresh');
      expect(flagTextsTo(w, w.alex)).toEqual(['h1', 'fresh']);
    });
  });

  describe('retry backoff', () => {
    it('during a transport outage the release task backs off instead of retrying every tick', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      w.transport.setFailing(true);
      await expect(now(w, w.alex, 'outage')).rejects.toThrow();
      for (let i = 0; i < 60; i++) await w.advance({ minutes: 1 });
      const failed = (await w.actions({ action: 'outbound.failed', agentId: w.alex.agent.id })).length;
      // 1 + backoff 1, 2, 4, 8, 15, 15, 15 min within the hour (not one per tick).
      expect(failed).toBeGreaterThan(3);
      expect(failed).toBeLessThanOrEqual(10);
      w.transport.setFailing(false);
      for (let i = 0; i < 15; i++) await w.advance({ minutes: 1 });
      expect(flagTextsTo(w, w.alex)).toEqual(['outage']);
    });

    it('a retried raise is not held back by the backoff, and the transport retryAfterMs is honored by the release task', async () => {
      w = await flagsWorld('2026-11-09T10:00');
      const send = w.transport.send.bind(w.transport);
      let fail = true;
      w.transport.send = async (m) => {
        if (fail) throw new RetryableTransportError('slow down', 'rate_limited', 10 * 60_000);
        return send(m);
      };
      await expect(now(w, w.alex, 'a', 'ka')).rejects.toThrow();
      fail = false;
      await w.advance({ minutes: 5 });
      expect(flagTextsTo(w, w.alex)).toEqual([]);
      await w.advance({ minutes: 5 });
      expect(flagTextsTo(w, w.alex)).toEqual(['a']);
      fail = true;
      await expect(now(w, w.alex, 'b', 'kb')).rejects.toThrow();
      fail = false;
      await now(w, w.alex, 'b', 'kb');
      expect(flagTextsTo(w, w.alex)).toEqual(['a', 'b']);
    });
  });
});
