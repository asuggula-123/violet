/**
 * Seam I19 x I20: answering held releases. A typed no, an expired release, a pause between
 * the turn and the answer, "Which one?" with a held release and a booking prompt, and the
 * agent notices a turn queues. Each behaves as section 8.3 says, and nothing crosses to the
 * other agent without a yes. The Brain is greedy throughout: every turn it gets, it tries
 * to release the secret again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { lastResults, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';
import { a2aBodies, book, cleanOpen, DINNER_PROMPT, GUIDE_PROMPT, OPEN_PROMPT, REPLY, samSide, SECRET, statusByRef, taintedTurn, talk, tell } from './helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const PROMPT = OPEN_PROMPT(1, 'Saturday', SECRET);
/** The secret crossed nowhere; `noRelease`: nothing at all of Alex's was released. */
const nothingCrossed = async (noRelease = true) => {
  expect((await a2aBodies(w)).map((m) => m.body)).not.toContain(SECRET);
  expect(samSide(w)).not.toContain('surprise party');
  if (noRelease) expect(await w.actions({ action: 'a2a.release', agentId: w.alex.agent.id })).toEqual([]);
};

async function heldOne(): Promise<void> {
  w = await createTestWorld();
  scriptEnvoy(w, w.sam, () => ['ok']);
  scriptEnvoy(w, w.alex, () => ['ok']);
  taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET)]);
  await w.ownerSays(w.alex, SECRET);
  expect(w.lastTo(w.alex.address)).toBe(PROMPT);
}

describe('seam: answering a held release', () => {
  it('a typed no directly under it: dropped, nothing crosses, nothing retries', async () => {
    await heldOne();
    await w.ownerSays(w.alex, 'no');
    expect(w.lastTo(w.alex.address)).toBe("Okay, I won't send it.");
    expect(await statusByRef(w, w.alex, 1)).toBe('denied');
    await w.advance({ hours: 30 });
    await nothingCrossed();
    expect(await a2aBodies(w)).toEqual([]);
  });

  it('expired: a late yes 1 is not open; a late bare yes goes to the Brain, whose new release is held again', async () => {
    await heldOne();
    await w.advance({ hours: 25 });
    expect(await statusByRef(w, w.alex, 1)).toBe('expired');
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)).toBe("#1 isn't open any more.");
    await w.ownerSays(w.alex, 'yes');
    // The greedy Brain got the bare yes (no live prompt above) and tried again: held as #2.
    expect(w.lastTo(w.alex.address)).toBe(OPEN_PROMPT(2, 'Saturday', SECRET));
    await nothingCrossed();
    expect(await a2aBodies(w)).toEqual([]);
  });

  it('pause between the turn and the answer: a yes while paused does nothing; after resume the yes under the shown-again prompt releases', async () => {
    await heldOne();
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'yes');
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await w.ownerSays(w.alex, 'resume');
    await nothingCrossed();
    // The resume ack is directly above, not the prompt: the yes shows it again (I19 d).
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${PROMPT}`);
    await nothingCrossed();
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe(`Talking to Sam's Violet about “Saturday”: “${SECRET}”`);
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
  });

  it('paused during the turn: reply and prompt are held; after resume the prompt comes after the ack and a bare yes under it releases', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    let toolText = '';
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([toolUse('r', 'get_schedule', { from: '2026-11-13T00:00:00-05:00', to: '2026-11-14T00:00:00-05:00' })]);
      if (step === 1) {
        // The owner pauses while the model is thinking: the pause is ingested at once.
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
        return respond([talk('t', 'Saturday', SECRET)]);
      }
      toolText = lastResults(req)[0]!.content;
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, SECRET);
    expect(toolText).toMatch(/after your reply, or when I can send again,/);
    expect(w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval')).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    const texts = w.textsTo(w.alex.address);
    expect(texts.slice(-2)).toEqual(["Resumed. I'm back on.", PROMPT]);
    await nothingCrossed();
    await w.ownerSays(w.alex, 'yes');
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
  });

  it('"Which one?" with a held release and a booking prompt: each prompt is shown again; only yes and its number resolves; the release crosses only after its own yes', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET), book('b')]);
    await w.ownerSays(w.alex, SECRET);
    await w.ownerSays(w.alex, 'yes');
    const texts = w.textsTo(w.alex.address);
    expect(texts.slice(-3)).toEqual(['Which one? Tap Yes or No under it, or reply yes and its number.', PROMPT, DINNER_PROMPT(2)]);
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['pending', 'pending']);
    // A second bare yes is just as ambiguous.
    await w.ownerSays(w.alex, 'yes');
    expect(w.textsTo(w.alex.address).slice(-3)[0]).toMatch(/^Which one\?/);
    expect(w.calendar.writes).toEqual([]);
    await nothingCrossed();
    await w.ownerSays(w.alex, 'yes 2');
    expect(await statusByRef(w, w.alex, 2)).toBe('executed');
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    // S1: the release was the one other prompt in that run: shown again below the confirmation.
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${PROMPT}`);
    await nothingCrossed();
    await w.ownerSays(w.alex, 'no');
    expect(await statusByRef(w, w.alex, 1)).toBe('denied');
    await w.advance({ hours: 30 });
    await nothingCrossed();
    expect(await a2aBodies(w)).toEqual([]);
  });
});

describe('seam: agent notices and held releases', () => {
  it("a held release queues no notice: no 'Talking to' line before the yes; the yes sends it, as the reply to that yes", async () => {
    await heldOne();
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Talking to'))).toEqual([]);
    expect((await w.db.query('SELECT id FROM a2a_notices')).rows).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Talking to'))).toEqual([`Talking to Sam's Violet about “Saturday”: “${SECRET}”`]);
    expect(w.lastTo(w.alex.address)).toMatch(/^Talking to/);
  });

  it("a release sent at once before the turn turned tainted, then a held one: reply, the 'Talking to' notice, then the prompt", async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([talk('o', 'Lunch', 'Lunch with Sam this week?')]); // clean so far: sent at once
      if (step === 1) return respond([toolUse('r', 'get_schedule', { from: '2026-11-13T00:00:00-05:00', to: '2026-11-14T00:00:00-05:00' })]);
      if (step === 2) {
        const conv = /Conversation id: ([^.\s]+)\./.exec(JSON.stringify(req.messages))![1]!;
        return respond([tell('g', conv, SECRET)]);
      }
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, 'Ask Sam about lunch, and tell him my secret');
    expect(w.textsTo(w.alex.address)).toEqual([REPLY, "Talking to Sam's Violet about “Lunch”: “Lunch with Sam this week?”", GUIDE_PROMPT(1, SECRET)]);
    await nothingCrossed(false);
    expect((await w.actions({ action: 'a2a.release', agentId: w.alex.agent.id })).length).toBe(1);
  });

  it('after the yes to one of two prompts, the other one is shown again below the confirmation; nothing of it crosses before its own answer', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const conv = await cleanOpen(w);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET), tell('g', conv, 'Thursday works.')]);
    await w.ownerSays(w.alex, SECRET);
    await w.ownerSays(w.alex, 'yes 2');
    expect(w.textsTo(w.alex.address).slice(-2)).toEqual(["Told Sam's Violet: “Thursday works.”", `Just to be sure: ${PROMPT}`]);
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed(false);
    await w.ownerSays(w.alex, 'no');
    expect(await statusByRef(w, w.alex, 1)).toBe('denied');
    await nothingCrossed(false);
    expect((await w.actions({ action: 'a2a.release', agentId: w.alex.agent.id })).length).toBe(2); // the clean open and #2
  });
});
