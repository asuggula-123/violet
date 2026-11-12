/**
 * Q3 / Q4 / Q9: the transcript an owner reads is complete (nothing cut at any stored limit),
 * shows the declared window and which proposal an accept or decline answers, and says whose
 * calendars each proposed event is on for the owner reading it. Q5: the owner gets it by typing
 * `transcript`, with no model call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatRange } from '../../../src/brain/time.js';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, envoyCalls, FRI, onlyConversation, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';

/**
 * `n` characters ending in a marker; `ﬁ` and `½` grow under NFKC folding, so a cap without room
 * would cut. Release texts (topic, brief) are stored NFKC-canonical already, so they are ASCII here.
 */
const atLimit = (n: number, tag: string, unit = 'ﬁ½ ') => {
  const end = `${tag}-END`;
  return `${unit.repeat(Math.floor((n - end.length) / unit.length))}${'x'.repeat((n - end.length) % unit.length)}${end}`;
};

/** A scripted Envoy whose k-th turn (counted at step 0) answers with `turns[k]` (the last one repeats). */
function envoyTurns(w: TestWorld, p: Persona, turns: Array<(req: LlmRequest) => LlmResponse>): void {
  let turn = -1;
  w.llm.on({ agentId: p.agent.id, mind: 'envoy' }, (req) => {
    if (stepOf(req) === 0) turn += 1;
    if (stepOf(req) > 0) return respond([{ type: 'text', text: 'done' }]);
    return turns[Math.min(turn, turns.length - 1)]!(req);
  });
}

