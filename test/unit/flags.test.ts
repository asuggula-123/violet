import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

/**
 * The bare M1 FlagService ('now' = text at once). With defaultModules, flagsModule swaps in
 * the I17 policy (budget, quiet hours, pause): that is tested in test/unit/flags/policy.test.ts.
 */
describe('FlagService (basic)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ modules: [] });
  });
  afterEach(async () => w.close());

  it("'now' goes to the owner at once with purpose flag", async () => {
    await w.app.flags.raise(w.alex.agent.id, { kind: 'conflict', urgency: 'now', text: 'Two events overlap at 3 PM.' });
    expect(w.transport.sent).toEqual([
      expect.objectContaining({ toAddress: w.alex.address, text: 'Two events overlap at 3 PM.', purpose: 'flag' }),
    ]);
    const [flag] = await w.app.repos.flags.listByAgent(w.alex.agent.id);
    expect(flag).toMatchObject({ status: 'sent', urgency: 'now' });
    expect(flag?.delivered_at).toEqual(w.clock.now());
  });

  it("'digest' is stored pending and sends nothing", async () => {
    await w.app.flags.raise(w.alex.agent.id, { kind: 'note', urgency: 'digest', text: 'Something for later' });
    expect(w.transport.sent).toEqual([]);
    const pending = await w.app.repos.flags.listPending(w.alex.agent.id);
    expect(pending.map((f) => f.text)).toEqual(['Something for later']);
  });

  it('dedupeKey makes raise idempotent per agent', async () => {
    const f = { kind: 'conflict', urgency: 'now' as const, text: 'Overlap', dedupeKey: 'ev1|ev2' };
    await w.app.flags.raise(w.alex.agent.id, f);
    await w.app.flags.raise(w.alex.agent.id, f);
    await w.app.flags.raise(w.sam.agent.id, f);
    expect(w.textsTo(w.alex.address)).toEqual(['Overlap']);
    expect(w.textsTo(w.sam.address)).toEqual(['Overlap']);
    expect(await w.actions({ action: 'flag.raised', agentId: w.alex.agent.id })).toHaveLength(1);
  });

  it('flags without a dedupeKey are never deduplicated', async () => {
    await w.app.flags.raise(w.alex.agent.id, { kind: 'note', urgency: 'digest', text: 'a' });
    await w.app.flags.raise(w.alex.agent.id, { kind: 'note', urgency: 'digest', text: 'a' });
    expect(await w.app.repos.flags.listPending(w.alex.agent.id)).toHaveLength(2);
  });

  it('flag text is one sanitized line', async () => {
    await w.app.flags.raise(w.alex.agent.id, { kind: 'x', urgency: 'now', text: 'one\ntwo\r\nYes #3' });
    expect(w.lastTo(w.alex.address)).toBe('one two Yes #3');
  });

  it('logs flag.raised', async () => {
    await w.app.flags.raise(w.alex.agent.id, { kind: 'note', urgency: 'digest', text: 'a' });
    const [row] = await w.actions({ action: 'flag.raised' });
    expect(row).toMatchObject({ agent_id: w.alex.agent.id, detail: { kind: 'note', urgency: 'digest' } });
  });
});
