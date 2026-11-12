import { describe, expect, it } from 'vitest';
import { chatPosition, idsAbove, isDirectlyAbove } from '../../../src/transport/chatOrder.js';
import { FakeTransport } from '../../../src/transport/fake.js';
import type { InboundMessage } from '../../../src/transport/types.js';

describe('I19 chat order: "directly above" from the transport numbering only', () => {
  it('outbound <chat>:<n> is directly above inbound <chat>:<n+1>, nothing else', () => {
    expect(isDirectlyAbove('1101:7', '1101:8')).toBe(true);
    expect(isDirectlyAbove('1101:7', '1101:9')).toBe(false); // a gap
    expect(isDirectlyAbove('1101:8', '1101:8')).toBe(false);
    expect(isDirectlyAbove('1101:9', '1101:8')).toBe(false); // below
    expect(isDirectlyAbove('1102:7', '1101:8')).toBe(false); // another chat
    expect(isDirectlyAbove('-1001101:7', '-1001101:8')).toBe(true);
  });

  it('unknown or malformed ids fail closed', () => {
    for (const [out, msg] of [
      [null, '1101:8'],
      ['1101:7', undefined],
      ['fake-out-7', '1101:8'],
      ['1101:07', '1101:8'],
      ['1101:7', '1101:08'],
      ['1101:7.0', '1101:8'],
      ['1101:', '1101:1'],
      [':7', ':8'],
      ['1101:-1', '1101:0'],
      ['1101: 7', '1101:8'],
      ['', ''],
    ] as const) {
      expect(isDirectlyAbove(out, msg), `${out} / ${msg}`).toBe(false);
    }
  });

  it('compares large numbers exactly (beyond 2^53)', () => {
    expect(isDirectlyAbove('7:9007199254740993', '7:9007199254740994')).toBe(true);
    expect(isDirectlyAbove('7:9007199254740992', '7:9007199254740994')).toBe(false);
    expect(chatPosition('a:b:12')).toEqual({ chat: 'a:b', n: 12n });
  });

  it('idsAbove walks upwards, nearest first, and stops at 1', () => {
    expect(idsAbove('c:4', 10)).toEqual(['c:3', 'c:2', 'c:1', 'c:0']);
    expect(idsAbove('c:100', 2)).toEqual(['c:99', 'c:98']);
    expect(idsAbove('garbage', 5)).toEqual([]);
    expect(idsAbove(undefined, 5)).toEqual([]);
  });
});

describe('FakeTransport numbering', () => {
  const inbound = (over: Partial<InboundMessage>): InboundMessage => ({
    transport: 'fake',
    agentAddress: 'bot',
    fromAddress: 'alex',
    kind: 'text',
    text: 'hi',
    transportMessageId: `in-${Math.random()}`,
    receivedAt: new Date(0),
    ...over,
  });

  it('per chat: both directions take the next number; a redelivery keeps its number; a button takes none', async () => {
    const t = new FakeTransport();
    expect((await t.send({ agentAddress: 'bot', toAddress: 'alex', text: 'a', purpose: 'reply' })).transportMessageId).toBe('bot/alex:1');
    const m = inbound({ transportMessageId: 'x' });
    expect(t.numberInbound(m)).toBe('bot/alex:2');
    expect(t.numberInbound(m)).toBe('bot/alex:2');
    expect(t.numberInbound(inbound({ kind: 'button' }))).toBeUndefined();
    expect(t.numberInbound(inbound({ fromAddress: 'stranger' }))).toBe('bot/stranger:1');
    t.skip('bot', 'alex', 2);
    expect((await t.send({ agentAddress: 'bot', toAddress: 'alex', text: 'b', purpose: 'reply' })).transportMessageId).toBe('bot/alex:5');
  });

  it("per bot: one counter for all of a bot's chats (a stranger makes a gap); none: no numbering", async () => {
    const t = new FakeTransport({ numbering: 'per-bot' });
    expect(t.numberInbound(inbound({}))).toBe('bot/alex:1');
    expect(t.numberInbound(inbound({ fromAddress: 'stranger' }))).toBe('bot/stranger:2');
    expect(t.numberInbound(inbound({}))).toBe('bot/alex:3');
    const none = new FakeTransport({ numbering: 'none' });
    expect(none.numberInbound(inbound({}))).toBeUndefined();
    expect((await none.send({ agentAddress: 'bot', toAddress: 'alex', text: 'a', purpose: 'reply' })).transportMessageId).toBe('fake-out-1');
  });
});
