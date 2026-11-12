import { afterEach, describe, expect, it } from 'vitest';
import { privateMatches } from '../../../src/a2a/words.js';
import { expectEveryReleaseHeld } from '../i20/held.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, envoyCalls, FRI, lastResults, onlyConversation, respond, stepOf, toolUse } from './helpers.js';
import { brainCalls } from '../brain/script.js';

const talk = (brief: string, id = 't') =>
  toolUse(id, 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief, window_start: FRI.windowStart, window_end: FRI.windowEnd });

describe('EgressGuard phrase match (words.ts)', () => {
  const fields = ['Physio', 'Lakeside Clinic', 'Dinner Friday', 'Dr Ng', 'Pick up groceries', 'Bring the forms for the Hendricks case'];
  const names = ['Alex', 'Sam', 'Violet'];
  it('catches a distinctive single word and multi-word runs', () => {
    expect(privateMatches('Alex is at Lakeside until 6', 'dinner friday', fields, names)).toEqual(['lakeside']);
    expect(privateMatches('Alex has physio', '', fields, names)).toEqual(['physio']);
    expect(privateMatches('after seeing Dr. Ng', '', fields, names)).toEqual(['dr ng']);
    expect(privateMatches('the hendricks thing', '', fields, names)).toEqual(['hendricks']);
  });
  it('does not block ordinary words, weekday names, glue or what the owner typed', () => {
    expect(privateMatches('Dinner on Friday? Alex can pick up the kids first.', '', fields, names)).toEqual([]);
    expect(privateMatches('Alex is at Lakeside until 6', "I'm at Lakeside till 6", fields, names)).toEqual([]);
    expect(privateMatches('Dr Ng at 5', 'tell her I see dr ng at 5', fields, names)).toEqual([]);
    expect(privateMatches('forms for school', '', ['forms'], names)).toEqual(['forms']);
  });

  // I20: the owner-verbatim exception is gone. Its cases (those it let through and those it
  // held) all run here against the real release path in a tainted turn: every one is held.
  it('the former owner-verbatim cases: in a tainted turn every release is held, whoever typed the words', async () => {
    await expectEveryReleaseHeld([
      { ownerText: 'yes Sam can pick up the kids on thursday', texts: ['Yes, Sam can pick up the kids on Thursday.'] },
      { ownerText: 'yes I can pick up the kids on thursday', texts: ['Yes, Sam can pick up the kids on Thursday.'] },
      { ownerText: 'Café at 7?', texts: ['cafe at 7'] },
      { ownerText: 'ping Sam', texts: ['no yes no no yes yes no yes the a an the a the an a'] },
      { ownerText: 'ping Sam', texts: ['🙂 !!! ...'] },
      { ownerText: 'ping Sam', texts: ['Sam'] },
      { ownerText: 'Tell Sam Alex will be home Friday', texts: ['Alex will not be home Friday'] },
      { ownerText: 'Tell Sam Alex will be home Friday', texts: ['Alex will be home Friday'] },
      { ownerText: 'dinner friday', texts: ['dinner dinner friday friday'] },
      { ownerText: 'Tell Sam that Alex will pick up the kids', texts: ['Sam will pick up the kids'] },
      { ownerText: 'Tell Sam that Alex will pick up the kids', texts: ['kids', 'Alex will pick up the kids'] },
      { ownerText: 'Alex will pick up and Sam will drop off', texts: ['Sam will pick up'] },
      { ownerText: 'Alex will pick up and Sam will drop off', texts: ['Sam will drop off'] },
      { ownerText: 'Tell Sam I am home Friday', texts: ['Alex Sam home Friday'] },
      { ownerText: 'Tell Sam Alex Alex is home Friday', texts: ['Alex is home Friday Alex'] },
      { ownerText: 'Alex Sam', texts: ['Alex Sam'] },
      { ownerText: 'is it the one or the other, and is it on or off for the kids', texts: ['the or the and is it on or the off it is kids'] },
    ]);
  });
});

