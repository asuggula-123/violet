/**
 * P8–P10: the resolver's bare-answer rule (c) matches 8.3, and a yes is never left without an
 * answer. RUN(m) naming two or more approvals → (d)/(e) over those still pending in RUN(m)
 * (none left → the not-open line); RUN(m) naming one closed approval → the not-open line; a lost
 * claim → the choice runs once more, then the not-open line.
 */
import { vi } from 'vitest';

const claimHook: { before: Array<() => Promise<void>> } = { before: [] };
vi.mock('../../../src/approvals/deliveries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/approvals/deliveries.js')>();
  return {
    ...real,
    claimDeliveries: async (...args: Parameters<typeof real.claimDeliveries>) => {
      const hook = claimHook.before.shift();
      if (hook) await hook();
      return real.claimDeliveries(...args);
    },
  };
});

import { afterEach, describe, expect, it } from 'vitest';
import { RESOLVER_TEXT } from '../../../src/approvals/resolver.js';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

let w: TestWorld | undefined;
afterEach(async () => {
  claimHook.before = [];
  await w?.close();
  w = undefined;
});

const ev = (title: string, h: number) => ({ title, start: `2026-11-14T${String(h).padStart(2, '0')}:00:00-05:00`, end: `2026-11-14T${String(h).padStart(2, '0')}:30:00-05:00` });
const ask = (world: TestWorld, title: string, h: number): Promise<ApprovalRow> => world.app.approvals!.request(world.alex.agent.id, { kind: 'calendar_event', payload: ev(title, h) });
const flag = (world: TestWorld) => world.app.gateway.sendToOwner(world.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
const status = async (world: TestWorld, a: ApprovalRow) => (await world.app.approvals!.get(a.id))!.status;

async function sentAfter(world: TestWorld, text: string): Promise<string[]> {
  const before = world.transport.sent.length;
  await world.ownerSays(world.alex, text);
  return world.transport.sent.slice(before).map((m) => m.text);
}

describe('P8: two or more approvals above → only those still pending in RUN(m)', () => {
  it('two adjacent prompts under older waiting ones: Which one shows the two above, not the older ones', async () => {
    w = await createTestWorld();
    for (let i = 0; i < 3; i += 1) await ask(w, `Old${i}`, 9 + i);
    await flag(w);
    const x = await ask(w, 'X', 14);
    const y = await ask(w, 'Y', 15);
    expect(await sentAfter(w, 'yes')).toEqual([RESOLVER_TEXT.whichOne(0), x.prompt, y.prompt]);
    expect(await status(w, x)).toBe('pending');
  });

  it('every approval in RUN(m) closed: the not-open line, nothing re-sent, nothing resolved', async () => {
    w = await createTestWorld();
    const old = await ask(w, 'Old', 9);
    await flag(w);
    const a = await ask(w, 'A', 14);
    const b = await ask(w, 'B', 15);
    await w.app.approvals!.cancel(a.id, 'closed');
    await w.app.approvals!.cancel(b.id, 'closed');
    expect(await sentAfter(w, 'yes')).toEqual([RESOLVER_TEXT.notOpen()]);
    expect(await status(w, old)).toBe('pending');
  });
});

describe('P9: one closed prompt directly above → the not-open line for it', () => {
  it('names the closed one (as a reply-to or "yes <ref>" would), even with another approval answerable', async () => {
    w = await createTestWorld();
    const other = await ask(w, 'Other', 9);
    await flag(w);
    const a = await ask(w, 'A', 14);
    await w.app.approvals!.cancel(a.id, 'closed');
    expect(await sentAfter(w, 'no')).toEqual([RESOLVER_TEXT.notOpen(a.ref)]);
    expect(await status(w, other)).toBe('pending');
  });
});

describe('P10: a lost claim never leaves the owner without an answer', () => {
  it('a candidate closes before the claim: the choice runs again with the fresh candidates', async () => {
    w = await createTestWorld();
    const world = w;
    const a = await ask(world, 'A', 9);
    const b = await ask(world, 'B', 10);
    await flag(world);
    claimHook.before.push(async () => void (await world.app.approvals!.cancel(a.id, 'closed')));
    expect(await sentAfter(world, 'yes')).toEqual([`${REPROMPT_PREFIX}${b.prompt}`]);
    expect(await status(world, b)).toBe('pending');
  });

  it('lost twice: the not-open line (one re-run per message, no loop)', async () => {
    w = await createTestWorld();
    const world = w;
    const a = await ask(world, 'A', 9);
    const b = await ask(world, 'B', 10);
    const c = await ask(world, 'C', 11);
    await flag(world);
    claimHook.before.push(async () => void (await world.app.approvals!.cancel(a.id, 'closed')));
    claimHook.before.push(async () => void (await world.app.approvals!.cancel(b.id, 'closed')));
    expect(await sentAfter(world, 'yes')).toEqual([RESOLVER_TEXT.notOpen()]);
    expect(await status(world, c)).toBe('pending');
  });
});
