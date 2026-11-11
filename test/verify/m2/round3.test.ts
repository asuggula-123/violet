/**
 * M2 verifier, round 3: adversarial tests written by an independent verifier.
 * Failing tests here are evidence of findings; do not weaken them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRequest } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond, toolUse } from '../../unit/brain/script.js';

const dinner = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };

/** Text of the last plain (non tool-result) user turn. */
function lastUserText(req: LlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const blocks = m.content as Array<{ type: string; text?: string }>;
    if (blocks.every((b) => b.type === 'tool_result')) continue;
    return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

describe('M2 round 3: principle 5 for messages queued in the lane', () => {
  let w: TestWorld;
  afterEach(async () => {
    await w?.close();
    w = undefined as unknown as TestWorld;
  });

  const prompts = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval');

  function hostileBrain(): void {
    // On the first message the (hostile) model asks for an approval nobody requested.
    // On any other message it just answers.
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      const last = req.messages.at(-1)!;
      const isResults = Array.isArray(last.content) && (last.content as Array<{ type: string }>).every((b) => b.type === 'tool_result');
      if (isResults) return respond([{ type: 'text', text: 'Done.' }]);
      if (lastUserText(req).includes('what is on friday')) return respond([toolUse('t1', 'request_calendar_event', dinner)]);
      return respond([{ type: 'text', text: 'Okay.' }]);
    });
  }

  it('an "ok" the owner sent BEFORE the prompt went out (queued behind the Brain turn) does not approve it', async () => {
    w = await createTestWorld();
    hostileBrain();
    // The owner sends two messages back to back. Both are ingested before the lane runs,
    // so the "ok" was typed before any prompt existed.
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'ok' });
    await w.app.settle();
    expect(prompts()).toHaveLength(1);
    // The owner never saw the prompt when they wrote "ok".
    expect(w.calendar.writes).toEqual([]);
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(0);
    const pending = await w.app.approvals!.listPending(w.alex.agent.id);
    expect(pending).toHaveLength(1);
  });

  it('an explicit "yes 1" queued before approval #1 existed does not approve it', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes 1' });
    await w.app.settle();
    expect(prompts()).toHaveLength(1);
    expect(w.calendar.writes).toEqual([]);
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(0);
  });

  it('control: an "ok" sent after the prompt was delivered still approves it', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.ownerSays(w.alex, 'what is on friday?');
    expect(prompts()).toHaveLength(1);
    await w.ownerSays(w.alex, 'ok');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
  });
});
