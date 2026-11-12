/**
 * Seam I19 x I20: what the two rules cost the owner, in typed messages (no buttons, no
 * reply-to). These are the numbers docs/ARCHITECTURE.md (8.4, "What I20 costs the owner")
 * states; if one changes, change the doc with it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SAY } from '../../../src/demo/model.js';
import { runDemo } from '../../../src/demo/story.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, dinnerEvent, FRI, honestDinnerEnvoys, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';
import { a2aBodies, cleanOpen, OPEN_PROMPT, ownerMessages, SECRET, statusByRef, taintedTurn, talk, tell } from './helpers.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const LUNCH = { start: '2026-11-13T12:00:00-05:00', end: '2026-11-13T13:00:00-05:00' };

describe('seam: typed owner messages under I19 and I20', () => {
  it('the first dinner in a clean chat: 3 (request, Alex yes, Sam yes)', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, SAY.dinner);
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    expect(await ownerMessages(w)).toEqual([
      ['Alex', SAY.dinner],
      ['Alex', 'yes'],
      ['Sam', 'yes'],
    ]);
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(2);
  });

  it('a second request in the now tainted chat: Alex 3 (request, yes to the words, yes to the booking) + Sam 1', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, SAY.dinner);
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    const before = (await ownerMessages(w)).length;

    honestDinnerEnvoys(w, dinnerEvent({ title: 'Lunch', ...LUNCH, location: 'Cafe' }));
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('l', 'talk_to_agent', { with: 'Sam', topic: 'Lunch Friday', brief: 'Lunch on Friday?', window_start: FRI.windowStart, window_end: FRI.windowEnd })])
        : respond([{ type: 'text', text: "I'll check with you first." }]),
    );
    await w.ownerSays(w.alex, 'Set up lunch with Sam on Friday too');
    expect((await w.actions({ action: 'brain.turn', agentId: w.alex.agent.id })).at(-1)!.detail.tainted).toBe(true);
    expect(w.lastTo(w.alex.address)).toMatch(/^#2 Tell Sam's Violet about “Lunch Friday” \(.*\): “Lunch on Friday\?” Send\? Reply yes or no\.$/);
    expect((await a2aBodies(w)).map((m) => m.body)).not.toContain('Lunch on Friday?');
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toMatch(/^#3 With Sam: “Lunch”/);
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    const added = (await ownerMessages(w)).slice(before);
    expect(added).toEqual([
      ['Alex', 'Set up lunch with Sam on Friday too'],
      ['Alex', 'yes'],
      ['Alex', 'yes'],
      ['Sam', 'yes'],
    ]);
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(4);
  });

  it('two held releases from one turn, typed answers only: the request + 3 (yes 1, yes 2 shows #2 again, yes)', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const conv = await cleanOpen(w);
    const before = (await ownerMessages(w)).length;
    taintedTurn(w, w.alex, [tell('g', conv, 'Thursday works.'), talk('t', 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'Tell Sam Thursday works, and about Saturday');
    await w.ownerSays(w.alex, 'yes 1');
    await w.ownerSays(w.alex, 'yes 2');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${OPEN_PROMPT(2, 'Saturday', SECRET)}`);
    expect(await statusByRef(w, w.alex, 2)).toBe('pending');
    await w.ownerSays(w.alex, 'yes');
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['approved', 'approved']);
    expect((await ownerMessages(w)).slice(before).map(([, t]) => t)).toEqual(['Tell Sam Thursday works, and about Saturday', 'yes 1', 'yes 2', 'yes']);
  });

  it('the demo story: Alex 4 (dinner, yes, pause, resume), Sam 3 (yes, the run request, yes to its words); reply above the prompt', async () => {
    const r = await runDemo({ fast: true, out: () => {} });
    const typed = (who: 'ALEX' | 'SAM', name: string) => r.output.filter((l) => l.startsWith(`  ${who}'S PHONE`) && l.includes(` ${name}: `)).map((l) => l.split(`${name}: `)[1]);
    expect(typed('ALEX', 'Alex')).toEqual([SAY.dinner, 'yes', 'pause', 'resume']);
    expect(typed('SAM', 'Sam')).toEqual(['yes', SAY.run, 'yes']);
    // DEMO.md order: Sam's request, Violet's reply, the one-line prompt, Sam's yes.
    const sam = r.output.filter((l) => l.startsWith("  SAM'S PHONE"));
    const at = (needle: string) => sam.findIndex((l) => l.includes(needle));
    const request = at(`Sam: ${SAY.run}`);
    expect(sam.slice(request, request + 4).map((l) => l.replace(/^ {2}SAM'S PHONE +/, '').slice(0, 30))).toEqual([
      `Sam: ${SAY.run}`.slice(0, 30),
      "Violet: I'll check with you fi",
      "Violet: #2 Tell Alex's Violet ",
      'Sam: yes',
    ]);
    expect(at('Sam: yes')).toBeLessThan(request); // Sam's first yes was the dinner
  });
});
