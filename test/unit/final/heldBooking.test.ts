/**
 * F1: a booking both owners said yes to, held because one owner is paused (I14), is never
 * dropped by the idle sweep. It ends either booked on the resume (every event still in the
 * future) or failed once its first event starts, with one code-written line to each owner (the
 * paused owner's after the resume). Retried sweeps and hooks book at most once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HELD_EXPIRED } from '../../../src/a2a/outcome.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, honestDinnerEnvoys, onlyConversation } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const creates = () => w.calendar.writes.filter((x) => x.op === 'create');
const booked = (address: string) => w.textsTo(address).filter((t) => /^Booked/.test(t));
const failedLines = (address: string) => w.textsTo(address).filter((t) => /^Couldn't book/.test(t));
const FAILED = `Couldn't book “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”: ${HELD_EXPIRED}. Nothing was booked.`;

/** Both said yes; Alex paused between the yeses, so the booking is held. */
async function held(): Promise<void> {
  alexOpensDinner(w);
  honestDinnerEnvoys(w);
  await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  await w.ownerSays(w.alex, 'yes');
  await w.ownerSays(w.alex, 'pause');
  await w.ownerSays(w.sam, 'yes');
  expect(w.lastTo(w.sam.address)).toBe('Waiting for Alex.');
}

/** The scheduler ticks every few hours (each tick runs the idle and booking sweeps). */
async function wait(hours: number): Promise<void> {
  for (let h = 0; h < hours; h += 6) await w.advance({ hours: Math.min(6, hours - h) });
}

/** A retried hook or sweep: each runs again directly. */
async function retryAll(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await w.app.a2a!.sweep();
    for (const hook of w.app.router.hooks.onResume) await hook(w.alex.agent.id);
    await w.app.settle();
  }
}

describe('F1: a held booking across a long pause', () => {
  it('three days of pause, then resume: not closed meanwhile, booked once on both calendars', async () => {
    w = await createTestWorld();
    await held();
    await wait(72); // Thu Nov 12, 4:00 AM: the dinner is still ahead
    expect((await onlyConversation(w)).status).toBe('awaiting_approval');
    expect(creates()).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await retryAll();
    expect(creates().map((x) => x.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    expect(booked(w.alex.address)).toHaveLength(1);
    expect(booked(w.sam.address)).toHaveLength(1);
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'booked' });
  });

  it('the dinner starts while Alex is still paused: one failure line each, nothing booked, a later resume books nothing', async () => {
    w = await createTestWorld();
    await held();
    await wait(4 * 24 + 18); // Fri Nov 13, 10:00 PM: the dinner has started
    expect(creates()).toEqual([]);
    expect(failedLines(w.sam.address)).toEqual([FAILED]);
    expect(failedLines(w.alex.address)).toEqual([]); // paused: nothing is sent to Alex
    const conv = await onlyConversation(w);
    expect(conv.status).toBe('open'); // reopened like any failed booking; no group held any more
    const approvals = (await w.db.query<{ status: string }>("SELECT status FROM approvals WHERE kind = 'a2a_outcome' ORDER BY seq")).rows;
    expect(approvals.map((a) => a.status)).toEqual(['failed', 'failed']);
    await retryAll();
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await retryAll();
    expect(creates()).toEqual([]);
    expect(failedLines(w.alex.address)).toEqual([FAILED]);
    expect(failedLines(w.sam.address)).toEqual([FAILED]);
    expect([...booked(w.alex.address), ...booked(w.sam.address)]).toEqual([]);
    // The line tells Sam nothing new about Alex: no word of the pause.
    expect(w.textsTo(w.sam.address).join('\n')).not.toMatch(/paused/i);
  });

  it('the resume comes after the start but before a sweep ran: failed with the same line, nothing booked', async () => {
    w = await createTestWorld();
    await held();
    w.clock.advance({ hours: 4 * 24 + 18 }); // no scheduler tick
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    await retryAll();
    expect(creates()).toEqual([]);
    expect(failedLines(w.alex.address)).toEqual([FAILED]);
    expect(failedLines(w.sam.address)).toEqual([FAILED]);
  });
});