describe('Q3/Q4/Q9: the transcript is complete, for both owners', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('every field at its stored limit is shown whole, with the window, proposal numbers and reader-relative calendars', async () => {
    w = await createTestWorld();
    const topic = atLimit(80, 'TOPIC', 'ab ');
    const brief = atLimit(600, 'BRIEF', 'ab ');
    const summary1 = atLimit(500, 'SUMMARY1');
    const summary2 = atLimit(500, 'SUMMARY2');
    // P1/P2 (what you see is what gets booked): a title or location is stored canonical (NFKC)
    // and both owners' prompts must show it whole, so the longest a proposal can hold is the title
    // at its stored limit (120, canonical text) with a location that still fits the prompt line.
    const title = atLimit(120, 'TITLE', 'ab ');
    const location = atLimit(36, 'PLACE', 'ab ');
    const reason = atLimit(300, 'REASON');
    const said = atLimit(1000, 'SAID');
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('o', 'talk_to_agent', { with: 'Sam', topic, brief, window_start: FRI.windowStart, window_end: FRI.windowEnd })])
        : respond([{ type: 'text', text: 'Asked.' }]),
    );
    const ev = { title, ...FRI.dinner, location };
    const ev4 = { title: 'Dinner', ...FRI.dinner, location: "Luigi's" };
    envoyTurns(w, w.sam, [
      () => respond([toolUse('p1', 'propose', { summary: summary1, events: [{ ...ev, calendars: 'mine' }] })]),
      () => respond([toolUse('p2', 'propose', { summary: summary2, events: [{ ...ev4, calendars: 'both' }, { ...ev4, title: 'Call', location: undefined, calendars: 'theirs' }] })]),
      () => respond([toolUse('s', 'say', { text: said })]),
    ]);
    envoyTurns(w, w.alex, [
      () => respond([toolUse('d', 'decline', { proposal_seq: 2, reason })]),
      () => respond([toolUse('a', 'accept', { proposal_seq: 4 })]),
    ]);
    await w.ownerSays(w.alex, 'Ask Sam about dinner on Friday');
    const conv = await onlyConversation(w);
    expect(conv.status).toBe('awaiting_approval');

    const range = formatRange(new Date(FRI.dinner.start), new Date(FRI.dinner.end), 'America/New_York');
    const f = (s: string) => `“${s.normalize('NFKC')}”`;
    const lines = async (p: Persona) => (await w.app.a2a!.transcript(p.agent.id, conv.id)).split('\n');
    const window = 'time window Fri Nov 13, 12:00 AM – Sat Nov 14, 12:00 AM';
    expect(await lines(w.alex)).toEqual([
      `Transcript: Violet ↔ Sam's Violet, ${f(topic)} (awaiting_approval)`,
      `Violet opened ${f(topic)} (${window}): ${f(brief)}`,
      `Sam's Violet proposed (proposal 2): ${f(title)} — ${range} at ${f(location)}, on Sam's calendar only. Summary: ${f(summary1)}`,
      `Violet declined proposal 2: ${f(reason)}`,
      `Sam's Violet proposed (proposal 4): ${f('Dinner')} — ${range} at ${f("Luigi's")}, on both calendars; “Call” — ${range}, on your calendar only. Summary: ${f(summary2)}`,
      'Violet accepted proposal 4 (both owners are asked).',
    ]);
    expect(await lines(w.sam)).toEqual([
      `Transcript: Violet ↔ Alex's Violet, ${f(topic)} (awaiting_approval)`,
      `Alex's Violet opened ${f(topic)} (${window}): ${f(brief)}`,
      `Violet proposed (proposal 2): ${f(title)} — ${range} at ${f(location)}, on your calendar only. Summary: ${f(summary1)}`,
      `Alex's Violet declined proposal 2: ${f(reason)}`,
      `Violet proposed (proposal 4): ${f('Dinner')} — ${range} at ${f("Luigi's")}, on both calendars; “Call” — ${range}, on Alex's calendar only. Summary: ${f(summary2)}`,
      "Alex's Violet accepted proposal 4 (both owners are asked).",
    ]);
    // Every marker made it through whole.
    for (const p of [w.alex, w.sam]) {
      const t = await w.app.a2a!.transcript(p.agent.id, conv.id);
      for (const tag of ['TOPIC', 'BRIEF', 'SUMMARY1', 'SUMMARY2', 'TITLE', 'PLACE', 'REASON']) expect(t).toContain(`${tag}-END”`);
      expect(t).not.toContain('…');
    }
  });

  it('a conversation without a window says so; a plain text message is shown whole', async () => {
    w = await createTestWorld();
    const said = atLimit(1000, 'SAID');
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('o', 'talk_to_agent', { with: 'Sam', topic: 'Weekend', brief: 'Plans?' })]) : respond([{ type: 'text', text: 'Asked.' }]),
    );
    scriptEnvoy(w, w.sam, () => [[toolUse('s', 'say', { text: said })], 'ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    await w.ownerSays(w.alex, 'Ask Sam about the weekend');
    const conv = await onlyConversation(w);
    expect((await w.app.a2a!.transcript(w.alex.agent.id, conv.id)).split('\n').slice(1)).toEqual([
      'Violet opened “Weekend” (no time window): “Plans?”',
      `Sam's Violet: “${said.normalize('NFKC')}”`,
    ]);
  });
});

