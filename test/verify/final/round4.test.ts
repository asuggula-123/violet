/**
 * Independent verifier, final integration pass, round 4: adversarial tests for 14c9483
 * (tool input from the model made storable at the tool loop, before validation, for both
 * minds; canonicalRelease and remember clean their text too). The questions: does cleaning at
 * the door make two texts differ that must be the same, or join texts so a check is skipped;
 * does anything still see the raw input; do odd keys or very deep / large input break the turn.
 * Failing tests are kept as evidence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedLlm, textResponse } from '../../../src/llm/scripted.js';
import { runToolLoop } from '../../../src/llm/toolLoop.js';
import { ToolRegistry } from '../../../src/llm/tools.js';
import type { LlmBlock } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, envoyCalls, FRI, lastResults, respond, stepOf, toolUse } from '../../unit/a2a/helpers.js';
import { brainCalls } from '../../unit/brain/script.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const clean = (s: string) => !s.includes('\u0000') && !LONE.test(s);

/** Alex's Brain: `steps[i]` answers step i, then 'Done.'. */
async function brainTurn(world: TestWorld, steps: LlmBlock[][], text = 'please do it') {
  world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
    const s = steps[stepOf(req)];
    return s ? respond(s) : respond([{ type: 'text', text: 'Done.' }]);
  });
  await world.ownerSays(world.alex, text);
  return brainCalls(world, world.alex);
}

/** A loop with one probe tool; returns what the tool saw and the loop result (or the error). */
async function probeLoop(input: Record<string, unknown>, name = 'probe') {
  const seen: unknown[] = [];
  const tools = new ToolRegistry<object>().register({
    name: 'probe',
    description: 'probe',
    input: z.object({ a: z.string() }).passthrough(),
    handler: async (i) => {
      seen.push(i);
      return 'ok';
    },
  });
  const raw: LlmBlock = { type: 'tool_use', id: 't1', name, input };
  const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? { content: [raw], stopReason: 'tool_use' } : textResponse('done')));
  const t0 = Date.now();
  let error: unknown = null;
  let result: Awaited<ReturnType<typeof runToolLoop>> | null = null;
  try {
    result = await runToolLoop({
      llm,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      execute: (tool, i) => tool.handler(i, {}),
      maxSteps: 5,
      maxTokens: 100,
      meta: { agentId: 'a1', mind: 'brain' },
    });
  } catch (err) {
    error = err;
  }
  return { seen, result, error, ms: Date.now() - t0, llm };
}

