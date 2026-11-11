import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import type { OutboundGateway } from '../../../src/core/outbound.js';
import { createDigestService } from '../../../src/flags/digest.js';
import { flagsModule } from '../../../src/flags/module.js';
import { addDays } from '../../../src/flags/time.js';
import type { TestWorld } from '../../helpers/world.js';
import { at, digestsTo, flagsOf, flagsWorld, later, local, NY } from './helpers.js';

/**
 * Digest exactly-once under retries, crashes and concurrent workers. With
 * TEST_DATABASE_URL these run on real Postgres, where the two apps use separate
 * pooled connections and really interleave.
 */
describe('digest under crashes and races', () => {
  let w: TestWorld;
  let other: App | null = null;
  afterEach(async () => {
    await other?.stop();
    other = null;
    await w.close();
  });

  it('a crash between claim and send: the stored body goes out once, after the lease', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    await later(w, w.alex, 'one');
    // A worker that dies inside the send: its gateway never returns.
    const hung: OutboundGateway = { sendToOwner: () => new Promise(() => undefined), sendCanned: async () => undefined };
    const crashed = createDigestService({ db: w.db, clock: w.clock, gateway: hung, actionLog: w.app.actionLog, log: w.app.deps.log });
    w.clock.set(local(NY, '2026-11-09T18:00'));
    void crashed.runDue(w.clock.now());
    for (let i = 0; i < 200; i++) {
      const rows = await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM flags WHERE digest_id IS NOT NULL`);
      if (rows.rows[0]!.n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [stored] = (await w.db.query<{ body: string }>('SELECT body FROM digests WHERE agent_id = $1', [w.alex.agent.id])).rows;
    expect(stored?.body).toBe('Today:\nMessages taken\n- one');
    await later(w, w.alex, 'two');
    await at(w, '2026-11-09T18:01'); // lease still held by the dead worker
    expect(digestsTo(w, w.alex)).toEqual([]);
    await at(w, '2026-11-09T18:03');
    await at(w, '2026-11-09T18:10');
    expect(digestsTo(w, w.alex)).toEqual([stored!.body]);
    await at(w, '2026-11-10T18:00');
    expect(digestsTo(w, w.alex)).toEqual([stored!.body, 'Today:\nMessages taken\n- two']);
  });

  it('two apps on the same database racing: one digest per date, every item in exactly one', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    other = await buildApp(w.app.deps, [flagsModule]);
    const apps = [w.app, other];
    let date = '2026-11-09';
    let n = 0;
    for (let day = 0; day < 4; day++) {
      for (let i = 0; i < 3; i++) await later(w, w.alex, `item ${++n}`);
      w.clock.set(local(NY, `${date}T18:00`));
      const raises = day < 3 ? [1, 2, 3].map(() => later(w, w.alex, `item ${++n}`)) : [];
      await Promise.all([...apps.flatMap((a) => [a.digest!.runDue(w.clock.now()), a.digest!.runDue(w.clock.now())]), ...raises]);
      date = addDays(date, 1);
    }
    w.clock.set(local(NY, `${date}T18:00`));
    await Promise.all(apps.map((a) => a.digest!.runDue(w.clock.now())));

    const sent = digestsTo(w, w.alex);
    // Four dates always have items; a fifth only if the last racing raises missed their date.
    expect(sent.length === 4 || sent.length === 5).toBe(true);
    const lines = sent.flatMap((b) => b.split('\n').filter((l) => l.startsWith('- ')));
    expect(lines.sort()).toEqual(Array.from({ length: n }, (_, i) => `- item ${i + 1}`).sort());
    const dates = await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM digests WHERE agent_id = $1 AND status = 'sent'`, [w.alex.agent.id]);
    expect(dates.rows[0]!.n).toBe(sent.length);
    expect(new Set(sent).size).toBe(sent.length);
    expect((await flagsOf(w, w.alex)).every((f) => f.status === 'sent' && f.digest_id)).toBe(true);
    expect(await w.actions({ action: 'digest.sent', agentId: w.alex.agent.id })).toHaveLength(sent.length);
  });
});
