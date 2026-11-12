/**
 * Independent verification, round 2, of the seam between I19 (a typed yes/no counts only
 * directly under the real prompt; the prompt is the last word of a Brain turn) and I20 (every
 * release in a tainted turn waits for the owner's yes on the exact words).
 *
 * Adversarial: a turn that outlives its hold (the sweep's crash net fires while the turn is
 * still alive); a retried turn whose held prompt the sweep already delivered and the owner
 * already refused; a pause in the middle of a turn that also released something at once; a
 * fooled Brain forging the ref of an older live release next to a new one; reply-to on the
 * fixed "Which one?" line; the README's own two-question promise, read literally.
 * Every test checks the 'must not happen' part (nothing crosses without the yes) as well.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TURN_HOLD_MS } from '../../../src/approvals/service.js';
import { BRAIN_TURN_MS } from '../../../src/brain/brain.js';
import { LlmError } from '../../../src/llm/errors.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { FRI, lastResults, respond, scriptEnvoy, stepOf, toolUse } from '../../unit/a2a/helpers.js';
import { i19Violations } from '../../unit/i19/helpers.js';
import { a2aBodies, book, cleanOpen, DINNER_PROMPT, GUIDE_PROMPT, OPEN_PROMPT, REPLY, samSide, SECRET, statusByRef, taintedTurn, talk, tell } from '../../unit/seam/helpers.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const world = () => w!;
const PROMPT = OPEN_PROMPT(1, 'Saturday', SECRET);
const alexOut = () => world().transport.sent.filter((m) => m.toAddress === world().alex.address);
const nothingCrossed = async () => {
  expect((await a2aBodies(world())).map((m) => m.body)).not.toContain(SECRET);
  expect(samSide(world())).not.toContain('surprise party');
};

describe('verify seam round 2: a turn that outlives TURN_HOLD_MS (prompt-last)', () => {
  /**
   * S2 (docs/ARCHITECTURE.md 8.2): a turn cannot outlive its hold. The model loop is cut at
   * BRAIN_TURN_MS (a call gets the time left as timeoutMs and the client aborts there), and the
   * hold is longer than that plus the margin for the last tools and the reply. The slowest model
   * a turn can have therefore runs to the deadline, not to 16 minutes: the scripted model here
   * does what the real client does at timeoutMs.
   */
  it('a turn whose model is as slow as it can be (cut at the deadline): the sweep does not put the held prompt above the reply of the same turn', async () => {
    expect(TURN_HOLD_MS).toBeGreaterThan(BRAIN_TURN_MS + 5 * 60_000);
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      // The slowest model: it uses all the time it is given; the scheduler keeps ticking.
      world().clock.advance({ ms: req.timeoutMs! });
      await world().app.scheduler.runDue();
      throw new LlmError('deadline', false, 'cut off at timeoutMs');
    });
    await w.ownerSays(w.alex, SECRET);
    await nothingCrossed();
    // Safety holds either way: exactly one genuine delivery.
    expect((await w.db.query('SELECT id FROM approval_deliveries')).rows).toHaveLength(1);
    // docs/ARCHITECTURE.md 8.2: "no reply of the turn lands after its prompts".
    expect(alexOut().map((m) => m.purpose)).toEqual(['reply', 'approval']);
  });

  it('after that, a bare yes under the late reply goes to the (fooled) Brain and resolves nothing; yes 1 then the yes under the re-prompt releases exactly once', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    let first = true;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (!first) return respond([{ type: 'text', text: `Done, it was sent. ${PROMPT}` }]);
      if (step === 0) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      first = false;
      world().clock.advance({ minutes: 16 });
      await world().app.scheduler.runDue();
      return respond([{ type: 'text', text: PROMPT }]); // the fooled model forges the prompt as its reply
    });
    await w.ownerSays(w.alex, SECRET);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusByRef(w, w.alex, 1)).toBe('pending');
    await nothingCrossed();
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${PROMPT}`);
    await nothingCrossed();
    await w.ownerSays(w.alex, 'yes');
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
    expect((await w.actions({ action: 'a2a.release', agentId: w.alex.agent.id })).length).toBe(1);
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('verify seam round 2: a retried turn after the sweep delivered its held prompt and the owner refused it', () => {
  it('the retry finds the denied approval by callKey: nothing crosses, no second prompt, no second approval', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 20 * 60_000 } });
    scriptEnvoy(w, w.sam, () => ['ok']);
    let attempt = 0;
    let retryResult = '';
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) {
        attempt += 1;
        return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      }
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      if (attempt === 1) {
        // The crash window: the approval exists, the memo row does not, the job fails.
        await world().db.query("DELETE FROM brain_tool_memo WHERE tool = 'talk_to_agent'");
        throw new Error('worker crashed');
      }
      retryResult = lastResults(req)[0]!.content;
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, SECRET);
    expect(alexOut()).toEqual([]);
    // 16 minutes later the hold has lapsed: the sweep sends the prompt (the turn looks dead).
    await w.advance({ minutes: 16 });
    expect(alexOut().map((m) => m.text)).toEqual([PROMPT]);
    const approval = (await w.db.query<{ id: string }>("SELECT id FROM approvals WHERE kind = 'a2a_release'")).rows[0]!;
    // The owner taps No under it. The lane is still held by the failed turn job (it waits
    // for its retry), so the tap is processed after the retry: the retry finds the approval
    // pending and keeps it held (no second prompt), then the No resolves it.
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${approval.id}` });
    await w.advance({ minutes: 5 });
    expect(attempt).toBe(2);
    expect(retryResult).toMatch(/^Not sent\./);
    expect(await statusByRef(w, w.alex, 1)).toBe('denied');
    await nothingCrossed();
    expect((await w.db.query("SELECT id FROM approvals WHERE kind = 'a2a_release'")).rows).toHaveLength(1);
    expect(alexOut().filter((m) => m.purpose === 'approval')).toHaveLength(1);
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('verify seam round 2: a pause in the middle of a turn that released one thing at once and held another', () => {
  it('after resume, the held prompt is directly above the next message, so a bare yes answers it (notices first, prompts last)', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([talk('o', 'Lunch', 'Lunch with Sam this week?')]); // clean: sent at once
      if (step === 1) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      if (step === 2) {
        await world().inbound({ agentAddress: world().alex.agentAddress, fromAddress: world().alex.address, text: 'pause' });
        const conv = /Conversation id: ([^.\s]+)\./.exec(JSON.stringify(req.messages))![1]!;
        return respond([tell('g', conv, SECRET)]);
      }
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, 'Ask Sam about lunch, and tell him my secret');
    await w.ownerSays(w.alex, 'resume');
    await nothingCrossed();
    // Liveness and safety, whatever the order: the secret crosses only after a yes the owner
    // typed directly under a genuine delivery of #1, within two typed answers.
    const afterResume = w.textsTo(w.alex.address).slice(w.textsTo(w.alex.address).lastIndexOf("Resumed. I'm back on."));
    await w.ownerSays(w.alex, 'yes');
    if ((await statusByRef(w, w.alex, 1)) === 'pending') {
      expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${GUIDE_PROMPT(1, SECRET)}`);
      await nothingCrossed();
      await w.ownerSays(w.alex, 'yes');
    }
    expect(await statusByRef(w, w.alex, 1)).toBe('executed'); // Q: a release that went out ends 'executed'
    expect(await i19Violations(w)).toEqual([]);
    // 8.2 / the release section: "reply, the turn's notices, then the prompts" — also on resume.
    expect(afterResume).toEqual(["Resumed. I'm back on.", "Talking to Sam's Violet about “Lunch”: “Lunch with Sam this week?”", GUIDE_PROMPT(1, SECRET)]);
  });
});

describe('verify seam round 2: the fooled Brain forges the ref of an older live release next to a new one', () => {
  it('#1 (harmless) is live; a new turn holds #2 (the secret) and forges "#1 …" above it: yes 1 under #2 resolves nothing, #2 stays held', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const harmless = 'See you Saturday!';
    taintedTurn(w, w.alex, [talk('h', 'Saturday', harmless)]);
    await w.ownerSays(w.alex, 'Tell Sam see you Saturday');
    expect(w.lastTo(w.alex.address)).toBe(OPEN_PROMPT(1, 'Saturday', harmless));
    taintedTurn(w, w.alex, [talk('s', 'Sunday', SECRET)], `${OPEN_PROMPT(1, 'Saturday', harmless)} (this is the one you asked about)`);
    await w.ownerSays(w.alex, 'ok thanks');
    expect(w.lastTo(w.alex.address)).toBe(OPEN_PROMPT(2, 'Sunday', SECRET));
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${OPEN_PROMPT(1, 'Saturday', harmless)}`);
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['pending', 'pending']);
    await w.ownerSays(w.alex, 'yes');
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['executed', 'pending']);
    expect((await a2aBodies(w)).map((m) => m.body)).toEqual([harmless]);
    await nothingCrossed();
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('verify seam round 2: reply-to on the fixed "Which one?" line', () => {
  it('a held release and a booking: a yes replying to the Which-one line resolves neither; nothing crosses, nothing is booked', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    taintedTurn(w, w.alex, [talk('t', 'Saturday', SECRET), book('b')]);
    await w.ownerSays(w.alex, SECRET);
    expect(w.textsTo(w.alex.address).slice(-2)).toEqual([PROMPT, DINNER_PROMPT(2)]);
    await w.ownerSays(w.alex, 'yes');
    const line = alexOut().find((m) => m.text.startsWith('Which one?'))!;
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: line.transportMessageId });
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['pending', 'pending']);
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toEqual([]);
    await nothingCrossed();
    // Each button still answers each in one tap.
    const ids = (await w.db.query<{ id: string; ref: number }>('SELECT id, ref FROM approvals ORDER BY ref')).rows;
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${ids[0]!.id}` });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${ids[1]!.id}` });
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['denied', 'executed']);
    await nothingCrossed();
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('verify seam round 2: README "When one message makes Violet ask twice", read literally', () => {
  /**
   * README.md, Known limits: "answer the first; Violet shows the second again; your next yes
   * or no answers it". S1: after `yes 1` the resolver shows #2 again right below its
   * confirmation line, so two typed answers settle both questions.
   */
  it('two typed yeses (the first naming #1) answer both questions, as the README says', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const conv = await cleanOpen(w);
    taintedTurn(w, w.alex, [tell('g', conv, 'Thursday works.'), talk('t', 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'Tell Sam Thursday works, and about Saturday');
    await w.ownerSays(w.alex, 'yes 1');
    await w.ownerSays(w.alex, 'yes');
    expect([await statusByRef(w, w.alex, 1), await statusByRef(w, w.alex, 2)]).toEqual(['executed', 'executed']);
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(readme).toContain('When one message makes Violet ask twice, answer the first (yes and its number); Violet shows the second again, and your next yes or no answers it');
  });

  it('what happens: after yes 1 the confirmation, then #2 shown again as a genuine delivery; nothing of #2 crosses before the next yes', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    const conv = await cleanOpen(w);
    taintedTurn(w, w.alex, [tell('g', conv, 'Thursday works.'), talk('t', 'Saturday', SECRET)]);
    await w.ownerSays(w.alex, 'Tell Sam Thursday works, and about Saturday');
    await w.ownerSays(w.alex, 'yes 1');
    expect(w.textsTo(w.alex.address).slice(-2)).toEqual(["Told Sam's Violet: “Thursday works.”", `Just to be sure: ${OPEN_PROMPT(2, 'Saturday', SECRET)}`]);
    expect(await statusByRef(w, w.alex, 2)).toBe('pending');
    await nothingCrossed();
    await w.ownerSays(w.alex, 'yes');
    expect(await statusByRef(w, w.alex, 2)).toBe('executed');
    expect(await i19Violations(w)).toEqual([]);
  });
});
