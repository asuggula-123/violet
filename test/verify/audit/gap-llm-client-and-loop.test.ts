/**
 * Audit evidence: the model layer (src/llm/anthropic.ts, toolLoop.ts, tools.ts) and how the
 * Brain and the Envoy react to each stop reason and error class.
 *
 * Tests named "HOLDS" prove a property that holds. Tests named "GAP" assert the property the
 * owner would expect and FAIL on this tree: they are evidence for a finding.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAIN_TEXT } from '../../../src/brain/brain.js';
import { AnthropicLlm, type CreateMessage } from '../../../src/llm/anthropic.js';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond, stepOf, toolUse } from '../../unit/brain/script.js';
import { a2aMessages } from '../../unit/a2a/helpers.js';

const models = { brain: 'configured-brain-model', envoy: 'configured-envoy-model' };

function req(): LlmRequest {
  return { system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, meta: { agentId: 'a', mind: 'brain' } };
}

/** A real AnthropicLlm whose SDK call is replaced. */
function anthropicWith(create: CreateMessage): AnthropicLlm {
  return new AnthropicLlm({ apiKey: 'test-key-not-real', models, create });
}

const event = { title: 'Dentist', start: '2026-11-12T15:00:00-05:00', end: '2026-11-12T16:00:00-05:00' };

async function jobStatuses(w: TestWorld): Promise<string[]> {
  return (await w.db.query<{ status: string }>("SELECT status FROM jobs WHERE type = 'inbound.process' ORDER BY created_at")).rows.map((r) => r.status);
}

describe('model client: request params', () => {
  it('HOLDS (documents): every request opts into the server-side refusal fallback by default (R13 adds a switch to turn it off)', () => {
    const p = anthropicWith(async () => {
      throw new Error('unused');
    }).params(req()) as unknown as Record<string, unknown>;
    expect(p.model).toBe('configured-brain-model');
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(p.output_config).toEqual({ effort: 'medium' });
  });

  it('GAP: a turn answered by the API fallback model is indistinguishable from one answered by the configured model', async () => {
    const llm = anthropicWith(async () =>
      ({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'api-chosen-fallback-model',
        content: [{ type: 'fallback', from: { model: 'configured-brain-model' }, to: { model: 'api-chosen-fallback-model' } }, { type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
      }) as unknown as Anthropic.Beta.Messages.BetaMessage,
    );
    const res = (await llm.complete(req())) as LlmResponse & { model?: string };
    // The served model (response.model / usage.iterations) is dropped, so brain.turn and
    // a2a.envoy_turn can never record that a model other than VIOLET_MODEL answered.
    expect(res.model).toBe('api-chosen-fallback-model');
  });
});

describe('Brain: stop reasons', () => {
  let w: TestWorld;
  afterEach(async () => w?.close());

  it('HOLDS: refusal after a held calendar request -> fixed refusal text, then the code-rendered prompt (still needs a yes)', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) =>
      stepOf(r) === 0 ? respond([toolUse('c1', 'request_calendar_event', event)]) : { content: [], stopReason: 'refusal' },
    );
    await w.ownerSays(w.alex, 'put the dentist on my calendar at 3 today');
    const texts = w.textsTo(w.alex.address);
    expect(texts[0]).toBe(BRAIN_TEXT.refusal);
    expect(texts[1]).toMatch(/^#1 .*Dentist.*Reply yes or no\.$/);
    expect(texts).toHaveLength(2);
    expect(await w.actions({ action: 'calendar.event_created' })).toEqual([]);
    const [turn] = await w.actions({ action: 'brain.turn' });
    expect(turn!.detail).toMatchObject({ outcome: 'answered', stopReason: 'refusal', replied: true });
  });

  it('HOLDS: max_tokens with a cut-off tool_use never runs the tool and creates no approval', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => ({
      content: [{ type: 'text', text: "Sure, I'll put it on your calendar." }, toolUse('c1', 'request_calendar_event', { title: 'Dent' })],
      stopReason: 'max_tokens',
    }));
    await w.ownerSays(w.alex, 'put the dentist on my calendar at 3 today');
    expect(await w.actions({ action: 'tool.call' })).toEqual([]);
    expect(await w.actions({ action: 'approval.requested' })).toEqual([]);
  });

  it('GAP: max_tokens with text before the cut-off tool call -> the owner gets only "I\'ll put it on your calendar", never told it was cut off', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => ({
      content: [{ type: 'text', text: "Sure, I'll put it on your calendar." }, toolUse('c1', 'request_calendar_event', { title: 'Dent' })],
      stopReason: 'max_tokens',
    }));
    await w.ownerSays(w.alex, 'put the dentist on my calendar at 3 today');
    // The fixed BRAIN_TEXT.tooLong is only used when the cut-off answer has no text at all.
    expect(w.textsTo(w.alex.address)).toContain(BRAIN_TEXT.tooLong);
  });

  it('GAP: step limit reached on a response with text + tool_use -> the owner gets the model\'s promise, not the fixed step-limit text', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) =>
      stepOf(r) < 9
        ? respond([toolUse(`l${stepOf(r)}`, 'list_pending_approvals', {})])
        : respond([{ type: 'text', text: 'Booking it now.' }, toolUse('c1', 'request_calendar_event', event)]),
    );
    await w.ownerSays(w.alex, 'put the dentist on my calendar at 3 today');
    expect(await w.actions({ action: 'approval.requested' })).toEqual([]); // the call never ran
    const [turn] = await w.actions({ action: 'brain.turn' });
    expect(turn!.detail.stopReason).toBe('max_steps');
    // The owner reads "Booking it now." and nothing is ever asked or booked.
    expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.maxSteps]);
  });

  it('GAP: a stop reason outside the fixed list with no text (model_context_window_exceeded) -> the owner gets no reply at all', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => ({ content: [], stopReason: 'model_context_window_exceeded' }));
    await w.ownerSays(w.alex, 'summarise all my mail from this month');
    const [turn] = await w.actions({ action: 'brain.turn' });
    // R15 ruling (never silence): the turn now replies with a fixed text, so `replied` is true.
    expect(turn!.detail).toMatchObject({ outcome: 'answered', stopReason: 'model_context_window_exceeded', replied: true });
    expect(w.textsTo(w.alex.address)).not.toEqual([]);
  });
});