describe('EgressGuard sees the joined text (a NUL cannot split a private phrase past the guard)', () => {
  it('a brief with "Lake\\u0000side Cli\\u0000nic" is blocked; nothing crosses to Sam', async () => {
    w = await createTestWorld();
    w.calendar.seed(w.alex.owner.id, { title: 'Physio', location: 'Lakeside Clinic', start: new Date('2026-11-13T17:00:00-05:00'), end: new Date('2026-11-13T18:00:00-05:00') });
    const brief = 'Alex has phys\u0000io at Lake\u0000side Cli\u0000nic until 6, so dinner after 7.';
    const calls = await brainTurn(w, [[toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner', brief, window_start: FRI.windowStart, window_end: FRI.windowEnd })]], 'Set up dinner with Sam on Friday');
    const res = calls.flatMap((c) => lastResults(c))[0]!;
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/calendar/);
    expect((await w.actions({ action: 'a2a.release_blocked' })).length).toBe(1);
    expect(await a2aMessages(w)).toEqual([]);
    expect(JSON.stringify(envoyCalls(w))).not.toMatch(/Lake|physio/i);
  }, 30_000);
});

describe('I20 own words: the check and what crosses use the same cleaned text', () => {
  it('the owner typed "Lakeside Clinic"; the model writes "Lake\\u0000side Clinic": released, and the crossing text is the joined one', async () => {
    w = await createTestWorld();
    w.calendar.seed(w.alex.owner.id, { title: 'Physio', location: 'Lakeside Clinic', start: new Date('2026-11-13T17:00:00-05:00'), end: new Date('2026-11-13T18:00:00-05:00') });
    const brief = 'Dinner Friday near Lake\u0000side Clinic after 7.';
    await brainTurn(w, [[toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner', brief, window_start: FRI.windowStart, window_end: FRI.windowEnd })]], 'Ask Sam about dinner Friday near Lakeside Clinic');
    expect((await w.actions({ action: 'a2a.release_blocked' })).length).toBe(0);
    expect((await a2aMessages(w)).map((m) => m.body)).toEqual(['Dinner Friday near Lakeside Clinic after 7.']);
  }, 30_000);
});

describe('object keys that collide or turn special once cleaned', () => {
  it('solo booking with "title" and "title\\u0000", "location" and "location\\u0000": the stored payload, the prompt and the calendar write agree', async () => {
    w = await createTestWorld();
    await brainTurn(w, [[toolUse('c', 'request_calendar_event', { title: 'Dinner', 'title\u0000': 'Secret plan', ...FRI.dinner, location: "Luigi's", 'location\u0000': 'Elsewhere' })]], 'book dinner friday');
    const rows = (await w.db.query<{ payload: { title: string; location?: string }; prompt: string }>("SELECT payload, prompt FROM approvals WHERE kind = 'calendar_event'")).rows;
    expect(rows).toHaveLength(1);
    const { payload, prompt } = rows[0]!;
    expect(prompt).toContain(payload.title);
    expect(prompt).toContain(`“${payload.location}”`);
    // Exactly one of the two values is kept; the other is nowhere.
    const other = payload.title === 'Dinner' ? 'Secret plan' : 'Dinner';
    expect(prompt).not.toContain(other);
    expect(w.calendar.writes).toHaveLength(0);
    await w.ownerSays(w.alex, 'yes');
    const creates = w.calendar.writes.filter((x) => x.op === 'create') as Array<{ event: { title: string; location?: string } }>;
    expect(creates).toHaveLength(1);
    expect(creates[0]!.event.title).toBe(payload.title);
    expect(creates[0]!.event.location).toBe(payload.location);
  }, 30_000);

  it('a key that becomes "__proto__" or "constructor" once cleaned changes no prototype and is not booked', async () => {
    w = await createTestWorld();
    await brainTurn(w, [[toolUse('c', 'request_calendar_event', { '__proto\u0000__': { title: 'Evil', isAdmin: true }, 'constr\u0000uctor': { prototype: { x: 1 } }, title: 'Dinner', ...FRI.dinner })]], 'book dinner friday');
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(({} as Record<string, unknown>).title).toBeUndefined();
    const rows = (await w.db.query<{ payload: Record<string, unknown>; prompt: string }>("SELECT payload, prompt FROM approvals WHERE kind = 'calendar_event'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe('Dinner');
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/Evil|isAdmin|prototype/);
    await w.ownerSays(w.alex, 'yes');
    const ev = (w.calendar.writes.find((x) => x.op === "create") as unknown as { event: Record<string, unknown> }).event;
    expect(ev.title).toBe('Dinner');
    expect(JSON.stringify(ev)).not.toMatch(/Evil|isAdmin/);
  }, 30_000);
});

describe('nothing after the door sees the raw call', () => {
  it('a tool_use id with U+0000 and a lone surrogate: the log row is storable, the result answers the original id', async () => {
    w = await createTestWorld();
    const id = 'toolu_\u0000x\uD800';
    const calls = await brainTurn(w, [[toolUse(id, 'remember', { about: 'Sam', note: 'Likes pasta' })]]);
    const res = calls.flatMap((c) => lastResults(c));
    expect(res.map((r) => [r.tool_use_id, r.content])).toEqual([[id, 'Noted.']]);
    const logged = await w.actions({ action: 'tool.call' });
    expect(logged.map((l) => l.detail.toolUseId)).toEqual(['toolu_x�']);
    expect(logged.every((l) => clean(String(l.detail.toolUseId)))).toBe(true);
    expect(w.lastTo(w.alex.address)).toBe('Done.');
  }, 30_000);
});

describe('very large and very deep input', () => {
  it('a large input (1 MB of text with many NULs, 50 000 keys) is cleaned quickly', async () => {
    const keys: Record<string, unknown> = { a: `${'x\u0000\uD800'.repeat(350_000)}` };
    for (let i = 0; i < 50_000; i += 1) keys[`k${i}\u0000`] = `v${i}\uDC00`;
    const r = await probeLoop(keys);
    expect(r.error).toBeNull();
    expect(r.ms).toBeLessThan(5_000);
    const got = r.seen[0] as Record<string, string>;
    expect(got.a).toBe('x�'.repeat(350_000));
    expect(got.k49999).toBe('v49999�');
  }, 30_000);

  it('deeply nested input (depth 2 000) is cleaned and refused or passed, not a crash of the turn', async () => {
    // Depth 2 000: deeper than any real tool input, shallower than the ~5 000 where JSON.stringify
    // of the next model request (and structuredClone in the scripted model) give up anyway.
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 2_000; i += 1) deep = [deep];
    const unknownTool = await probeLoop({ a: 'v', junk: deep }, 'no_such_tool');
    expect(unknownTool.error).toBeNull();
    expect(unknownTool.result!.toolNames).toEqual(['no_such_tool']);
    const knownTool = await probeLoop({ a: 'v', junk: deep });
    expect(knownTool.error).toBeNull();
    let inner: unknown = (knownTool.seen[0] as { junk: unknown }).junk;
    while (Array.isArray(inner)) inner = inner[0];
    expect(inner).toBe('x');
  }, 30_000);

  it('Brain: a deep input does not leave the owner without an answer', async () => {
    w = await createTestWorld();
    // Depth 500: the scripted model's structuredClone of the request gives up near 2 000 objects.
    let deep: unknown = 'x\uD800';
    for (let i = 0; i < 500; i += 1) deep = { 'd\u0000': deep };
    await brainTurn(w, [[toolUse('r', 'remember', { about: 'Sam', note: 'Likes pasta', extra: deep })]]);
    expect(w.lastTo(w.alex.address)).toBe('Done.');
    expect((await w.actions({ action: 'job.dead' })).length).toBe(0);
    expect((await w.db.query<{ body: string }>('SELECT body FROM contact_notes')).rows).toEqual([{ body: 'Likes pasta' }]);
  }, 60_000);
});
