import { expect } from 'vitest';
import { createTestWorld } from '../../helpers/world.js';
import { a2aMessages, FRI, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';

/** One owner message and the texts a (compromised) Brain releases in that turn: [brief] or [topic, brief]. */
export interface HeldCase {
  ownerText: string;
  texts: string[];
}

/**
 * I20 against a list of cases (the former owner-verbatim cases among them): in one world, each
 * owner message runs a tainted Brain turn (it reads the calendar first) that releases the case's
 * texts with talk_to_agent. Every release must be held for a yes/no showing the exact brief,
 * nothing may reach a2a_messages or Sam's side, and the owner's no then drops it.
 */
export async function expectEveryReleaseHeld(cases: HeldCase[]): Promise<void> {
  const w = await createTestWorld();
  try {
    scriptEnvoy(w, w.sam, () => ['ok']);
    for (const [n, c] of cases.entries()) {
      const topic = c.texts.length > 1 ? c.texts[0]! : 'Plans';
      const brief = c.texts.at(-1)!;
      w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
        [
          respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]),
          respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic, brief })]),
          respond([{ type: 'text', text: "I'll check with you first." }]),
        ][Math.min(stepOf(req), 2)]!,
      );
      await w.ownerSays(w.alex, c.ownerText);
      const label = JSON.stringify(c);
      expect((await w.actions({ action: 'a2a.release_held' })).length, label).toBe(n + 1);
      const prompts = w.textsTo(w.alex.address).filter((t) => t.endsWith('Send? Reply yes or no.'));
      expect(prompts.length, label).toBe(n + 1);
      expect(prompts.at(-1), label).toContain(`: “${brief}” Send?`);
      expect(await a2aMessages(w), label).toEqual([]);
      expect(w.llm.calls.filter((r) => r.meta.agentId === w.sam.agent.id), label).toEqual([]);
      await w.ownerSays(w.alex, 'no');
      expect(w.lastTo(w.alex.address), label).toBe("Okay, I won't send it.");
    }
    expect(await a2aMessages(w)).toEqual([]);
    expect(await w.actions({ action: 'a2a.release' })).toEqual([]);
  } finally {
    await w.close();
  }
}
