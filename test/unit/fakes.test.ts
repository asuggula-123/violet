import { describe, expect, it } from 'vitest';
import { FakeCalendar, FakeGmail } from '../../src/google/fake.js';
import { ScriptedLlm, textResponse, toolUseResponse } from '../../src/llm/scripted.js';
import type { LlmRequest } from '../../src/llm/types.js';
import { FakeTransport } from '../../src/transport/fake.js';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 13, h, m));

describe('FakeCalendar', () => {
  it('freeBusy merges overlapping events, clips to the window and is per owner', async () => {
    const cal = new FakeCalendar();
    cal.seed('o1', { title: 'A', start: at(9), end: at(10) });
    cal.seed('o1', { title: 'B', start: at(9, 30), end: at(11) });
    cal.seed('o1', { title: 'C', start: at(11), end: at(12) });
    cal.seed('o1', { title: 'D', start: at(14), end: at(15) });
    cal.seed('o1', { title: 'E', start: at(7), end: at(8, 30) });
    cal.seed('o2', { title: 'Other', start: at(13), end: at(14) });
    const busy = await cal.freeBusy('o1', at(8), at(14, 30));
    expect(busy).toEqual([
      { start: at(8), end: at(8, 30) },
      { start: at(9), end: at(12) },
      { start: at(14), end: at(14, 30) },
    ]);
    expect(Object.keys(busy[0]!).sort()).toEqual(['end', 'start']);
  });

  it('createEvent is idempotent by key and records writes', async () => {
    const cal = new FakeCalendar();
    const ev = { title: 'Dinner', start: at(19), end: at(20) };
    const a = await cal.createEvent('o1', ev, 'k1');
    const b = await cal.createEvent('o1', ev, 'k1');
    const c = await cal.createEvent('o2', ev, 'k1');
    expect(a).toEqual(b);
    expect(c.eventId).not.toBe(a.eventId);
    expect(await cal.listEvents('o1', at(0), at(23))).toHaveLength(1);
    await cal.deleteEvent('o1', a.eventId);
    expect(await cal.listEvents('o1', at(0), at(23))).toHaveLength(0);
    expect(cal.writes.map((w) => w.op)).toEqual(['create', 'create', 'delete']);
  });
});

describe('FakeGmail', () => {
  it('searches per owner, newest first, and records drafts; has no send', async () => {
    const gmail = new FakeGmail();
    const base = { threadId: 't', to: 'alex@example.test', snippet: '' };
    gmail.seed('o1', { ...base, id: 'm1', from: 'school@example.test', subject: 'Trip', bodyText: 'permission slip', date: at(8) });
    gmail.seed('o1', { ...base, id: 'm2', from: 'club@example.test', subject: 'Trip update', bodyText: 'bus at 7', date: at(9) });
    gmail.seed('o2', { ...base, id: 'm3', from: 'x@example.test', subject: 'Trip', bodyText: '', date: at(10) });
    const found = await gmail.search('o1', 'trip', 10);
    expect(found.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(found[0]).not.toHaveProperty('bodyText');
    expect((await gmail.getMessage('o1', 'm1')).bodyText).toBe('permission slip');
    await expect(gmail.getMessage('o1', 'm3')).rejects.toThrow();
    const d = await gmail.createDraft('o1', { to: ['school@example.test'], subject: 'Re: Trip', body: 'Signed.' });
    expect(gmail.writes).toEqual([{ ownerId: 'o1', draftId: d.draftId, draft: { to: ['school@example.test'], subject: 'Re: Trip', body: 'Signed.' } }]);
    expect('send' in gmail).toBe(false);
  });
});

describe('ScriptedLlm', () => {
  const req = (agentId: string, mind: 'brain' | 'envoy'): LlmRequest => ({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 100,
    meta: { agentId, mind },
  });

  it('records calls, matches by meta and counts per responder', async () => {
    const llm = new ScriptedLlm();
    llm.on({ agentId: 'a1', mind: 'brain' }, (_r, n) => textResponse(`brain ${n}`));
    llm.on({ mind: 'envoy' }, () => textResponse('envoy'));
    expect((await llm.complete(req('a1', 'brain'))).content).toEqual([{ type: 'text', text: 'brain 0' }]);
    expect((await llm.complete(req('a1', 'brain'))).content).toEqual([{ type: 'text', text: 'brain 1' }]);
    expect((await llm.complete(req('a2', 'envoy'))).content).toEqual([{ type: 'text', text: 'envoy' }]);
    const fallback = await llm.complete(req('a2', 'brain'));
    expect(fallback).toEqual({ content: [{ type: 'text', text: 'OK.' }], stopReason: 'end_turn' });
    expect(llm.calls.map((c) => c.meta)).toEqual([
      { agentId: 'a1', mind: 'brain' },
      { agentId: 'a1', mind: 'brain' },
      { agentId: 'a2', mind: 'envoy' },
      { agentId: 'a2', mind: 'brain' },
    ]);
  });

  it('builds tool_use responses', async () => {
    const llm = new ScriptedLlm().on({}, () => toolUseResponse('t1', 'get_schedule', { day: 'friday' }));
    expect(await llm.complete(req('a1', 'brain'))).toEqual({
      content: [{ type: 'tool_use', id: 't1', name: 'get_schedule', input: { day: 'friday' } }],
      stopReason: 'tool_use',
    });
  });

  it('stores a copy of each request', async () => {
    const llm = new ScriptedLlm();
    const r = req('a1', 'brain');
    await llm.complete(r);
    r.messages.push({ role: 'assistant', content: 'mutated' });
    expect(llm.calls[0]?.messages).toHaveLength(1);
  });
});

describe('FakeTransport', () => {
  it('records sends and can be told to fail', async () => {
    const t = new FakeTransport();
    await t.send({ agentAddress: 'a', toAddress: 'b', text: 'one', purpose: 'reply' });
    t.failNext();
    await expect(t.send({ agentAddress: 'a', toAddress: 'b', text: 'two', purpose: 'reply' })).rejects.toThrow();
    t.setFailing(true);
    await expect(t.send({ agentAddress: 'a', toAddress: 'b', text: 'three', purpose: 'reply' })).rejects.toThrow();
    t.setFailing(false);
    await t.send({ agentAddress: 'a', toAddress: 'b', text: 'four', purpose: 'reply' });
    expect(t.textsTo('b')).toEqual(['one', 'four']);
    expect(new Set(t.sent.map((s) => s.transportMessageId)).size).toBe(2);
  });
});
