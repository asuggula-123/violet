import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, envoyCalls, honestDinnerEnvoys, respond, scriptEnvoy, stepOf, toolUse } from './helpers.js';

describe('a2a and pause (I14)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it("a paused agent's Envoy does not run; the peer hears nothing; resume continues the conversation", async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.sam, 'pause');
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(envoyCalls(w, w.sam)).toEqual([]);
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);

    // Alex pauses too; Sam resumes: Sam's Envoy proposes, Alex's Envoy waits.
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.sam, 'resume');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'proposal']);
    expect(envoyCalls(w, w.alex)).toEqual([]);
    const alexBefore = w.textsTo(w.alex.address).length;

    await w.ownerSays(w.alex, 'resume');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'proposal', 'accept']);
    expect(w.textsTo(w.alex.address).slice(alexBefore)).toEqual(["Resumed. I'm back on.", expect.stringMatching(/^#1 With Sam: “Dinner”/)]);
    expect(w.lastTo(w.sam.address)).toMatch(/^#1 With Alex: “Dinner”/);
  });

  it('a pause during an Envoy turn: the act is refused, nothing reaches the peer, the turn re-runs on resume', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    let paused = false;
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, async (req) => {
      if (stepOf(req) > 0) return respond([{ type: 'text', text: 'ok' }]);
      if (!paused) {
        paused = true;
        await w.app.repos.agents.setPaused(w.sam.agent.id, true); // the owner's pause lands mid-turn
      }
      return respond([toolUse('s', 'say', { text: 'Sam is free at 7.' })]);
    });
    scriptEnvoy(w, w.alex, () => ['ok']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);
    expect((await w.actions({ action: 'a2a.tool_denied' })).map((a) => a.detail.reason)).toEqual(['paused']);
    expect((await w.app.repos.flags.listByAgent(w.sam.agent.id)).filter((f) => f.kind === 'a2a_stalled')).toEqual([]);
    await w.ownerSays(w.sam, 'resume');
    expect((await a2aMessages(w)).map((m) => [m.kind, m.body])).toEqual([
      ['open', 'Alex would like dinner with Sam on Friday evening.'],
      ['text', 'Sam is free at 7.'],
    ]);
  });

  it('an Envoy question waits while paused and is sent on resume', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    let paused = false;
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, async (req) => {
      if (stepOf(req) > 0) {
        if (!paused) {
          paused = true;
          await w.app.repos.agents.setPaused(w.sam.agent.id, true); // after the question was written
        }
        return respond([{ type: 'text', text: 'ok' }]);
      }
      return respond([toolUse('q', 'ask_owner', { question: 'Is Friday good?' })]);
    });
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(w.textsTo(w.sam.address)).toEqual([]);
    await w.ownerSays(w.sam, 'resume');
    expect(w.textsTo(w.sam.address)).toEqual(["Resumed. I'm back on.", 'Violet ↔ Alex\'s Violet (“Dinner Friday”) asks: “Is Friday good?”']);
  });
});
