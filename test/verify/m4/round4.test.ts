/**
 * M4 independent verifier, round 4: adversarial tests. A failing test here is evidence of a
 * defect (see the verifier report); none of these weaken or replace the milestone's tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { neutralizeReply } from '../../../src/brain/reply.js';
import { shown } from '../../../src/a2a/render.js';
import { ownerSaidIt } from '../../../src/a2a/words.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, FRI, respond, scriptEnvoy, stepOf, toolUse } from '../../unit/a2a/helpers.js';

/**
 * Characters that render as blank (or nothing) in common fonts but are none of \s, Cf,
 * Default_Ignorable or marks. U+1D159 MUSICAL SYMBOL NULL NOTEHEAD (So) is on the usual
 * "invisible characters" lists next to U+2800 and U+3164.
 */
const BLANKS = /[⠀\u{1D159}]/gu;

describe('M4 verify round 4', () => {
  let w: TestWorld | undefined;
  afterEach(async () => {
    const open = w;
    w = undefined;
    await open?.close();
  });

  // ---------------------------------------------------------------- K2: remaining blank-rendering characters
  it('K2 (unit): U+1D159 MUSICAL SYMBOL NULL NOTEHEAD (renders blank; category So) cannot carry a live-looking ref or tail', () => {
    const n = '\u{1D159}';
    const fake = `#${n}7 With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM. Book it? Reply${n}yes${n}or${n}no.`;
    for (const out of [neutralizeReply(fake), shown(fake, 300)]) {
      const asSpace = out.replace(BLANKS, ' ');
      const asNothing = out.replace(BLANKS, '');
      for (const seen of [asSpace, asNothing]) {
        expect(seen).not.toMatch(/#\s*\d/);
        expect(seen).not.toMatch(/reply\s*yes\s*or\s*no/i);
      }
    }
  });

  it('K2: a model reply with U+1D159 blanks cannot imitate an approval prompt shown to the owner', async () => {
    const world = (w = await createTestWorld());
    const n = '\u{1D159}';
    const fake = `#${n}7 With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM. Book it? Reply${n}yes${n}or${n}no.`;
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: fake }]));
    await world.ownerSays(world.alex, 'hi');
    const seen = world.lastTo(world.alex.address)!.replace(BLANKS, '');
    expect(seen).not.toMatch(/#\s*\d/);
    expect(seen).not.toMatch(/reply\s*yes\s*or\s*no/i);
  });

  it('K2 (regression): U+2800 and the Hangul fillers stay folded', () => {
    for (const ch of ['⠀', 'ㅤ', 'ᅟ', 'ᅠ', 'ﾠ']) {
      const out = neutralizeReply(`#${ch}7 Reply${ch}yes${ch}or${ch}no.`).replace(BLANKS, ' ');
      expect(out).not.toMatch(/#\s*\d/);
      expect(out).not.toMatch(/reply\s*yes\s+or\s+no/i);
    }
  });

  // ---------------------------------------------------------------- I11: round-3 fix re-checked
  it('I11 (unit): names keep the owner phrasing — swap, add, repeat and covert sequences fail; owner phrasing passes', () => {
    const names = ['Violet', 'Alex', 'Violet', 'Sam'];
    expect(ownerSaidIt('Tell Sam that Alex will pick up the kids', ['kids', 'Sam will pick up the kids'], names)).toBe(false);
    expect(ownerSaidIt('Tell Sam that Alex will pick up the kids', ['kids', 'Alex will pick up the kids'], names)).toBe(true);
    expect(ownerSaidIt('Tell Sam I am home Friday', ['Friday', 'Alex Sam home Friday'], names)).toBe(false);
    expect(ownerSaidIt('Tell Sam I am home Friday', ['Friday', 'Sam Sam home Friday'], names)).toBe(false);
    expect(ownerSaidIt('Tell Sam I am home Friday', ['Friday', 'Violet Violet Violet home Friday'], names)).toBe(false);
    // Only glue words and names: never passes vacuously.
    expect(ownerSaidIt('Tell Sam that Alex is not', ['Alex is not'], names)).toBe(false);
  });

  it('I11: tainted turn, a name moved next to different owner words is held (integration, real release path)', async () => {
    const world = (w = await createTestWorld());
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]),
        respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'kids', brief: 'Sam will drive and Alex will cook' })]),
        respond([{ type: 'text', text: 'ok' }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    scriptEnvoy(world, world.sam, () => ['ok']);
    await world.ownerSays(world.alex, 'Tell Sam about the kids: Alex will drive and Sam will cook');
    expect(await a2aMessages(world), 'nothing released without the owner yes').toEqual([]);
    expect(world.textsTo(world.alex.address).some((t) => t.includes('Send? Reply yes or no.'))).toBe(true);
  });
});
