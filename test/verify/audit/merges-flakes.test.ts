/**
 * Audit evidence: integration merges and the two tests that failed once under load.
 *
 * Flake 1 (test/verify/m5/round1.test.ts "two apps on one database releasing the same held
 * flags"): the policy keeps the budget and never texts a flag twice, but "oldest first"
 * (8.5: `flags.release` texts due held flags oldest first) holds only for ONE releaser.
 * Two releasers that overlap (even inside one process: a 'now' flag raised by a job at
 * 07:00 runs releaseHeld while the scheduler's flags.release runs) each skip a flag whose
 * send lease another holds and claim the next one, so the sends race and the transport can
 * receive #2 before #1. The test below makes the race deterministic by holding the send of
 * '1' until '2' has gone out (or 2 s pass, if the code had serialized the sends).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OutboundMessage } from '../../../src/transport/types.js';
import type { TestWorld } from '../../helpers/world.js';
import { flagsOf, flagsWorld, flagTextsTo, local, now, NY } from '../../unit/flags/helpers.js';

describe('audit merges-flakes: held flag release order under concurrency (one app)', () => {
  let w: TestWorld;
  afterEach(async () => {
    await w.close();
  });

  it('a raise at 07:00 racing the release tick: budget kept, but held flags reach the owner out of order', async () => {
    w = await flagsWorld('2026-11-09T23:00');
    for (const t of ['1', '2', '3']) await now(w, w.alex, t);
    expect(flagTextsTo(w, w.alex)).toEqual([]);

    // Gate: the send of '1' waits until '2' has been sent (bounded, so a serialized
    // implementation simply sends 1 then 2 after the timeout).
    const transport = w.transport;
    const original = transport.send.bind(transport);
    transport.send = async (msg: OutboundMessage) => {
      if (msg.purpose === 'flag' && msg.text === '1') {
        const deadline = Date.now() + 2_000;
        while (!transport.sent.some((m) => m.text === '2') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      }
      return original(msg);
    };

    w.clock.set(local(NY, '2026-11-10T07:00'));
    // One process: the scheduler tick (flags.release) and a job raising a fresh 'now' flag
    // (e.g. the Google token store's reconnect flag inside a Brain turn) at the same time.
    await Promise.all([w.app.scheduler.runDue(), now(w, w.alex, 'fresh')]);

    // What holds: three texts, each once, the fresh one became a digest item.
    expect([...flagTextsTo(w, w.alex)].sort()).toEqual(['1', '2', '3']);
    const flags = await flagsOf(w, w.alex);
    expect(flags.filter((f) => f.overflowed_at).map((f) => f.text)).toEqual(['fresh']);
    // What the contract claims (8.5 "oldest first") and the m5 test asserts: fails.
    expect(flagTextsTo(w, w.alex)).toEqual(['1', '2', '3']);
  });
});
