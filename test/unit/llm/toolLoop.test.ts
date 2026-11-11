import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedLlm, textResponse } from '../../../src/llm/scripted.js';
import { runToolLoop, type ToolLoopOptions } from '../../../src/llm/toolLoop.js';
import { GENERIC_TOOL_FAILURE, ToolError, ToolRegistry } from '../../../src/llm/tools.js';
import type { LlmBlock, LlmMessage, LlmResponse } from '../../../src/llm/types.js';

const meta = { agentId: 'a1', mind: 'brain' as const };

function registry() {
  const ran: string[] = [];
  const tools = new ToolRegistry<{ who: string }>()
    .register({
      name: 'echo',
      description: 'echo',
      input: z.object({ text: z.string().max(10) }),
      handler: async (i, ctx) => {
        ran.push(`echo:${i.text}`);
        return `${ctx.who} says ${i.text}`;
      },
    })
    .register({
      name: 'explode',
      description: 'fails',
      input: z.object({}),
      handler: async () => {
        ran.push('explode');
        throw new Error('db password=hunter2 at /srv/secret.ts:12');
      },
    })
    .register({
      name: 'refuse',
      description: 'fails safely',
      input: z.object({}),
      handler: async () => {
        throw new ToolError('That calendar is not connected.');
      },
    });
  return { tools, ran };
}

function use(id: string, name: string, input: Record<string, unknown>): LlmBlock {
  return { type: 'tool_use', id, name, input };
}

function resp(content: LlmBlock[], stopReason = 'tool_use'): LlmResponse {
  return { content, stopReason, usage: { inputTokens: 10, outputTokens: 5 } };
}

function run(llm: ScriptedLlm, tools: ToolRegistry<{ who: string }>, extra: Partial<ToolLoopOptions<{ who: string }>> = {}) {
  const denied: string[] = [];
  const promise = runToolLoop({
    llm,
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    execute: (tool, input) => tool.handler(input, { who: 'tester' }),
    onDenied: async (call, reason) => void denied.push(`${call.name}:${reason}`),
    maxSteps: 10,
    maxTokens: 1000,
    meta,
    ...extra,
  });
  return { promise, denied };
}

function toolResults(m: LlmMessage | undefined): Array<Record<string, unknown>> {
  return (m?.content as Array<Record<string, unknown>>) ?? [];
}

