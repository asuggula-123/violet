/**
 * R8 (8.5 'oldest first'): held flags are texted strictly in order even when two releasers
 * overlap (two apps on one database, or a raise racing the release tick). A released flag waits
 * while an older one is still due or being sent. The budget and once-only still hold.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import { flagsModule } from '../../../src/flags/module.js';
import type { OutboundMessage } from '../../../src/transport/types.js';
import type { TestWorld } from '../../helpers/world.js';
import { flagsOf, flagsWorld, flagTextsTo, local, now, NY } from '../flags/helpers.js';

let w: TestWorld;
let other: App | null = null;
afterEach(async () => {
  await other?.stop();
  other = null;
  await w.close();
});

/** Holds the send of `slow` until `next` has been sent, or 1.5 s pass (the stand-in for network latency). */
function slowSend(t: TestWorld, slow: string, next: string): void {
  const send = t.transport.send.bind(t.transport);
  t.transport.send = async (msg: OutboundMessage) => {
    if (msg.purpose === 'flag' && msg.text === slow) {
      const until = Date.now() + 1_500;
      while (!t.transport.sent.some((m) => m.text === next) && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    }
    return send(msg);
  };
}

describe('R8: held flags go out oldest first', () => {
  it('two apps releasing at 07:00 while the first send is slow: 1, 2, 3 in order; 4 and 5 become digest items', async () => {
    w = await flagsWorld('2026-11-09T23:00');
    other = await buildApp(w.app.deps, [flagsModule]);
    for (const t of ['1', '2', '3', '4', '5']) await now(w, w.alex, t);
    slowSend(w, '1', '2');
    w.clock.set(local(NY, '2026-11-10T07:00'));
    await Promise.all([w.app.scheduler.runDue(), other.scheduler.runDue()]);
    expect(flagTextsTo(w, w.alex)).toEqual(['1', '2', '3']);
    expect((await flagsOf(w, w.alex)).filter((f) => f.overflowed_at).map((f) => f.text)).toEqual(['4', '5']);
  });

  it('a slow second send: the releaser that holds 2 texts 3 after it, never before', async () => {
    w = await flagsWorld('2026-11-09T23:00');
    other = await buildApp(w.app.deps, [flagsModule]);
    for (const t of ['1', '2', '3']) await now(w, w.alex, t);
    slowSend(w, '2', '3');
    w.clock.set(local(NY, '2026-11-10T07:00'));
    await Promise.all([w.app.scheduler.runDue(), other.scheduler.runDue(), now(w, w.alex, 'fresh')]);
    expect(flagTextsTo(w, w.alex)).toEqual(['1', '2', '3']);
    expect((await flagsOf(w, w.alex)).filter((f) => f.overflowed_at).map((f) => f.text)).toEqual(['fresh']);
  });
});
