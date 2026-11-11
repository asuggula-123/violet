/**
 * Flag policy × agent-to-agent (M5 × M4, I17): Envoy questions, outcome prompts and the a2a
 * result lines reach the owner at once, also in quiet hours and with the day's budget spent,
 * and use none of it; the a2a_* digest flags never text at once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, honestDinnerEnvoys, scriptEnvoy, toolUse } from '../a2a/helpers.js';

const ALEX_PROMPT = /^#1 With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”\. Book it\? Reply yes or no\.$/;

/** Monday 08:00: three urgent flags each (the day's budget) and one more that overflows; then 23:00 (quiet hours). */
async function spentAndQuiet(w: TestWorld): Promise<void> {
  await w.advance({ hours: 4 });
  for (const p of [w.alex, w.sam]) {
    for (let i = 0; i < 4; i += 1) await w.app.flags.raise(p.agent.id, { kind: 'test_urgent', urgency: 'now', text: `urgent ${i}`, dedupeKey: `u${i}` });
  }
  await w.app.settle();
  for (const p of [w.alex, w.sam]) expect(w.textsTo(p.address)).toEqual(['urgent 0', 'urgent 1', 'urgent 2']);
  await w.advance({ hours: 15 });
}

async function budgetUsed(w: TestWorld, p: Persona): Promise<number> {
  const res = await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM flags WHERE agent_id = $1 AND budget_date IS NOT NULL`, [p.agent.id]);
  return res.rows[0]!.n;
}

async function noA2aFlagTexted(w: TestWorld): Promise<void> {
  const res = await w.db.query<{ kind: string; urgency: string; status: string }>(`SELECT kind, urgency, status FROM flags WHERE kind LIKE 'a2a_%'`);
  expect(res.rows.length).toBeGreaterThan(0);
  expect(res.rows.every((f) => f.urgency === 'digest' && f.status === 'pending')).toBe(true);
  const now = await w.db.query(`SELECT 1 FROM flags WHERE urgency = 'now' AND kind <> 'test_urgent'`);
  expect(now.rowCount).toBe(0);
}

describe('a2a lines are not flags: at once, unbudgeted, also in quiet hours', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('outcome prompts, "Waiting for Sam." and "Booked: …" arrive at 23:00 with the budget spent', async () => {
    w = await createTestWorld();
    await spentAndQuiet(w);
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(w.lastTo(w.alex.address)).toMatch(ALEX_PROMPT);
    expect(w.lastTo(w.sam.address)).toMatch(/^#1 With Alex: /);
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe('Waiting for Sam.');
    await w.ownerSays(w.sam, 'yes');
    for (const p of [w.alex, w.sam]) expect(w.lastTo(p.address)).toBe('Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.');
    for (const p of [w.alex, w.sam]) expect(await budgetUsed(w, p)).toBe(3);
    await noA2aFlagTexted(w);
  });

  it('"Sam said no to: …" arrives at once', async () => {
    w = await createTestWorld();
    await spentAndQuiet(w);
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.sam, 'no');
    expect(w.lastTo(w.alex.address)).toBe('Sam said no to: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi\'s”. Nothing was booked.');
    expect(await budgetUsed(w, w.alex)).toBe(3);
    await noA2aFlagTexted(w);
  });

  it('an Envoy question arrives at once', async () => {
    w = await createTestWorld();
    await spentAndQuiet(w);
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, () => [[toolUse('q', 'ask_owner', { question: 'Is 7 pm on Friday fine?' })], 'asked']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(w.lastTo(w.sam.address)).toBe("Violet ↔ Alex's Violet (“Dinner Friday”) asks: “Is 7 pm on Friday fine?”");
    expect(await budgetUsed(w, w.sam)).toBe(3);
    await noA2aFlagTexted(w);
  });
});
