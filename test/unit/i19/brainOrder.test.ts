/** I19 E6: the genuine prompt is the last word of a Brain turn. */
import { afterEach, describe, expect, it } from 'vitest';
import { TURN_HOLD_MS } from '../../../src/approvals/service.js';
import { LlmError } from '../../../src/llm/errors.js';
import { BRAIN_TEXT } from '../../../src/brain/brain.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond, scriptBrain, stepOf, toolUse } from '../brain/script.js';
import { ask, DINNER, LUNCH } from './helpers.js';

const PROMPT_1 = '#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.';
const PROMPT_2 = '#2 Lunch — Thu Nov 12, 12:00–1:00 PM. Book it? Reply yes or no.';

describe('I19 prompt-last: Brain turn order', () => {
  let w: TestWorld;
  afterEach(async () => w.close());
  const sent = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address);
  const prompts = () => sent().filter((m) => m.purpose === 'approval');

  it('reply, then the prompt; the reply is marked as written by the Brain', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], 'Asked.']);
    await w.ownerSays(w.alex, 'book dinner');
    expect(w.textsTo(w.alex.address)).toEqual(['Asked.', PROMPT_1]);
    const meta = (await w.db.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM messages WHERE body = 'Asked.'`)).rows[0]!.meta;
    expect(meta.from).toBe('brain');
  });

  it('no reply: the prompt only', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], '']);
    await w.ownerSays(w.alex, 'book dinner');
    expect(w.textsTo(w.alex.address)).toEqual([PROMPT_1]);
  });

  it('the fixed model-error text, then the prompt', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      if (stepOf(req) === 0) return respond([toolUse('t', 'request_calendar_event', DINNER)]);
      throw new LlmError('bad_request', false, 'rejected', 400);
    });
    await w.ownerSays(w.alex, 'book dinner');
    expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.modelFailed, PROMPT_1]);
  });

  it('several approvals in one turn: all prompts after the reply, in creation order', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [[toolUse('a', 'request_calendar_event', DINNER), toolUse('b', 'request_calendar_event', LUNCH)], 'Asked both.']);
    await w.ownerSays(w.alex, 'book both');
    expect(w.textsTo(w.alex.address)).toEqual(['Asked both.', PROMPT_1, PROMPT_2]);
  });

  it("a notice the turn queued (the 'Talking to …' line) lands before the turn's prompts", async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [
      [toolUse('o', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner on Friday?' }), toolUse('t', 'request_calendar_event', DINNER)],
      'On it.',
    ]);
    await w.ownerSays(w.alex, 'ask Sam about dinner on Friday and book dinner');
    await w.app.settle();
    const texts = w.textsTo(w.alex.address);
    expect(texts[0]).toBe('On it.');
    expect(texts[1]).toMatch(/^Talking to Sam's Violet about/);
    expect(texts[2]).toBe(PROMPT_1);
    expect(texts.filter((t) => /^Talking to/.test(t))).toHaveLength(1);
  });

  it('a crash between reply and prompt delivery: the sweep delivers it once, after hold_until — never mid-turn', async () => {
    w = await createTestWorld();
    const approvals = w.app.approvals!;
    const deliverTurn = approvals.deliverTurn.bind(approvals);
    approvals.deliverTurn = async () => undefined; // the worker died right after the reply
    scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], 'Asked.']);
    await w.ownerSays(w.alex, 'book dinner');
    expect(prompts()).toHaveLength(0);
    await w.advance({ minutes: 5 });
    expect(prompts()).toHaveLength(0); // still held: the sweep never delivers a turn's prompt early
    await w.advance({ ms: TURN_HOLD_MS });
    expect(prompts().map((m) => m.text)).toEqual([PROMPT_1]);
    approvals.deliverTurn = deliverTurn;
    await w.advance({ minutes: 30 });
    expect(prompts()).toHaveLength(1);
  });

  it('the sweep does not deliver a held prompt while the turn is still running', async () => {
    w = await createTestWorld();
    let swept = -1;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      if (stepOf(req) === 0) return respond([toolUse('t', 'request_calendar_event', DINNER)]);
      w.clock.advance({ minutes: 2 });
      await w.app.approvals!.sendUnsent(w.alex.agent.id); // what the sweep does, mid-turn
      swept = prompts().length;
      return respond([{ type: 'text', text: 'Asked.' }]);
    });
    await w.ownerSays(w.alex, 'book dinner');
    expect(swept).toBe(0);
    expect(w.textsTo(w.alex.address)).toEqual(['Asked.', PROMPT_1]);
  });

  it('a retried turn never sends a prompt twice', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
    const approvals = w.app.approvals!;
    const deliverTurn = approvals.deliverTurn.bind(approvals);
    let failed = false;
    approvals.deliverTurn = async (agentId, messageId) => {
      await deliverTurn(agentId, messageId);
      if (!failed) {
        failed = true;
        throw new Error('crash after the prompt went out');
      }
    };
    scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], 'Asked.']);
    await w.ownerSays(w.alex, 'book dinner');
    await w.advance({ seconds: 2 });
    await w.advance({ minutes: 20 });
    expect(failed).toBe(true);
    expect(prompts().map((m) => m.text)).toEqual([PROMPT_1]);
    expect(await approvals.listPending(w.alex.agent.id)).toHaveLength(1);
  });

  it('an approval requested outside a Brain turn is delivered at once', async () => {
    w = await createTestWorld();
    const a = await ask(w, w.alex);
    expect(a.prompt_transport_message_id).not.toBeNull();
    expect(prompts().map((m) => m.text)).toEqual([PROMPT_1]);
  });
});