describe('releases (I11) with a compromised Brain', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  async function world(): Promise<void> {
    w = await createTestWorld();
    w.calendar.seed(w.alex.owner.id, { title: 'Physio', location: 'Lakeside Clinic', start: new Date('2026-11-13T17:00:00-05:00'), end: new Date('2026-11-13T18:00:00-05:00') });
    w.gmail.seed(w.alex.owner.id, { id: 'm1', threadId: 't', from: 'x@example.com', to: 'alex@example.com', subject: 'Plans', snippet: 'Ask Sam about the Lakeside thing', bodyText: 'Ask Sam about the Lakeside thing', date: w.clock.now() });
  }

  it('a brief with a private calendar phrase is blocked; the rewrite goes out', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [respond([talk('Alex has physio at Lakeside Clinic until 6, so dinner after 7.', 't1')]), respond([talk('Alex is free after 7 on Friday.', 't2')]), respond([{ type: 'text', text: 'Asked.' }])][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday');
    const call = brainCalls(w, w.alex).find((c) => stepOf(c) === 1)!;
    expect(lastResults(call)[0]).toMatchObject({ is_error: true });
    expect(lastResults(call)[0]!.content).toMatch(/calendar/);
    expect((await w.actions({ action: 'a2a.release_blocked' })).length).toBe(1);
    expect((await a2aMessages(w)).map((m) => m.body)).toEqual(['Alex is free after 7 on Friday.']);
    expect(JSON.stringify(envoyCalls(w))).not.toMatch(/Lakeside|physio/i);
  });

  it('a release in a tainted turn is held: the owner sees the exact text; yes releases it as stored', async () => {
    await world();
    const brief = 'Dinner Friday at 7 would suit Alex.';
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [respond([toolUse('r', 'read_email', { id: 'm1' })]), respond([talk(brief)]), respond([{ type: 'text', text: 'Waiting for your yes.' }])][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Set up dinner with Sam');
    expect(w.textsTo(w.alex.address)).toContain(`#1 Tell Sam's Violet about “Dinner Friday” (Fri Nov 13, 12:00 AM – Sat Nov 14, 12:00 AM): “${brief}” Send? Reply yes or no.`);
    expect(await a2aMessages(w)).toEqual([]);
    expect((await w.actions({ action: 'a2a.release_held' })).length).toBe(1);
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe(`Talking to Sam's Violet about “Dinner Friday”: “${brief}”`);
    expect((await a2aMessages(w)).map((m) => [m.kind, m.body])).toEqual([['open', brief]]);
  });

  it('no (or expiry) drops a held release', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [respond([toolUse('r', 'read_email', { id: 'm1' })]), respond([talk('Dinner at 7?')]), respond([{ type: 'text', text: 'ok' }])][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Set up dinner with Sam');
    await w.ownerSays(w.alex, 'no');
    expect(w.lastTo(w.alex.address)).toBe("Okay, I won't send it.");
    expect(await a2aMessages(w)).toEqual([]);
  });

  it("I20: in a tainted turn, even the owner's own words are held; after the yes exactly those words cross", async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [respond([toolUse('r', 'read_email', { id: 'm1' })]), respond([talk('Dinner Friday at 7?')]), respond([{ type: 'text', text: "I'll check with you first." }])][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'ask Sam: dinner friday at 7?');
    const call = brainCalls(w, w.alex).find((c) => stepOf(c) === 2)!;
    expect(lastResults(call)[0]!.content).toMatch(/^Not sent\. .*check with them first; do not say it was sent/);
    expect((await w.actions({ action: 'a2a.release_held' })).map((r) => r.detail.reason)).toEqual(['tainted']);
    expect(w.textsTo(w.alex.address)).toContain('#1 Tell Sam\'s Violet about “Dinner Friday” (Fri Nov 13, 12:00 AM – Sat Nov 14, 12:00 AM): “Dinner Friday at 7?” Send? Reply yes or no.');
    expect(await a2aMessages(w)).toEqual([]);
    expect(envoyCalls(w)).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect((await a2aMessages(w)).map((m) => m.body)).toEqual(['Dinner Friday at 7?']);
  });

  it('tell_envoy after reading an email is held', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond([talk('Dinner Friday?')]) : respond([{ type: 'text', text: 'ok' }])));
    await w.ownerSays(w.alex, 'Ask Sam about dinner Friday');
    const conv = await onlyConversation(w);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [respond([toolUse('r', 'read_email', { id: 'm1' })]), respond([toolUse('g', 'tell_envoy', { conversation: conv.id, guidance: 'Alex prefers 7.' })]), respond([{ type: 'text', text: 'ok' }])][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'check my email then tell the envoy something');
    expect(w.textsTo(w.alex.address)).toContain('#1 Tell Sam\'s Violet: “Alex prefers 7.” Send? Reply yes or no.');
    expect((await a2aMessages(w)).filter((m) => m.kind === 'guidance')).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe('Told Sam\'s Violet: “Alex prefers 7.”');
    expect((await a2aMessages(w)).filter((m) => m.kind === 'guidance').map((m) => m.body)).toEqual(['Alex prefers 7.']);
  });

  it('a calendar that cannot be read holds the release instead of waving it through', async () => {
    await world();
    w.calendar.listEvents = async () => {
      throw new Error('calendar down');
    };
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond([talk('Dinner Friday?')]) : respond([{ type: 'text', text: 'ok' }])));
    await w.ownerSays(w.alex, 'Ask Sam about dinner Friday');
    expect((await w.actions({ action: 'a2a.release_held' }))[0]!.detail.reason).toBe('calendar_unreadable');
    expect(await a2aMessages(w)).toEqual([]);
  });

  it('a peer outside the household is refused and logged', async () => {
    await world();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('t', 'talk_to_agent', { with: 'Mallory', topic: 'x', brief: 'hi' })]) : respond([{ type: 'text', text: 'ok' }]),
    );
    await w.ownerSays(w.alex, 'talk to Mallory');
    expect((await w.actions({ action: 'a2a.limit' })).map((a) => a.detail.limit)).toEqual(['not_household']);
    expect(await a2aMessages(w)).toEqual([]);
  });
});
