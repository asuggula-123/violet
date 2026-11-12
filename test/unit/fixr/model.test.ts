/**
 * R13: the owner can see which model answered and can turn the API's refusal fallback off.
 * R14/R15: a turn that stops early always ends with a fixed notice; never silence.
 * R16: a Brain turn is bounded by wall-clock time below the job stale time.
 * Model ids here are neutral placeholders.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAIN_TEXT, BRAIN_TURN_MS } from '../../../src/brain/brain.js';
import { parseConfig } from '../../../src/config.js';
import { DEFAULT_STALE_MS } from '../../../src/core/jobs.js';
import { createDeps } from '../../../src/deps.js';
import type { Db } from '../../../src/db/db.js';
import { AnthropicLlm, type CreateMessage } from '../../../src/llm/anthropic.js';
import { LlmError } from '../../../src/llm/errors.js';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, scriptEnvoy } from '../a2a/helpers.js';
import { respond, stepOf, toolUse } from '../brain/script.js';

const models = { brain: 'model-a', envoy: 'model-b' };
const req = (extra: Partial<LlmRequest> = {}): LlmRequest => ({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, meta: { agentId: 'a', mind: 'brain' }, ...extra });

function apiMessage(extra: Record<string, unknown> = {}): Anthropic.Beta.Messages.BetaMessage {
  return {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'model-a',
    content: [{ type: 'text', text: 'Hi' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, iterations: null },
    ...extra,
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

/** A real SDK client whose fetch records the request on the wire. */
function onTheWire(fallback?: boolean) {
  const calls: { body: Record<string, unknown>; headers: Headers }[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(apiMessage()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { calls, llm: new AnthropicLlm({ apiKey: 'test-key-not-real', models, fetch, maxRetries: 0, ...(fallback === undefined ? {} : { fallback }) }) };
}

describe('R13: the fallback switch and the served model', () => {
  it('VIOLET_MODEL_FALLBACK: on by default, off when set; anything else is refused', () => {
    expect(parseConfig({}).VIOLET_MODEL_FALLBACK).toBe('on');
    expect(parseConfig({ VIOLET_MODEL_FALLBACK: '' }).VIOLET_MODEL_FALLBACK).toBe('on');
    expect(parseConfig({ VIOLET_MODEL_FALLBACK: 'off' }).VIOLET_MODEL_FALLBACK).toBe('off');
    expect(() => parseConfig({ VIOLET_MODEL_FALLBACK: 'maybe' })).toThrow(/VIOLET_MODEL_FALLBACK/);
  });

  it('off: no fallback beta header and no fallbacks parameter on the wire; on: both', async () => {
    const off = onTheWire(false);
    await off.llm.complete(req());
    expect(off.calls[0]!.body).not.toHaveProperty('fallbacks');
    expect(off.calls[0]!.body).not.toHaveProperty('betas');
    expect(off.calls[0]!.headers.get('anthropic-beta') ?? '').not.toMatch(/fallback/);
    const on = onTheWire();
    await on.llm.complete(req());
    expect(on.calls[0]!.body).toMatchObject({ fallbacks: 'default' });
    expect(on.calls[0]!.headers.get('anthropic-beta')).toMatch(/server-side-fallback/);
  });

  it('createDeps passes the switch to the client', () => {
    const deps = createDeps(parseConfig({ ANTHROPIC_API_KEY: 'test-key-not-real', VIOLET_MODEL: 'model-a', VIOLET_MODEL_FALLBACK: 'off' }), {} as Db);
    const params = (deps.llm as AnthropicLlm).params(req()) as unknown as Record<string, unknown>;
    expect(params.model).toBe('model-a');
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
  });

  it('the client returns the served model and whether the fallback answered', async () => {
    const create = (m: Anthropic.Beta.Messages.BetaMessage): CreateMessage => async () => m;
    const plain = await new AnthropicLlm({ apiKey: 'k', models, create: create(apiMessage()) }).complete(req());
    expect([plain.model, plain.fallback]).toEqual(['model-a', false]);
    const byBlock = apiMessage({ model: 'model-z', content: [{ type: 'fallback', from: { model: 'model-a' }, to: { model: 'model-z' } }, { type: 'text', text: 'Hi' }] });
    expect(await new AnthropicLlm({ apiKey: 'k', models, create: create(byBlock) }).complete(req())).toMatchObject({ model: 'model-z', fallback: true });
    const byUsage = apiMessage({ model: 'model-z', usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'fallback_message' }] } });
    expect(await new AnthropicLlm({ apiKey: 'k', models, create: create(byUsage) }).complete(req())).toMatchObject({ model: 'model-z', fallback: true });
  });

  it('brain.turn and a2a.envoy_turn carry the served models and the fallback flag', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) => {
      const res = stepOf(r) === 0 ? respond([toolUse('b1', 'talk_to_agent', { with: 'Sam', topic: 'Dinner', brief: 'Dinner Friday?' })]) : respond([{ type: 'text', text: 'Asked.' }]);
      return { ...res, model: stepOf(r) === 0 ? 'model-a' : 'model-z', fallback: stepOf(r) !== 0 };
    });
    scriptEnvoy(w, w.sam, () => [(r) => ({ ...respond([{ type: 'text', text: 'ok' }]), model: 'model-b', fallback: false } as LlmResponse & { [k: string]: unknown }), 'ok']);
    await w.ownerSays(w.alex, 'Ask Sam about dinner');
    const [turn] = await w.actions({ action: 'brain.turn' });
    expect(turn!.detail).toMatchObject({ models: ['model-a', 'model-z'], fallback: true });
    const envoy = await w.actions({ action: 'a2a.envoy_turn' });
    expect(envoy[0]!.detail).toMatchObject({ models: ['model-b'], fallback: false });
  });
});

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('R14/R15: every early stop ends with a fixed notice', () => {
  const ask = async (res: (r: LlmRequest) => LlmResponse) => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, res);
    await w.ownerSays(w.alex, 'put the dentist on my calendar');
    return w.textsTo(w.alex.address);
  };
  const dent = { title: 'Dentist', start: '2026-11-12T15:00:00-05:00', end: '2026-11-12T16:00:00-05:00' };

  it('step limit on a response with text and a tool call: only the fixed text, the tool never ran', async () => {
    const texts = await ask((r) => respond([{ type: 'text', text: 'Booking it now.' }, toolUse(`c${stepOf(r)}`, 'list_pending_approvals', {})]));
    expect(texts).toEqual([BRAIN_TEXT.maxSteps]);
  });

  it('max_tokens with text before a cut-off tool call: only the fixed text', async () => {
    const texts = await ask(() => ({ content: [{ type: 'text', text: "Sure, I'll put it on." }, toolUse('c', 'request_calendar_event', dent)], stopReason: 'max_tokens' }));
    expect(texts).toEqual([BRAIN_TEXT.tooLong]);
    expect(await w!.actions({ action: 'approval.requested' })).toEqual([]);
  });

  it('max_tokens with only text: the text, then the fixed notice', async () => {
    const texts = await ask(() => ({ content: [{ type: 'text', text: 'Here is the long answer' }], stopReason: 'max_tokens' }));
    expect(texts).toEqual([`Here is the long answer\n\n${BRAIN_TEXT.tooLong}`]);
  });

  it('model_context_window_exceeded with no text: a fixed text, never silence', async () => {
    expect(await ask(() => ({ content: [], stopReason: 'model_context_window_exceeded' }))).toEqual([BRAIN_TEXT.tooMuch]);
    const [turn] = await w!.actions({ action: 'brain.turn' });
    expect(turn!.detail).toMatchObject({ stopReason: 'model_context_window_exceeded', replied: true });
  });

  it('any other stop reason: the generic fixed text after the model text', async () => {
    expect(await ask(() => ({ content: [{ type: 'text', text: 'Partly done.' }], stopReason: 'some_new_reason' }))).toEqual([`Partly done.\n\n${BRAIN_TEXT.stopped}`]);
  });

  it('end_turn and refusal keep their behaviour', async () => {
    expect(await ask(() => respond([{ type: 'text', text: 'Done.' }]))).toEqual(['Done.']);
    await w!.close();
    expect(await ask(() => ({ content: [{ type: 'text', text: 'x' }], stopReason: 'refusal' }))).toEqual([BRAIN_TEXT.refusal]);
  });
});

