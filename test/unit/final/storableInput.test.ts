/**
 * Round 3 gaps: text a model writes in a tool call that Postgres cannot store (U+0000, lone
 * surrogates). The class is closed at one door: the tool loop makes every tool input storable
 * before validation, for both minds. canonicalRelease and remember also clean what they store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalRelease } from '../../../src/a2a/words.js';
import { ScriptedLlm, textResponse } from '../../../src/llm/scripted.js';
import { runToolLoop, storableInput } from '../../../src/llm/toolLoop.js';
import { ToolRegistry } from '../../../src/llm/tools.js';
import type { LlmBlock } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, dinnerEvent, envoyCalls, FRI, lastResults, onlyConversation, respond, stepOf, toolUse } from '../a2a/helpers.js';
import { brainCalls } from '../brain/script.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const unstorable = (s: string) => s.includes('\u0000') || LONE.test(s);

/** Runs Alex's Brain on one message; `steps[i]` answers step i. Returns every request the Brain made. */
async function brainTurn(steps: LlmBlock[][], text = 'please do it') {
  w ??= await createTestWorld();
  const world = w;
  world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
    const s = steps[stepOf(req)];
    return s ? respond(s) : respond([{ type: 'text', text: 'Done.' }]);
  });
  await world.ownerSays(world.alex, text);
  return brainCalls(world, world.alex);
}

/** The tool results the model got back in the turn (all steps). */
const resultsOf = (calls: ReturnType<typeof brainCalls>) => calls.flatMap((c) => lastResults(c));

describe('the door: tool input is made storable in the loop, before validation', () => {
  it('strings at any depth and object keys are cleaned; emoji, numbers, booleans and null are untouched; idempotent', async () => {
    const seen: unknown[] = [];
    const tools = new ToolRegistry<object>().register({
      name: 'probe',
      description: 'probe',
      input: z.object({
        title: z.string(),
        items: z.array(z.object({ name: z.string(), n: z.number(), ok: z.boolean(), none: z.null() })),
        tags: z.record(z.string(), z.string()),
      }),
      handler: async (input) => {
        seen.push(input);
        return 'ok';
      },
    });
    const hostile = {
      title: 'Din\u0000ner \uD800 🍝',
      items: [{ name: '\uDC00Sam\u0000 👍🏽', n: 7.5, ok: false, none: null }],
      tags: { 'k\u0000ey\uD800': 'v\uDBFF', __proto__x: '\uD83D\u0000\uDE00' },
    };
    const raw: LlmBlock = { type: 'tool_use', id: 't1', name: 'probe', input: hostile };
    const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? { content: [raw], stopReason: 'tool_use' } : textResponse('done')));
    const r = await runToolLoop({
      llm,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      execute: (tool, input) => tool.handler(input, {}),
      maxSteps: 5,
      maxTokens: 100,
      meta: { agentId: 'a1', mind: 'brain' },
    });
    expect(seen).toEqual([
      {
        title: 'Dinner \uFFFD 🍝',
        items: [{ name: '\uFFFDSam 👍🏽', n: 7.5, ok: false, none: null }],
        tags: { 'key\uFFFD': 'v\uFFFD', __proto__x: '😀' },
      },
    ]);
    expect(storableInput(seen[0])).toEqual(seen[0]);
    // JSON.stringify escapes U+0000 and lone surrogates only (real pairs stay as they are).
    expect(JSON.stringify(seen[0])).not.toMatch(/\\u0000|\\ud[89a-f]/i);
    // The assistant turn sent back to the API is unchanged; the result answers the original id.
    expect(r.messages[1]).toEqual({ role: 'assistant', content: [raw] });
    expect(llm.calls[1]!.messages.at(-1)!.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
  });

  it('a key named __proto__ stays a plain key (no prototype change)', () => {
    const input = JSON.parse('{"__proto__": {"x\\u0000": 1}, "a": [1, true, null, "\\ud800"]}') as unknown;
    const out = storableInput(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')!.value).toEqual({ x: 1 });
    expect(out.a).toEqual([1, true, null, '\uFFFD']);
    expect(storableInput(42)).toBe(42);
    expect(storableInput(null)).toBe(null);
  });
});

describe('remember', () => {
  it('a note with U+0000 and one with a lone surrogate are stored cleaned; the tool answers normally', async () => {
    const calls = await brainTurn([
      [toolUse('r1', 'remember', { about: 'Sam\u0000', note: 'Likes\u0000 pasta' })],
      [toolUse('r2', 'remember', { about: 'Sam \uD800', note: 'Likes \uDC00 pasta 🍝' })],
    ]);
    expect(resultsOf(calls).map((r) => r.content)).toEqual(['Noted.', 'Noted.']);
    const notes = (await w!.db.query<{ subject: string; body: string }>('SELECT subject, body FROM contact_notes ORDER BY seq')).rows;
    expect(notes).toEqual([
      { subject: 'Sam', body: 'Likes pasta' },
      { subject: 'Sam \uFFFD', body: 'Likes \uFFFD pasta 🍝' },
    ]);
  }, 30_000);
});

