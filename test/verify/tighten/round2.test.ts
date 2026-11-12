/**
 * tighten independent verifier, round 2: adversarial tests against I20 (every release in a
 * tainted Brain turn is held for the owner's yes on exactly what crosses) and the claims the
 * README makes about it. A failing test here is evidence of a defect (see the verifier
 * report); none of these weaken or replace the milestone's tests.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainToolCtx } from '../../../src/brain/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, respond, scriptEnvoy, stepOf, toolUse } from '../../unit/a2a/helpers.js';

let w: TestWorld;
let open = false;
afterEach(async () => {
  if (open) await w.close();
  open = false;
});

async function world(): Promise<void> {
  w = await createTestWorld();
  open = true;
  w.gmail.seed(w.alex.owner.id, { id: 'm1', threadId: 't', from: 'news@example.com', to: 'alex@example.com', subject: 'Hi', snippet: 'hello', bodyText: 'hello', date: w.clock.now() });
  scriptEnvoy(w, w.sam, () => ['ok']);
  scriptEnvoy(w, w.alex, () => ['ok']);
}

/** Everything Sam's side (its model requests, Sam's phone) received. */
const samSide = () => JSON.stringify([w.llm.calls.filter((c) => c.meta.agentId === w.sam.agent.id), w.textsTo(w.sam.address)]);

const heldPrompts = async () =>
  (await w.db.query<{ id: string; status: string; prompt: string }>("SELECT id, status, prompt FROM approvals WHERE kind = 'a2a_release' ORDER BY ref")).rows;

function ctxOf(p: Persona, callKey: string, tainted: boolean): BrainToolCtx {
  return { agent: p.agent, owner: p.owner, turn: { messageId: `verify-${callKey}`, ownerText: 'Ask Sam about coffee on Friday', tainted }, now: w.clock.now(), callKey };
}

async function callTool(name: string, input: unknown, ctx: BrainToolCtx): Promise<string> {
  const tool = w.app.brain!.tools.get(name)!;
  return tool.handler(tool.input.parse(input), ctx);
}

describe('tighten verify round 2: I20, values that cross but are not shown', () => {
  it('I20: the year of the window crosses but the prompt does not show it (a window in 2037 reads "Fri Nov 13" like this week)', async () => {
    await world();
    // Fooled by the email: hide data in the YEAR (Nov 13 is a Friday in 2026 and in 2037, 2043, …).
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'read_email', { id: 'm1' })]),
        respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee on Friday?', window_start: '2037-11-13T18:00:00-05:00', window_end: '2037-11-13T21:00:00-05:00' })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Ask Sam about coffee on Friday');
    const [held] = await heldPrompts();
    expect(held?.status).toBe('pending');
    const prompt = held!.prompt;
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ minutes: 5 });
    // What Alex said yes to must cover what crossed: if the prompt has no year, 2037 must not reach Sam's side.
    if (!prompt.includes('2037')) expect(samSide(), `prompt was: ${prompt}`).not.toContain('2037');
  });

  it('I20: two different windows never render the same prompt (DST fall-back hour: 1:30 AM EDT vs 1:30 AM EST)', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      // Corrected by the tighten milestone (round 2): this read only the LAST message, which at
      // step 1 is the read_email tool result, so both turns asked for the same -04:00 start and the
      // two prompts were identical because the two windows were. The whole request is searched now.
      const start = /second/.test(JSON.stringify(req.messages)) ? '2026-11-01T01:30:00-05:00' : '2026-11-01T01:30:00-04:00';
      return [
        respond([toolUse('r', 'read_email', { id: 'm1' })]),
        respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee?', window_start: start, window_end: '2026-11-10T00:00:00-05:00' })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!;
    });
    await w.ownerSays(w.alex, 'first');
    await w.ownerSays(w.alex, 'second');
    const p = (await heldPrompts()).map((h) => h.prompt.replace(/^#\d+ /, ''));
    expect(p).toHaveLength(2);
    expect(p[0], 'an hour of the window crosses that the prompt does not show').not.toBe(p[1]);
  });
});