describe('R16: the turn deadline', () => {
  it('is below the job stale time', () => {
    expect(BRAIN_TURN_MS).toBeLessThan(DEFAULT_STALE_MS);
  });

  it('no model call starts after it: the owner gets the fixed text; each call is given the time left', async () => {
    w = await createTestWorld();
    const timeouts: Array<number | undefined> = [];
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) => {
      timeouts.push(r.timeoutMs);
      w!.clock.advance({ minutes: 3 }); // a slow model
      return respond([{ type: 'text', text: 'Still looking.' }, toolUse(`c${stepOf(r)}`, 'list_pending_approvals', {})]);
    });
    await w.ownerSays(w.alex, 'look into everything');
    expect(timeouts).toEqual([BRAIN_TURN_MS, BRAIN_TURN_MS - 180_000, BRAIN_TURN_MS - 360_000]);
    expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.tookTooLong]);
    const [turn] = await w.actions({ action: 'brain.turn' });
    expect(turn!.detail).toMatchObject({ stopReason: 'deadline', steps: 3, replied: true });
  });

  it('a call cut off at the deadline (the client gives up): the fixed text, no job retry', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => {
      throw new LlmError('deadline', false, 'model call ran past the turn deadline');
    });
    await w.ownerSays(w.alex, 'hello');
    expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.tookTooLong]);
    expect(await w.actions({ action: 'job.retry' })).toEqual([]);
  });

  it('the real client turns timeoutMs into an abort that covers the SDK retries, as LlmError deadline', async () => {
    const fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof globalThis.fetch;
    const llm = new AnthropicLlm({ apiKey: 'test-key-not-real', models, fetch, maxRetries: 2 });
    const err = await llm.complete(req({ timeoutMs: 50 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: 'deadline', retryable: false });
  });
});