describe('runToolLoop', () => {
  it('runs several tool_use blocks of one response and returns all results in one user message, in order', async () => {
    const { tools, ran } = registry();
    const llm = new ScriptedLlm().on({}, (_req, n) =>
      n === 0 ? resp([{ type: 'text', text: 'checking' }, use('t1', 'echo', { text: 'a' }), use('t2', 'echo', { text: 'b' })]) : textResponse('done'),
    );
    const { promise } = run(llm, tools);
    const r = await promise;
    expect(ran).toEqual(['echo:a', 'echo:b']);
    expect(r.finalText).toBe('done');
    expect(r.steps).toBe(2);
    expect(r.stopReason).toBe('end_turn');
    expect(r.toolNames).toEqual(['echo', 'echo']);
    const second = llm.calls[1]!;
    const results = toolResults(second.messages.at(-1));
    expect(second.messages.at(-1)?.role).toBe('user');
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'tester says a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'tester says b' },
    ]);
    expect(r.usage.inputTokens).toBe(10);
  });

  it('answers an unknown tool with an is_error result and reports it as denied', async () => {
    const { tools, ran } = registry();
    const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? resp([use('t1', 'approve', { id: 'x' }), use('t2', 'echo', { text: 'ok' })]) : textResponse('fine')));
    const { promise, denied } = run(llm, tools);
    await promise;
    expect(denied).toEqual(['approve:unknown_tool']);
    expect(ran).toEqual(['echo:ok']);
    const [bad, good] = toolResults(llm.calls[1]!.messages.at(-1));
    expect(bad).toMatchObject({ tool_use_id: 't1', is_error: true });
    expect(String(bad!.content)).toContain('no tool named');
    expect(good).toMatchObject({ tool_use_id: 't2', content: 'tester says ok' });
  });

  it('validates input with the zod schema and never runs the handler on invalid input', async () => {
    const { tools, ran } = registry();
    const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? resp([use('t1', 'echo', { text: 'far too long text' })]) : textResponse('ok')));
    const { promise, denied } = run(llm, tools);
    await promise;
    expect(ran).toEqual([]);
    expect(denied).toEqual(['echo:invalid_input']);
    const [res] = toolResults(llm.calls[1]!.messages.at(-1));
    expect(res).toMatchObject({ is_error: true });
    expect(String(res!.content)).toMatch(/^Invalid input: text: /);
    expect(String(res!.content).length).toBeLessThanOrEqual(300);
  });

  it('turns handler errors into safe messages: ownerMessage when given, a generic text otherwise', async () => {
    const { tools } = registry();
    const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? resp([use('t1', 'explode', {}), use('t2', 'refuse', {})]) : textResponse('ok')));
    const { promise } = run(llm, tools);
    await promise;
    const [a, b] = toolResults(llm.calls[1]!.messages.at(-1));
    expect(a).toEqual({ type: 'tool_result', tool_use_id: 't1', content: GENERIC_TOOL_FAILURE, is_error: true });
    expect(JSON.stringify(llm.calls[1])).not.toContain('hunter2');
    expect(b).toEqual({ type: 'tool_result', tool_use_id: 't2', content: 'That calendar is not connected.', is_error: true });
  });

  it('stops at the step limit without running the last requested tools', async () => {
    const { tools, ran } = registry();
    const llm = new ScriptedLlm().on({}, (_req, n) => resp([{ type: 'text', text: `step ${n}` }, use(`t${n}`, 'echo', { text: String(n) })]));
    const { promise } = run(llm, tools, { maxSteps: 3 });
    const r = await promise;
    expect(r.steps).toBe(3);
    expect(llm.calls).toHaveLength(3);
    expect(r.stopReason).toBe('max_steps');
    expect(ran).toEqual(['echo:0', 'echo:1']);
    expect(r.finalText).toBe('step 2');
  });

  it('passes assistant content back verbatim, thinking blocks and unknown block types included', async () => {
    const { tools } = registry();
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
    const odd = { type: 'fallback', from: { model: 'm1' }, to: { model: 'm2' } };
    const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? resp([odd, thinking, use('t1', 'echo', { text: 'x' })]) : textResponse('ok')));
    const { promise } = run(llm, tools);
    await promise;
    const assistant = llm.calls[1]!.messages.at(-2)!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([odd, thinking, use('t1', 'echo', { text: 'x' })]);
  });

  it('never runs tools from a max_tokens response and returns its text', async () => {
    const { tools, ran } = registry();
    const llm = new ScriptedLlm().on({}, () => resp([{ type: 'text', text: 'partial' }, use('t1', 'echo', { text: 'x' })], 'max_tokens'));
    const { promise } = run(llm, tools);
    const r = await promise;
    expect(ran).toEqual([]);
    expect(r).toMatchObject({ stopReason: 'max_tokens', finalText: 'partial', steps: 1 });
  });

  it('returns no text on refusal', async () => {
    const { tools } = registry();
    const llm = new ScriptedLlm().on({}, () => resp([{ type: 'text', text: 'I will not' }], 'refusal'));
    const r = await run(llm, tools).promise;
    expect(r).toMatchObject({ stopReason: 'refusal', finalText: '' });
  });

  it('continues after pause_turn by calling the model again with the paused content', async () => {
    const { tools } = registry();
    const llm = new ScriptedLlm().on({}, (_req, n) => (n === 0 ? resp([{ type: 'text', text: 'working' }], 'pause_turn') : textResponse('finished')));
    const r = await run(llm, tools).promise;
    expect(r).toMatchObject({ stopReason: 'end_turn', finalText: 'finished', steps: 2 });
    expect(llm.calls[1]!.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'working' }] });
  });

  it('sends the registry as JSON Schema tools and the dynamic system part separately', async () => {
    const { tools } = registry();
    const llm = new ScriptedLlm();
    await run(llm, tools, { systemDynamic: 'now: noon' }).promise;
    const req = llm.calls[0]!;
    expect(req.tools.map((t) => t.name)).toEqual(['echo', 'explode', 'refuse']);
    expect(req.tools[0]!.input_schema).toMatchObject({ type: 'object', properties: { text: { type: 'string', maxLength: 10 } } });
    expect(req.tools[0]!.input_schema).not.toHaveProperty('$schema');
    expect(req.system).toBe('sys');
    expect(req.systemDynamic).toBe('now: noon');
  });

  it('a registry rejects duplicate and malformed names', () => {
    const { tools } = registry();
    expect(() => tools.register({ name: 'echo', description: '', input: z.object({}), handler: async () => '' })).toThrow(/already/);
    expect(() => tools.register({ name: 'bad name', description: '', input: z.object({}), handler: async () => '' })).toThrow(/invalid/);
  });
});