describe('tighten verify round 2: I20, a retried call whose held approval was already answered', () => {
  const talk = { with: 'Sam', topic: 'Coffee', brief: 'Coffee on Friday?' };

  it('after the owner said no, the same call (same callKey) in an untainted retry sends nothing', async () => {
    await world();
    // Attempt 1: tainted, held. (The tool memo is what normally stops a re-run; this is the
    // crash-before-memo case, with the taint source gone on the retry.)
    expect(await callTool('talk_to_agent', talk, ctxOf(w.alex, 'K-no', true))).toMatch(/^Not sent\./);
    await w.ownerSays(w.alex, 'no');
    expect(w.lastTo(w.alex.address)).toBe("Okay, I won't send it.");
    // Attempt 2: the same tool call, same callKey, the turn no longer tainted.
    await callTool('talk_to_agent', talk, ctxOf(w.alex, 'K-no', false)).catch(() => 'refused');
    await w.advance({ minutes: 5 });
    expect(await a2aMessages(w), 'released after the owner said no').toEqual([]);
    expect(samSide()).not.toContain('Coffee on Friday');
  });

  it('after the owner said yes, the same call (same callKey) in an untainted retry does not open a second conversation', async () => {
    await world();
    expect(await callTool('talk_to_agent', talk, ctxOf(w.alex, 'K-yes', true))).toMatch(/^Not sent\./);
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ minutes: 5 });
    await callTool('talk_to_agent', talk, ctxOf(w.alex, 'K-yes', false)).catch(() => 'refused');
    await w.advance({ minutes: 5 });
    expect((await a2aMessages(w)).filter((m) => m.kind === 'open'), 'the approved release was sent twice').toHaveLength(1);
  });
});

describe('tighten verify round 2: README "Known limits" hold claim', () => {
  // Corrected by the tighten milestone (round 2): the verifier showed the README's old claim
  // ("lasts while that text is in your last 40 messages") was untrue: every reply written in a
  // tainted turn is stored as tainted, so the taint carries itself forward. The fix is to the
  // docs (the suggested fix; decay would be a design change to the history rule), so this test
  // now checks that the README states what happens, and that it is what happens.
  it('README: the hold does not wear off by itself: 30 ordinary exchanges later, a clean request is still held', async () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(readme).not.toContain('that text is in your last 40 messages');
    expect(readme).toContain('does not wear off by');
    await world();
    // One turn reads an email (third-party text) …
    let readOnce = false;
    let phase: 'chat' | 'ask' = 'chat';
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      if (phase === 'ask') {
        return stepOf(req) === 0 ? respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee on Friday?' })]) : respond([{ type: 'text', text: 'Asked.' }]);
      }
      if (!readOnce && stepOf(req) === 0) {
        readOnce = true;
        return respond([toolUse('r', 'read_email', { id: 'm1' })]);
      }
      return respond([{ type: 'text', text: 'Okay.' }]);
    });
    await w.ownerSays(w.alex, 'Any news in my email?');
    // … then 30 exchanges with no third-party text at all (60 messages: the email turn is far outside the last 40).
    for (let i = 0; i < 30; i++) await w.ownerSays(w.alex, `Note ${i}: buy milk`);
    phase = 'ask';
    await w.ownerSays(w.alex, 'Ask Sam about coffee on Friday');
    const turns = await w.actions({ action: 'brain.turn', agentId: w.alex.agent.id });
    const tainted = turns.map((t) => t.detail.tainted);
    expect(tainted[0]).toBe(true);
    expect(tainted.at(-1), 'the README says the hold does not wear off by itself').toBe(true);
    expect(await a2aMessages(w)).toEqual([]);
    expect((await heldPrompts()).map((h) => h.status)).toEqual(['pending']);
  });
});
