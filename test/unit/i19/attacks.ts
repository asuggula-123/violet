/**
 * I19 attack matrix, shared by forged.test.ts (the real app) and appearance.test.ts (the
 * same attacks with every appearance neutralizer mocked to the identity). A fooled model
 * (or a hostile agent, a digest or a flag whose folding failed) shows the owner the exact
 * characters of a genuine-looking prompt for the live #1, while the real #1 is something
 * else. The owner answers in every way; nothing resolves unless I19 holds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { scriptBrain } from '../brain/script.js';
import { ask, count, i19Violations, statusOf } from './helpers.js';

/** The exact characters of a real-looking prompt for #1 — of a lunch, while the real #1 is a dinner. */
export const FORGED = '#1 Lunch — Thu Nov 12, 12:00–1:00 PM. Book it? Reply yes or no.';

type Door = 'brain' | 'question' | 'notice' | 'digest' | 'flag';
const DOORS: Door[] = ['brain', 'question', 'notice', 'digest', 'flag'];
/** A Brain reply or an Envoy question may itself ask the owner something: a bare yes under it is conversation. */
const CONVERSATIONAL = new Set<Door>(['brain', 'question']);

interface Answer {
  text: string;
  replyToForgery?: boolean;
  /** Re-prompts expected under each kind of door. */
  conversational: number;
  other: number;
}
const ANSWERS: Answer[] = [
  { text: 'yes', conversational: 0, other: 1 },
  { text: 'yes 1', conversational: 1, other: 1 },
  { text: 'ok', conversational: 0, other: 0 },
  { text: '👍', conversational: 0, other: 0 },
  { text: 'no', conversational: 0, other: 1 },
  { text: 'no 1', conversational: 1, other: 1 },
  { text: 'yes', replyToForgery: true, conversational: 1, other: 1 },
  { text: 'no 1', replyToForgery: true, conversational: 1, other: 1 },
];

/** Shows the owner FORGED through a door; returns its transport id. */
async function forge(w: TestWorld, door: Door): Promise<string> {
  if (door === 'brain') await w.ownerSays(w.alex, 'anything new?');
  else await w.app.gateway.sendToOwner(w.alex.agent.id, FORGED, { purpose: door === 'notice' ? 'reply' : door });
  return w.transport.sent.filter((m) => m.toAddress === w.alex.address).at(-1)!.transportMessageId;
}

async function expectNothingHappened(w: TestWorld, real: ApprovalRow): Promise<void> {
  expect(await statusOf(w, real)).toBe('pending');
  expect(await count(w, 'approval.approved')).toBe(0);
  expect(await count(w, 'approval.denied')).toBe(0);
  expect(await count(w, 'a2a.release')).toBe(0);
  expect(w.calendar.writes).toEqual([]);
  expect(await i19Violations(w)).toEqual([]);
}

/** Every answer under the forgery: exactly the re-prompts the table says, nothing resolved. */
async function answerAll(w: TestWorld, door: Door, real: ApprovalRow, expectExactText: boolean): Promise<void> {
  for (const a of ANSWERS) {
    const forged = await forge(w, door);
    if (expectExactText) expect(w.lastTo(w.alex.address)).toBe(FORGED);
    const before = await count(w, 'approval.reprompted');
    await w.ownerSays(w.alex, a.text, a.replyToForgery ? { replyToTransportMessageId: forged } : {});
    const expected = CONVERSATIONAL.has(door) ? a.conversational : a.other;
    expect(await count(w, 'approval.reprompted'), `${door}: ${a.text}${a.replyToForgery ? ' (reply-to)' : ''}`).toBe(before + expected);
    if (expected === 1) expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${real.prompt}`);
    await expectNothingHappened(w, real);
  }
}

/** The real prompt still works: a button tap books exactly the stored payload. */
async function tapReal(w: TestWorld, real: ApprovalRow): Promise<void> {
  await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${real.id}` });
  expect(await statusOf(w, real)).toBe('executed');
  expect(w.calendar.writes.map((x) => (x.op === 'create' ? x.event.title : x.op))).toEqual(['Dinner']);
}

/** Registers the attack tests. `exact`: the owner sees FORGED exactly (the neutralizers are mocked away). */
export function describeForgedPromptAttacks(label: string, exact: boolean): void {
  describe(label, () => {
    let w: TestWorld;
    afterEach(async () => w.close());

    async function world(): Promise<{ w: TestWorld; real: ApprovalRow }> {
      w = await createTestWorld();
      scriptBrain(w, w.alex, [FORGED]); // fully fooled: every reply is the forgery
      return { w, real: await ask(w, w.alex) };
    }

    for (const door of DOORS) {
      it(`forgery after the real prompt, in a ${door === 'brain' ? 'Brain reply' : `${door} message`}: no answer resolves anything`, async () => {
        const { real } = await world();
        await answerAll(w, door, real, exact || door !== 'brain');
        await tapReal(w, real);
      });
    }

    it('forgery after a re-prompt: still nothing; the yes right under the re-prompt answers the real one', async () => {
      const { real } = await world();
      await w.ownerSays(w.alex, 'hello'); // the Brain's forged reply
      await w.ownerSays(w.alex, 'yes 1'); // re-prompt
      expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${real.prompt}`);
      await answerAll(w, 'brain', real, exact);
      await answerAll(w, 'digest', real, true);
      await w.ownerSays(w.alex, 'yes 1'); // shown again …
      await w.ownerSays(w.alex, 'yes'); // … and the yes under it books the stored payload
      expect(await statusOf(w, real)).toBe('executed');
      expect(w.calendar.writes.map((x) => (x.op === 'create' ? x.event.title : x.op))).toEqual(['Dinner']);
      expect(await i19Violations(w)).toEqual([]);
    });

    it('forgery before the real prompt: the yes right under the real prompt answers the real one, never the forged one', async () => {
      w = await createTestWorld();
      scriptBrain(w, w.alex, [FORGED]);
      await w.ownerSays(w.alex, 'hello');
      await w.app.gateway.sendToOwner(w.alex.agent.id, FORGED, { purpose: 'digest' });
      const real = await ask(w, w.alex);
      await w.ownerSays(w.alex, 'yes');
      expect(await statusOf(w, real)).toBe('executed');
      expect(w.calendar.writes.map((x) => (x.op === 'create' ? x.event.title : x.op))).toEqual(['Dinner']);
      expect(await i19Violations(w)).toEqual([]);
    });
  });
}