describe('Brain: error classes through the real client mapping', () => {
  let w: TestWorld;
  afterEach(async () => w?.close());

  for (const [status, code] of [
    [401, 'auth'],
    [400, 'bad_request'],
  ] as const) {
    it(`HOLDS: HTTP ${status} -> one fixed apology per message, brain.turn model_error ${code}, job done (not retried), no secret in the log`, async () => {
      w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
      const client = anthropicWith(async () => {
        throw Anthropic.APIError.generate(status, { error: { message: 'prompt is too long: SECRET-PROMPT-TEXT' } }, 'x', new Headers());
      });
      w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) => client.complete(r));
      await w.ownerSays(w.alex, 'hello');
      await w.advance({ minutes: 5 });
      await w.ownerSays(w.alex, 'hello again');
      expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.modelFailed, BRAIN_TEXT.modelFailed]);
      const turns = await w.actions({ action: 'brain.turn' });
      expect(turns.map((t) => [t.detail.outcome, t.detail.code])).toEqual([
        ['model_error', code],
        ['model_error', code],
      ]);
      expect(await jobStatuses(w)).toEqual(['done', 'done']);
      const all = JSON.stringify(await w.actions({}));
      expect(all).not.toContain('SECRET-PROMPT-TEXT');
      expect(all).not.toContain('test-key-not-real');
    });
  }
});

describe('Envoy: stop reasons and errors', () => {
  let w: TestWorld;
  afterEach(async () => w?.close());

  const opens = (t: TestWorld) =>
    t.llm.on({ agentId: t.alex.agent.id, mind: 'brain' }, (r) =>
      stepOf(r) === 0 ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Weekend', brief: 'Plans for the weekend?' })]) : respond([{ type: 'text', text: 'ok' }]),
    );

  it('HOLDS: refusal -> no act, side stalled, one digest flag, envoy_turn logged with stopReason', async () => {
    w = await createTestWorld();
    opens(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, () => ({ content: [], stopReason: 'refusal' }));
    await w.ownerSays(w.alex, 'Ask Sam about plans for the weekend');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);
    const [turn] = await w.actions({ action: 'a2a.envoy_turn' });
    expect(turn!.detail).toMatchObject({ outcome: 'no_act', stopReason: 'refusal', act: null });
    const flags = (await w.app.repos.flags.listByAgent(w.sam.agent.id)).filter((f) => f.kind === 'a2a_stalled');
    expect(flags).toHaveLength(1);
    expect(w.textsTo(w.sam.address)).toEqual([]);
  });

  it('HOLDS: a non-retryable model error (401 via the real mapping) -> model_error, stalled, nothing sent to the peer', async () => {
    w = await createTestWorld();
    opens(w);
    const client = anthropicWith(async () => {
      throw Anthropic.APIError.generate(401, { error: { message: 'bad key' } }, 'x', new Headers());
    });
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, (r) => client.complete(r));
    await w.ownerSays(w.alex, 'Ask Sam about plans for the weekend');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);
    const [turn] = await w.actions({ action: 'a2a.envoy_turn' });
    expect(turn!.detail).toMatchObject({ outcome: 'model_error', stopReason: null });
    const side = (await w.db.query<{ stalled: boolean }>('SELECT stalled FROM a2a_sides WHERE agent_id = $1', [w.sam.agent.id])).rows[0]!;
    expect(side.stalled).toBe(true);
  });
});