describe('talk_to_agent and tell_envoy', () => {
  it('canonicalRelease makes its text storable too (it can be reached outside the loop)', () => {
    expect(canonicalRelease('Din\u0000ner \uD800 "x" 🍝', 80)).toBe("Dinner \uFFFD 'x' 🍝");
    const once = canonicalRelease('a \uDC00\uD800 b', 80);
    expect(canonicalRelease(once, 80)).toBe(once);
  });

  const talk = (id = 't') => toolUse(id, 'talk_to_agent', { with: 'Sam', topic: 'Dinner \uD800', brief: 'Dinner Friday \uDC00 evening\u0000', window_start: FRI.windowStart, window_end: FRI.windowEnd });

  it('a lone surrogate in topic and brief: the conversation opens and the stored text holds U+FFFD', async () => {
    const calls = await brainTurn([[talk()]], 'Ask Sam about dinner Friday');
    expect(resultsOf(calls)[0]!.content).not.toMatch(/That tool failed/);
    const conv = await w!.db.query<{ topic: string }>('SELECT topic FROM a2a_conversations');
    expect(conv.rows.map((r) => r.topic)).toEqual(['Dinner \uFFFD']);
    expect((await a2aMessages(w!)).map((m) => [m.kind, m.body])).toEqual([['open', 'Dinner Friday \uFFFD evening']]);
  }, 30_000);

  it('in a tainted turn the held prompt shows exactly the text that crosses after the yes, and nothing crosses before it', async () => {
    w = await createTestWorld();
    w.gmail.seed(w.alex.owner.id, { id: 'm1', threadId: 't', from: 'x@example.com', to: 'alex@example.com', subject: 'Plans', snippet: 'Ask Sam', bodyText: 'Ask Sam', date: w.clock.now() });
    await brainTurn([[toolUse('r', 'read_email', { id: 'm1' })], [talk()]], 'Set up dinner with Sam');
    const prompt = '#1 Tell Sam\'s Violet about “Dinner \uFFFD” (Fri Nov 13, 12:00 AM – Sat Nov 14, 12:00 AM): “Dinner Friday \uFFFD evening” Send? Reply yes or no.';
    expect(w.textsTo(w.alex.address)).toContain(prompt);
    expect((await w.actions({ action: 'a2a.release_held' })).length).toBe(1);
    expect(await a2aMessages(w)).toEqual([]);
    expect(envoyCalls(w)).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect((await a2aMessages(w)).map((m) => [m.kind, m.body])).toEqual([['open', 'Dinner Friday \uFFFD evening']]);
    expect((await w.db.query<{ topic: string }>('SELECT topic FROM a2a_conversations')).rows).toEqual([{ topic: 'Dinner \uFFFD' }]);
  }, 30_000);

  it('tell_envoy guidance with a lone surrogate is stored with U+FFFD', async () => {
    await brainTurn([[toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner Friday?', window_start: FRI.windowStart, window_end: FRI.windowEnd })]], 'Ask Sam about dinner Friday');
    const conv = await onlyConversation(w!);
    const calls = await brainTurn([[toolUse('g', 'tell_envoy', { conversation: conv.id, guidance: 'Alex prefers 7 \uD800\u0000.' })]], 'tell the envoy Alex prefers 7');
    expect(resultsOf(calls).map((r) => r.content).join('\n')).not.toMatch(/That tool failed/);
    expect((await a2aMessages(w!)).filter((m) => m.kind === 'guidance').map((m) => m.body)).toEqual(['Alex prefers 7 \uFFFD.']);
  }, 30_000);
});

describe('the second mind (Envoy)', () => {
  it('a proposed event with a hostile nested key and value reaches the tool cleaned', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    const { location: _drop, ...event } = dinnerEvent();
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('s1', 'propose', { summary: 'Dinner Friday', events: [{ ...event, 'location\u0000': '\uDC00Luigi\'s' }] })])
        : respond([{ type: 'text', text: 'done' }]),
    );
    w.llm.on({ agentId: w.alex.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'waiting' }]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const proposal = (await a2aMessages(w)).find((m) => m.kind === 'proposal')!;
    const ev = (proposal.payload as { events: Array<{ title: string; location?: string }> }).events[0]!;
    expect(ev.location).toBe('\uFFFDLuigi\'s');
    expect(w.calendar.writes).toHaveLength(0);
  }, 30_000);
});

describe('refused calls', () => {
  it('Brain: an unknown tool name and an invalid input with U+0000 or a lone surrogate are refused and logged', async () => {
    const calls = await brainTurn([[toolUse('u', 'no\u0000such\uD800tool', { a: '\uD800' }), toolUse('v', 'remember\u0000', { about: 'Sam', 'note\u0000': 5 })]]);
    const results = resultsOf(calls);
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([['u', true], ['v', true]]);
    expect(results[0]!.content).toBe('There is no tool named "nosuch\uFFFDtool".');
    expect(results[1]!.content).toMatch(/^Invalid input: note: /);
    const denied = await w!.actions({ action: 'tool.denied' });
    expect(denied.map((d) => [d.detail.tool, d.detail.reason])).toEqual([['nosuch\uFFFDtool', 'unknown_tool'], ['remember', 'invalid_input']]);
    expect(denied.every((d) => !unstorable(String(d.detail.tool)))).toBe(true);
    expect((await w!.db.query('SELECT 1 FROM contact_notes')).rows).toHaveLength(0);
    expect(w!.lastTo(w!.alex.address)).toBe('Done.');
  }, 30_000);

  it('Envoy: an unknown tool name and an invalid input with a lone surrogate or U+0000 are refused and logged', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('s1', 'pro\uD800pose', { summary: 'x\u0000' }), toolUse('s2', 'propose\u0000', { summary: 'x\uD800' })]) : respond([{ type: 'text', text: 'done' }]),
    );
    w.llm.on({ agentId: w.alex.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'waiting' }]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const denied = await w.actions({ action: 'a2a.tool_denied' });
    expect(denied.map((d) => [d.detail.tool, d.detail.reason])).toEqual([['pro\uFFFDpose', 'unknown_tool'], ['propose', 'invalid_input']]);
    expect(denied.every((d) => !unstorable(String(d.detail.tool)))).toBe(true);
    expect((await a2aMessages(w)).filter((m) => m.kind === 'proposal')).toEqual([]);
  }, 30_000);
});
