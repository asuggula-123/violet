/**
 * M2 verifier, round 4: adversarial tests written by an independent verifier.
 * Failing tests here are evidence of findings; do not weaken them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRequest } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond, toolUse } from '../../unit/brain/script.js';

const dinner = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };

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

describe('M2 round 4: arrival ordering of owner decisions', () => {
  let w: TestWorld;
  afterEach(async () => {
    await w?.close();
    w = undefined as unknown as TestWorld;
  });

  const prompts = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval');

  function hostileBrain(trigger = 'what is on friday', input: Record<string, string> = dinner): void {
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      const last = req.messages.at(-1)!;
      const isResults = Array.isArray(last.content) && (last.content as Array<{ type: string }>).every((b) => b.type === 'tool_result');
      if (isResults) return respond([{ type: 'text', text: 'Done.' }]);
      if (lastUserText(req).includes(trigger)) return respond([toolUse('t1', 'request_calendar_event', input)]);
      return respond([{ type: 'text', text: 'Okay.' }]);
    });
  }

  it('a queued "no" does not deny the prompt created ahead of it', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'no' });
    await w.app.settle();
    expect(prompts()).toHaveLength(1);
    expect(await w.actions({ action: 'approval.denied' })).toHaveLength(0);
    expect(await w.app.approvals!.listPending(w.alex.agent.id)).toHaveLength(1);
  });

  it('a queued "ok" whose own job is retried after the prompt went out still does not approve it', async () => {
    w = await createTestWorld();
    hostileBrain();
    const send = w.transport.send.bind(w.transport);
    let replies = 0;
    w.transport.send = async (msg) => {
      // The reply to the queued "ok" fails once, so its whole job retries later.
      if (msg.purpose === 'reply' && msg.text === 'Okay.' && replies++ === 0) throw new Error('network');
      return send(msg);
    };
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'ok' });
    await w.app.settle();
    await w.advance({ minutes: 5 });
    await w.advance({ minutes: 5 });
    expect(prompts()).toHaveLength(1);
    expect(w.calendar.writes).toEqual([]);
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(0);
  });

  it('a redelivered (duplicate) pre-prompt "yes" arriving after the prompt does not approve it', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?', transportMessageId: 'tg-1' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes', transportMessageId: 'tg-2' });
    await w.app.settle();
    expect(prompts()).toHaveLength(1);
    // The transport delivers the same update again after the prompt went out.
    await w.ownerSays(w.alex, 'yes', { transportMessageId: 'tg-2' });
    expect(w.calendar.writes).toEqual([]);
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(0);
  });

  it('a queued "yes" with an older delivered prompt answers only the older one, never the prompt created ahead of it', async () => {
    w = await createTestWorld();
    const older = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...dinner, title: 'Lunch' } });
    expect(prompts()).toHaveLength(1);
    hostileBrain();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes' });
    await w.app.settle();
    // I19: the queued "yes" is not right under the older prompt (the owner's own message is in
    // between): that prompt is shown again, the newer one is never touched.
    expect(prompts()).toHaveLength(3);
    expect(prompts().at(-1)!.text).toBe(`Just to be sure: ${older.prompt}`);
    expect((await w.app.approvals!.get(older.id))!.status).toBe('pending');
    // That re-prompt sits right under the newer prompt, so a bare yes under both asks "Which one?"; the ref picks it.
    await w.ownerSays(w.alex, 'yes');
    expect((await w.app.approvals!.get(older.id))!.status).toBe('pending');
    await w.ownerSays(w.alex, `yes ${older.ref}`);
    const created = w.calendar.writes.filter((x) => x.op === 'create');
    expect(created.every((x) => JSON.stringify(x).includes('Lunch'))).toBe(true);
    expect(JSON.stringify(created)).not.toContain('Dinner');
    expect((await w.app.approvals!.get(older.id))!.status).not.toBe('pending');
    const pending = await w.app.approvals!.listPending(w.alex.agent.id);
    expect(pending.map((a) => (a.payload as { title: string }).title)).toEqual(['Dinner']);
  });

  it('the other owner\'s traffic interleaved does not let Alex\'s queued "ok" answer his prompt', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'ok' });
    await w.inbound({ agentAddress: w.sam.agentAddress, fromAddress: w.sam.address, text: 'hello' });
    await w.app.settle();
    expect(w.calendar.writes).toEqual([]);
    expect(await w.app.approvals!.listPending(w.alex.agent.id)).toHaveLength(1);
  });

  it('control: after a queued "ok" falls through, a fresh "yes" approves exactly once', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'what is on friday?' });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'ok' });
    await w.app.settle();
    expect(w.calendar.writes).toEqual([]);
    // I19: a yes under the Brain's reply is conversation; "yes 1" shows the prompt again, the yes under it approves.
    await w.ownerSays(w.alex, 'yes 1');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
    expect(await w.actions({ action: 'approval.approved' })).toHaveLength(1);
  });

  it('control: a reply-to on the prompt and a button press still resolve it', async () => {
    w = await createTestWorld();
    hostileBrain();
    await w.ownerSays(w.alex, 'what is on friday?');
    const p = prompts()[0]!;
    await w.ownerSays(w.alex, 'no', { replyToTransportMessageId: p.transportMessageId });
    expect(await w.actions({ action: 'approval.denied' })).toHaveLength(1);
    const b = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { ...dinner, title: 'Brunch' } });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${b.id}` });
    expect((await w.app.approvals!.get(b.id))!.status).toBe('executed');
  });
});
