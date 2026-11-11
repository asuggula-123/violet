import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicLlm, toLlmError, type CreateMessage } from '../../../src/llm/anthropic.js';
import { LlmError, UnconfiguredLlm } from '../../../src/llm/errors.js';
import type { LlmRequest } from '../../../src/llm/types.js';

const models = { brain: 'claude-opus-5-5', envoy: 'envoy-model-x' };

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'STABLE SYSTEM',
    systemDynamic: 'now: Wed 9:00',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
    tools: [
      { name: 'a', description: 'tool a', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'tool b', input_schema: { type: 'object', properties: {} } },
    ],
    maxTokens: 1234,
    meta: { agentId: 'agent-secret-id', mind: 'brain', conversationId: 'conv-secret-id' },
    ...over,
  };
}

function apiMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig2' },
      { type: 'text', text: 'Hello' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
    ...over,
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

function fakeCreate() {
  const seen: Parameters<CreateMessage>[0][] = [];
  const create: CreateMessage = async (params) => {
    seen.push(params);
    return apiMessage();
  };
  return { seen, create };
}

describe('AnthropicLlm', () => {
  it('builds the request: model per mind, caching breakpoints, dynamic system after the breakpoint', async () => {
    const { seen, create } = fakeCreate();
    const llm = new AnthropicLlm({ apiKey: 'test-key', models, create });
    await llm.complete(request());
    await llm.complete(request({ meta: { agentId: 'a', mind: 'envoy' } }));
    const [brain, envoy] = seen;
    expect(brain!.model).toBe('claude-opus-5-5');
    expect(envoy!.model).toBe('envoy-model-x');
    expect(brain!.max_tokens).toBe(1234);
    expect(brain!.system).toEqual([
      { type: 'text', text: 'STABLE SYSTEM', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'now: Wed 9:00' },
    ]);
    expect(brain!.tools).toEqual([
      { name: 'a', description: 'tool a', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'tool b', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
    ]);
    expect(brain!.cache_control).toEqual({ type: 'ephemeral' });
    expect(brain!.output_config).toEqual({ effort: 'medium' });
    expect(brain!.fallbacks).toBe('default');
    expect(brain!.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(brain).not.toHaveProperty('thinking');
    expect(brain).not.toHaveProperty('tool_choice');
  });

  it('passes messages (thinking blocks included) verbatim and never sends meta', async () => {
    const { seen, create } = fakeCreate();
    await new AnthropicLlm({ apiKey: 'k', models, create }).complete(request());
    expect(seen[0]!.messages).toEqual(request().messages);
    const wire = JSON.stringify(seen[0]);
    expect(wire).not.toContain('agent-secret-id');
    expect(wire).not.toContain('conv-secret-id');
    expect(wire).not.toContain('meta');
  });

  it('maps the response: content verbatim, stop reason, usage with cache tokens', async () => {
    const { create } = fakeCreate();
    const res = await new AnthropicLlm({ apiKey: 'k', models, create }).complete(request());
    expect(res.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig2' },
      { type: 'text', text: 'Hello' },
    ]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5 });
  });

  it('omits tools when there are none and the dynamic block when empty', async () => {
    const { seen, create } = fakeCreate();
    await new AnthropicLlm({ apiKey: 'k', models, create }).complete(request({ tools: [], systemDynamic: '' }));
    expect(seen[0]).not.toHaveProperty('tools');
    expect(seen[0]!.system).toHaveLength(1);
  });

  it('sends the same body on the wire through the real SDK (injected fetch): key in a header, no meta', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(apiMessage()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const llm = new AnthropicLlm({ apiKey: 'sk-test-not-real', models, fetch, maxRetries: 0 });
    const res = await llm.complete(request());
    expect(res.content.at(-1)).toEqual({ type: 'text', text: 'Hello' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain('/v1/messages');
    expect(call.headers.get('authorization') ?? call.headers.get('x-api-key')).toContain('sk-test-not-real');
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(call.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1234, fallbacks: 'default' });
    expect(call.body).not.toHaveProperty('betas');
    expect(call.body).not.toHaveProperty('meta');
    expect(JSON.stringify(call.body)).not.toContain('sk-test-not-real');
  });

  it('maps SDK errors to typed LlmErrors with the right retryable flag and no echoed text', async () => {
    const statuses: Array<[number, string, boolean]> = [
      [429, 'rate_limited', true],
      [529, 'overloaded', true],
      [500, 'server', true],
      [503, 'server', true],
      [408, 'server', true],
      [401, 'auth', false],
      [403, 'auth', false],
      [400, 'bad_request', false],
      [404, 'bad_request', false],
    ];
    for (const [status, code, retryable] of statuses) {
      const err = Anthropic.APIError.generate(status, { error: { message: 'prompt text: SECRET-PROMPT' } }, 'msg', new Headers());
      const mapped = toLlmError(err);
      expect(mapped, String(status)).toBeInstanceOf(LlmError);
      expect(mapped.code, String(status)).toBe(code);
      expect(mapped.retryable, String(status)).toBe(retryable);
      expect(mapped.message).not.toContain('SECRET-PROMPT');
    }
    expect(toLlmError(new Anthropic.APIConnectionError({ message: 'boom' }))).toMatchObject({ code: 'network', retryable: true });
    expect(toLlmError(new TypeError('x'))).toMatchObject({ code: 'unknown', retryable: false });
  });

  it('complete() throws the mapped error', async () => {
    const create: CreateMessage = async () => {
      throw Anthropic.APIError.generate(429, undefined, 'slow down', new Headers());
    };
    await expect(new AnthropicLlm({ apiKey: 'k', models, create }).complete(request())).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('UnconfiguredLlm fails every call with a typed, non-retryable error', async () => {
    await expect(new UnconfiguredLlm().complete()).rejects.toMatchObject({ name: 'LlmError', code: 'unconfigured', retryable: false });
  });
});

const live = process.env.ANTHROPIC_API_KEY && process.env.RUN_LIVE_LLM === '1';

describe.skipIf(!live)('AnthropicLlm live smoke (ANTHROPIC_API_KEY + RUN_LIVE_LLM=1)', () => {
  it('answers a trivial prompt', async () => {
    const model = process.env.VIOLET_MODEL || 'claude-opus-5-5';
    const llm = new AnthropicLlm({ apiKey: process.env.ANTHROPIC_API_KEY!, models: { brain: model, envoy: model } });
    const res = await llm.complete({
      system: 'Reply with the single word: pong',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      maxTokens: 2000,
      meta: { agentId: 'smoke', mind: 'brain' },
    });
    expect(res.content.some((b) => b.type === 'text')).toBe(true);
  }, 120_000);
});
