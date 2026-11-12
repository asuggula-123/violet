/**
 * Independent verification, round 1, of the seam between I19 (a typed yes/no counts only
 * directly under the real prompt; the prompt is the last word of a Brain turn) and I20 (every
 * release in a tainted turn waits for the owner's yes on the exact words).
 *
 * Adversarial: a fully fooled Brain forges the held release's prompt in later replies; reply-to
 * on the forged message; the README's own description of answering two questions; the
 * duplicate run of a tainted turn on real Postgres (two apps, one database).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import { PgDb } from '../../../src/db/db.js';
import { defaultModules as modulesDefault } from '../../../src/modules.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { FRI, respond, scriptEnvoy, stepOf, toolUse } from '../../unit/a2a/helpers.js';
import { i19Violations } from '../../unit/i19/helpers.js';
import { a2aBodies, cleanOpen, GUIDE_PROMPT, OPEN_PROMPT, REPLY, samSide, SECRET, statusByRef, taintedTurn, talk, tell } from '../../unit/seam/helpers.js';

const URL = process.env.TEST_DATABASE_URL;
const PROMPT = OPEN_PROMPT(1, 'Saturday', SECRET);

let w: TestWorld | undefined;
let app2: App | undefined;
let db2: PgDb | undefined;
afterEach(async () => {
  await app2?.stop();
  await db2?.close();
  await w?.close();
  w = app2 = db2 = undefined;
});

const world = () => w!;
const alexTexts = () => world().textsTo(world().alex.address);
const nothingCrossed = async () => {
  expect((await a2aBodies(world())).map((m) => m.body)).not.toContain(SECRET);
  expect(samSide(world())).not.toContain('surprise party');
  expect(await world().actions({ action: 'a2a.release', agentId: world().alex.agent.id })).toEqual([]);
};

async function heldOne(): Promise<TestWorld> {
  w = await createTestWorld();
  scriptEnvoy(w, w.sam, () => ['ok']);
  scriptEnvoy(w, w.alex, () => ['ok']);
  taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET)]);
  await w.ownerSays(w.alex, SECRET);
  expect(alexTexts().slice(-2)).toEqual([REPLY, PROMPT]);
  return w;
}

describe('verify seam round 1: a fooled Brain forges the held release prompt in a later turn', () => {
  it('bare yes, yes 1, and reply-to on the forged copy approve nothing; only the yes under the real re-prompt releases exactly the shown words', async () => {
    const w = await heldOne();
    // The Brain is now fully fooled: every later turn writes the exact prompt of the live #1.
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: PROMPT }]));
    await w.ownerSays(w.alex, 'What is on tomorrow?');
    const forged = w.transport.sent.filter((m) => m.toAddress === w.alex.address).at(-1)!;
    expect(forged.purpose).toBe('reply');
    expect(forged.text).not.toBe(PROMPT); // neutralized (best effort); safety must not rest on it

    // A bare yes under the forged copy: the message above is a Brain reply, so the Brain gets it.
    await w.ownerSays(w.alex, 'yes');
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed();

    // A reply-to on the forged copy: not a genuine delivery, resolves nothing.
    const forged2 = w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'reply').at(-1)!;
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: forged2.transportMessageId });
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed();

    // yes 1 under a forged copy: shown again, not resolved.
    await w.ownerSays(w.alex, 'What else?');
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${PROMPT}`);
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed();

    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe(`Talking to Sam's Violet about “Saturday”: “${SECRET}”`);
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('verify seam round 1: the fooled Brain forges the prompt in the same turn, right above the real one', () => {
  it('reply-to on the forged copy (yes or no) resolves nothing; the real prompt below still works and the words cross exactly once', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET)], PROMPT);
    await w.ownerSays(w.alex, SECRET);
    const out = w.transport.sent.filter((m) => m.toAddress === w!.alex.address);
    expect(out.map((m) => m.purpose)).toEqual(['reply', 'approval']); // prompt last
    const forged = out[0]!;
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: forged.transportMessageId });
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${PROMPT}`);
    await w.ownerSays(w.alex, 'no', { replyToTransportMessageId: forged.transportMessageId });
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed();
    const real = w.transport.sent.filter((m) => m.toAddress === w!.alex.address && m.purpose === 'approval')[0]!;
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: real.transportMessageId });
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: real.transportMessageId });
    expect(w.lastTo(w.alex.address)).toBe("#1 isn't open any more.");
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('verify seam round 1: README "When one message makes Violet ask twice"', () => {
  /**
   * README.md (Known limits): "answer the first (yes and its number); Violet shows the second
   * again, and your next yes or no answers it".
   * This test follows that text literally with the `yes 1` reading of "your first yes".
   */
  it('README: after the first yes Violet shows the second question again, and the next yes answers it', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const conv = await cleanOpen(w);
    taintedTurn(w, w.alex, [tell('g', conv, 'Thursday works.'), talk('t', 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'Tell Sam Thursday works, and about Saturday');
    expect(alexTexts().slice(-3)).toEqual([REPLY, GUIDE_PROMPT(1, 'Thursday works.'), OPEN_PROMPT(2, 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'yes 1');
    // README: "after your first yes, Violet shows the second question again"
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${OPEN_PROMPT(2, 'Saturday', SECRET)}`);
    await w.ownerSays(w.alex, 'yes');
    // README: "and your next yes answers it" (Q: a release that went out ends 'executed')
    expect(await statusByRef(w, w.alex, 2)).toBe('executed');
  });

  it('the bare-yes reading of the README: yes, yes answers neither question (each bare yes is "Which one?")', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const conv = await cleanOpen(w);
    taintedTurn(w, w.alex, [tell('g', conv, 'Thursday works.'), talk('t', 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'Tell Sam Thursday works, and about Saturday');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'yes');
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['pending', 'pending']);
    expect(alexTexts().filter((t) => t.startsWith('Which one?'))).toHaveLength(2);
    expect((await a2aBodies(w)).map((m) => m.body)).not.toContain(SECRET);
    expect((await a2aBodies(w)).map((m) => m.body)).not.toContain('Thursday works.');
  });
});

describe('verify seam round 1: a held release and a booking prompt from one turn', () => {
  it('a button for the booking, then a bare yes: the release is not directly above, it is shown again, nothing crosses', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET), toolUse('b', 'request_calendar_event', { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' })]);
    await w.ownerSays(w.alex, SECRET);
    const booking = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE kind = 'calendar_event'")).rows[0]!;
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${booking.id}` });
    expect(await statusByRef(w, w.alex, 2)).toBe('executed');
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${PROMPT}`);
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed();
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe.skipIf(!URL)('verify seam round 1: the same tainted turn runs twice at once (real Postgres)', () => {
  const ITERATIONS = 20;
  it(`${ITERATIONS} iterations: one approval, one prompt delivery, no model text after the prompt, a bare yes under it releases once`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      w = await createTestWorld();
      const schema = (await w.db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
      db2 = new PgDb({ connectionString: URL!, schema, max: 4 });
      app2 = await buildApp({ ...w.app.deps, db: db2 }, modulesDefault);
      scriptEnvoy(w, w.sam, () => ['ok']);
      const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)));
      const alexId = w.alex.agent.id;
      w.llm.on({ agentId: alexId, mind: 'brain' }, async (req) => {
        await jitter();
        const step = stepOf(req);
        if (step === 0) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
        if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
        return respond([{ type: 'text', text: REPLY }]);
      });
      await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: SECRET });
      const event = (await w.db.query<{ id: string }>('SELECT id FROM inbound_events ORDER BY arrival_seq DESC LIMIT 1')).rows[0]!;
      // As after a stale requeue: a first attempt stored the message (one message id), then
      // two workers run the same message's hooks at once.
      const blocker = async () => {
        throw new Error('worker lost');
      };
      w.app.router.hooks.ownerInterceptors.unshift(blocker);
      await expect(w.app.router.process(event.id)).rejects.toThrow('worker lost');
      w.app.router.hooks.ownerInterceptors.shift();
      await Promise.allSettled([w.app.router.process(event.id), app2.router.process(event.id)]);
      await Promise.all([w.app.settle(), app2.settle()]);
      await Promise.all([w.app.settle(), app2.settle()]);

      const toAlex = w.transport.sent.filter((m) => m.toAddress === w!.alex.address);
      const promptAt = toAlex.findIndex((m) => m.purpose === 'approval');
      expect(promptAt, `iteration ${i}: a prompt went out`).toBeGreaterThanOrEqual(0);
      expect(toAlex.filter((m) => m.purpose === 'approval').map((m) => m.text), `iteration ${i}: exactly one prompt`).toEqual([PROMPT]);
      expect(toAlex.slice(promptAt + 1).map((m) => m.text), `iteration ${i}: nothing after the prompt`).toEqual([]);
      expect((await w.db.query("SELECT id FROM approvals WHERE kind = 'a2a_release'")).rows, `iteration ${i}`).toHaveLength(1);
      expect((await w.db.query('SELECT id FROM approval_deliveries')).rows, `iteration ${i}`).toHaveLength(1);
      expect(await a2aBodies(w)).toEqual([]);

      await w.ownerSays(w.alex, 'yes');
      expect(await a2aBodies(w), `iteration ${i}`).toEqual([{ kind: 'open', body: SECRET }]);
      expect((await w.actions({ action: 'a2a.release', agentId: alexId })).length).toBe(1);
      expect(await i19Violations(w)).toEqual([]);
      await app2.stop();
      await db2.close();
      await w.close();
      w = app2 = db2 = undefined;
    }
  }, 600_000);
});