describe('Q5: the `transcript` owner command (code, no model call)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  const brainCalls = () => w.llm.calls.filter((c) => c.meta.mind === 'brain').length;
  const transcripts = (p: Persona) => w.transport.sent.filter((m) => m.toAddress === p.address && m.purpose === 'transcript').map((m) => m.text);

  async function dinner(): Promise<string> {
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, (req) => (/Sam can do 7/.test(JSON.stringify(req.messages)) ? ['ok'] : [[toolUse('s', 'say', { text: 'Sam can do 7.' })], 'ok']));
    scriptEnvoy(w, w.alex, () => ['waiting']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    return (await onlyConversation(w)).id;
  }

  it('no conversation yet: one fixed line, no model call, logged', async () => {
    w = await createTestWorld();
    await w.ownerSays(w.alex, 'transcript');
    expect(w.textsTo(w.alex.address)).toEqual(['No agent conversations yet, so there is no transcript.']);
    expect(brainCalls()).toBe(0);
    expect((await w.actions({ action: 'a2a.transcript' })).map((a) => a.detail.conversationId)).toEqual([null]);
  });

  it('any case and spaces; both owners get their own rendering of the same conversation', async () => {
    w = await createTestWorld();
    const id = await dinner();
    const calls = brainCalls();
    await w.ownerSays(w.alex, '  TranScript ');
    await w.ownerSays(w.sam, 'TRANSCRIPT');
    expect(brainCalls()).toBe(calls);
    expect(transcripts(w.alex)).toEqual([await w.app.a2a!.transcript(w.alex.agent.id, id)]);
    expect(transcripts(w.sam)).toEqual([await w.app.a2a!.transcript(w.sam.agent.id, id)]);
    expect(transcripts(w.sam)[0]).toContain("Alex's Violet opened “Dinner Friday”");
    // Not the command: anything more goes to the Brain as usual.
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'Here you go.' }]));
    await w.ownerSays(w.alex, 'transcript please');
    expect(brainCalls()).toBe(calls + 1);
    expect(transcripts(w.alex)).toHaveLength(1);
  });

  it('several conversations: the one started last', async () => {
    w = await createTestWorld();
    await dinner();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('o', 'talk_to_agent', { with: 'Sam', topic: 'Weekend', brief: 'Plans?' })]) : respond([{ type: 'text', text: 'Asked.' }]),
    );
    await w.ownerSays(w.alex, 'Ask Sam about the weekend');
    await w.ownerSays(w.alex, 'transcript');
    expect(transcripts(w.alex)).toHaveLength(1);
    expect(transcripts(w.alex)[0]!.split('\n')[0]).toBe("Transcript: Violet ↔ Sam's Violet, “Weekend” (open)");
  });

  it('while an approval is pending: the transcript sits between, so a bare yes gets the prompt again, then the yes under it counts', async () => {
    w = await createTestWorld();
    const id = await dinner();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]),
        respond([toolUse('g', 'tell_envoy', { conversation: id, guidance: '7 works for Alex.' })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Tell it 7 works');
    const prompt = w.lastTo(w.alex.address)!;
    expect(prompt).toBe("#1 Tell Sam's Violet: “7 works for Alex.” Send? Reply yes or no.");
    await w.ownerSays(w.alex, 'transcript');
    expect(transcripts(w.alex)).toHaveLength(1);
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${prompt}`);
    expect((await w.db.query<{ status: string }>("SELECT status FROM approvals WHERE kind = 'a2a_release'")).rows[0]!.status).toBe('pending');
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe("Told Sam's Violet: “7 works for Alex.”");
  });

  it('while paused: held like every owner message, also after resume', async () => {
    w = await createTestWorld();
    await dinner();
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'transcript');
    expect(transcripts(w.alex)).toEqual([]);
    expect((await w.actions({ action: 'inbound.held', agentId: w.alex.agent.id })).length).toBe(1);
    await w.ownerSays(w.alex, 'resume');
    expect(transcripts(w.alex)).toEqual([]);
    expect(await w.actions({ action: 'a2a.transcript' })).toEqual([]);
  });

  it('a stranger, or another agent, sending the word: not an owner message, nothing is sent', async () => {
    w = await createTestWorld();
    await w.strangerSays(w.alex, 'stranger-1', 'transcript');
    expect(transcripts(w.alex)).toEqual([]);
    expect(w.textsTo('stranger-1')).toHaveLength(1); // the canned reply, nothing else
    // Sam's Envoy says the word to Alex's agent: it is conversation text, not an owner message.
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, (req) => (/transcript/.test(JSON.stringify(req.messages)) ? ['ok'] : [[toolUse('s', 'say', { text: 'transcript' })], 'ok']));
    scriptEnvoy(w, w.alex, () => ['ok']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(envoyCalls(w, w.alex).length).toBeGreaterThan(0);
    expect(transcripts(w.alex)).toEqual([]);
    expect(await w.actions({ action: 'a2a.transcript' })).toEqual([]);
  });
});
