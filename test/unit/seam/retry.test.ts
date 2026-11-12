/**
 * Seam I19 x I20: I20's retry rule (release() answers a retried call from the approval it
 * already made) meets I19's held prompts. A retried or duplicated turn must not send the
 * prompt inside the tool call, early, twice, or as a second genuine delivery: the owner sees
 * the reply, then exactly one prompt, and a bare yes under it releases once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/llm/errors.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { FRI, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';
import { a2aBodies, OPEN_PROMPT, REPLY, SECRET, talk } from './helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const PROMPT = OPEN_PROMPT(1, 'Saturday', SECRET);
const prompts = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval');

async function world(): Promise<void> {
  w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
  scriptEnvoy(w, w.sam, () => ['ok']);
}

async function oneDelivery(): Promise<void> {
  const rows = (await w.db.query<{ kind: string; n: number }>('SELECT kind, count(*)::int AS n FROM approval_deliveries GROUP BY kind')).rows;
  expect(rows).toEqual([{ kind: 'prompt', n: 1 }]);
  expect((await w.db.query("SELECT id FROM approvals WHERE kind = 'a2a_release'")).rows).toHaveLength(1);
}

async function yesReleasesOnce(): Promise<void> {
  expect(await a2aBodies(w)).toEqual([]);
  await w.ownerSays(w.alex, 'yes');
  expect(w.lastTo(w.alex.address)).toBe(`Talking to Sam's Violet about “Saturday”: “${SECRET}”`);
  expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
  expect((await w.actions({ action: 'a2a.release', agentId: w.alex.agent.id })).length).toBe(1);
}

describe('seam: retried turns and held releases', () => {
  it('the model call fails once after the tool ran: the retry replies, then the one prompt', async () => {
    await world();
    let failed = false;
    let promptsDuringRetry = -1;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      if (!failed) {
        failed = true;
        throw new LlmError('overloaded', true, 'overloaded');
      }
      promptsDuringRetry = prompts().length; // inside the retried turn, before its reply
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, SECRET);
    expect(prompts()).toHaveLength(0); // the first attempt died before its reply: nothing out yet
    await w.advance({ seconds: 5 });
    expect(failed).toBe(true);
    expect(promptsDuringRetry).toBe(0);
    expect(w.textsTo(w.alex.address)).toEqual([REPLY, PROMPT]);
    await oneDelivery();
    await yesReleasesOnce();
  });

  it('the tool memo is lost (crash between approval and memo): release() finds the pending approval, holds it, sends nothing inside the tool', async () => {
    await world();
    let attempt = 0;
    let promptsAfterTool = -1;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) {
        attempt += 1;
        return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      }
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      if (attempt === 1) {
        // Simulate the crash window: the approval exists but its memo row does not.
        await w.db.query("DELETE FROM brain_tool_memo WHERE tool = 'talk_to_agent'");
        throw new LlmError('overloaded', true, 'overloaded');
      }
      promptsAfterTool = prompts().length;
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, SECRET);
    await w.advance({ seconds: 5 });
    expect(attempt).toBe(2);
    expect(promptsAfterTool).toBe(0);
    const held = await w.actions({ action: 'a2a.release_held', agentId: w.alex.agent.id });
    expect(held.map((h) => h.detail.approvalId)).toEqual([held[0]!.detail.approvalId, held[0]!.detail.approvalId]);
    expect(w.textsTo(w.alex.address)).toEqual([REPLY, PROMPT]);
    await oneDelivery();
    await yesReleasesOnce();
  });

  it('a duplicate run of the same turn (stale requeue) finishes first: one reply, then one prompt, and the first run adds nothing', async () => {
    await world();
    let duplicated = false;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      if (!duplicated) {
        duplicated = true;
        // While this run waits on the model, a second worker runs the same message to the end.
        const event = (await w.db.query<{ id: string }>('SELECT id FROM inbound_events ORDER BY arrival_seq DESC LIMIT 1')).rows[0]!;
        await w.app.router.process(event.id);
        return respond([{ type: 'text', text: 'A late reply from the first run.' }]);
      }
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, SECRET);
    expect(duplicated).toBe(true);
    expect(w.textsTo(w.alex.address)).toEqual([REPLY, PROMPT]);
    await oneDelivery();
    await yesReleasesOnce();
  });
});
