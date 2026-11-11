import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../src/core/canned.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('pause / resume (I14)', () => {
  let w: TestWorld;
  let hookCalls: string[];

  beforeEach(async () => {
    w = await createTestWorld({ modules: [] }); // bare M1 core
    hookCalls = [];
    w.app.router.hooks.onPause.push(async (id) => void hookCalls.push(`pause:${id}`));
    w.app.router.hooks.onResume.push(async (id) => void hookCalls.push(`resume:${id}`));
  });
  afterEach(async () => w.close());

  it('pause sends exactly one ack, then nothing to the owner or strangers', async () => {
    await w.ownerSays(w.alex, 'pause');
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused]);
    expect(hookCalls).toEqual([`pause:${w.alex.agent.id}`]);

    const before = w.transport.sent.length;
    await w.ownerSays(w.alex, 'what is on today?');
    await w.strangerSays(w.alex, '+15550001', 'hello?');
    await w.app.flags.raise(w.alex.agent.id, { kind: 'test', urgency: 'now', text: 'urgent thing' });
    expect(w.transport.sent.length).toBe(before);

    const held = await w.actions({ action: 'inbound.held', agentId: w.alex.agent.id });
    expect(held).toHaveLength(2);
    const stored = await w.app.repos.messages.recent(w.alex.agent.id, 'owner', 10);
    expect(stored.map((m) => m.body)).toContain('what is on today?');
    const flags = await w.app.repos.flags.listByAgent(w.alex.agent.id);
    expect(flags.map((f) => [f.kind, f.status])).toEqual([['test', 'suppressed']]);
  });

  it('direct gateway calls are refused while paused', async () => {
    await w.ownerSays(w.alex, 'pause');
    const before = w.transport.sent.length;
    const contact = await w.app.repos.contacts.upsert({ agentId: w.alex.agent.id, transport: 'fake', address: 'x', kind: 'stranger' });

    expect(await w.app.gateway.sendToOwner(w.alex.agent.id, 'sneaky', { purpose: 'reply' })).toBeNull();
    expect(await w.app.gateway.sendToOwner(w.alex.agent.id, 'Resumed.', { purpose: 'ack' })).toBeNull();
    expect(await w.app.gateway.sendToOwner(w.alex.agent.id, '#1 Book it?', { purpose: 'approval' })).toBeNull();
    await w.app.gateway.sendCanned(w.alex.agent.id, contact.id, 'stranger_reply');

    expect(w.transport.sent.length).toBe(before);
    const suppressed = await w.actions({ action: 'outbound.suppressed', agentId: w.alex.agent.id });
    expect(suppressed.map((a) => a.detail.purpose)).toEqual(['reply', 'ack', 'approval', 'canned']);
  });

  it('a repeated pause gets one ack and no state change', async () => {
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, '/PAUSE');
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.alreadyPaused]);
    expect(hookCalls).toHaveLength(1);
    expect(await w.actions({ action: 'agent.paused' })).toHaveLength(1);
  });

  it('resume acks once and restores sending; hooks fire', async () => {
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, ' Resume ');
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.paused, OWNER_TEXT.resumed]);
    expect(hookCalls).toEqual([`pause:${w.alex.agent.id}`, `resume:${w.alex.agent.id}`]);

    await w.ownerSays(w.alex, 'hi');
    expect(w.lastTo(w.alex.address)).toBe(OWNER_TEXT.notSetUp);
    await w.strangerSays(w.alex, '+15550001', 'hello?');
    expect(w.textsTo('+15550001')).toEqual([CANNED.stranger_reply]);
  });

  it('resume when not paused just says so', async () => {
    await w.ownerSays(w.alex, 'resume');
    expect(w.textsTo(w.alex.address)).toEqual([OWNER_TEXT.notPaused]);
    expect(hookCalls).toEqual([]);
  });

  it('only exact commands count', async () => {
    await w.ownerSays(w.alex, 'pause please');
    await w.ownerSays(w.alex, 'please pause');
    const agent = await w.app.repos.agents.get(w.alex.agent.id);
    expect(agent?.paused).toBe(false);
  });

  it('a stranger cannot pause or resume', async () => {
    await w.strangerSays(w.alex, '+15550001', 'pause');
    expect((await w.app.repos.agents.get(w.alex.agent.id))?.paused).toBe(false);
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, '+15550001', 'resume');
    expect((await w.app.repos.agents.get(w.alex.agent.id))?.paused).toBe(true);
    expect(hookCalls).toEqual([`pause:${w.alex.agent.id}`]);
  });

  it('pausing one agent does not pause another', async () => {
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.sam, 'hi');
    expect(w.textsTo(w.sam.address)).toEqual([OWNER_TEXT.notSetUp]);
  });

  it('logs pause and resume', async () => {
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'resume');
    expect(await w.actions({ action: 'agent.paused', agentId: w.alex.agent.id })).toHaveLength(1);
    expect(await w.actions({ action: 'agent.resumed', agentId: w.alex.agent.id })).toHaveLength(1);
    const acks = (await w.actions({ action: 'outbound.sent', agentId: w.alex.agent.id })).filter((a) => a.detail.purpose === 'ack');
    expect(acks).toHaveLength(2);
  });
});
