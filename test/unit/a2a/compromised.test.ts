import { afterEach, describe, expect, it } from 'vitest';
import type { LlmBlock } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, contextOf, dinnerEvent, envoyCalls, FRI, lastResults, onlyConversation, peerProposalSeq, respond, scriptEnvoy, stepOf, toolUse } from './helpers.js';

/** Alex opens a conversation with Sam (window optional); Sam's Envoy is then the compromised one under test. */
function open(w: TestWorld, window: { window_start: string; window_end: string } | null = { window_start: FRI.windowStart, window_end: FRI.windowEnd }): void {
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
    stepOf(req) === 0 ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner on Friday?', ...(window ?? {}) })]) : respond([{ type: 'text', text: 'ok' }]),
  );
}

/** Sam's Envoy plays `steps` in its first turn. */
function samFirstTurn(w: TestWorld, steps: LlmBlock[][]): void {
  scriptEnvoy(w, w.sam, () => [...steps, 'done']);
}

const refusals = async (w: TestWorld) => [...(await w.actions({ action: 'a2a.limit' })).map((a) => `limit:${a.detail.limit}`), ...(await w.actions({ action: 'a2a.tool_denied' })).map((a) => `denied:${a.detail.reason}`)];

describe('a compromised own Envoy: every rule holds in code', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('availability outside the window, without a window, and past the budget is refused (and logged)', async () => {
    w = await createTestWorld();
    open(w);
    const outside = toolUse('o', 'check_availability', { start: '2026-11-20T00:00:00-05:00', end: '2026-11-21T00:00:00-05:00' });
    const ok = (n: number) => toolUse(`k${n}`, 'check_availability', { start: FRI.windowStart, end: FRI.windowEnd });
    samFirstTurn(w, [[outside, ok(1), ok(2), ok(3), ok(4)], [ok(5), ok(6), ok(7), ok(8), ok(9)]]);
    await w.ownerSays(w.alex, 'dinner friday with sam');
    expect(await refusals(w)).toEqual(['limit:outside_window', 'limit:availability_budget']);
    expect((await w.actions({ action: 'a2a.availability' })).length).toBe(8);
    const results = lastResults(envoyCalls(w, w.sam).at(-1)!);
    expect(results.at(-1)!.content).toBe('No availability checks left for this conversation.');
  });

  it('no window → no availability at all', async () => {
    w = await createTestWorld();
    open(w, null);
    samFirstTurn(w, [[toolUse('a', 'check_availability', { start: FRI.windowStart, end: FRI.windowEnd })]]);
    await w.ownerSays(w.alex, 'dinner friday with sam');
    expect(await refusals(w)).toEqual(['limit:no_window']);
    expect(await w.actions({ action: 'a2a.availability' })).toEqual([]);
  });

  it('the peer reads at most 7 days of a window its owner did not set', async () => {
    w = await createTestWorld();
    open(w, { window_start: '2026-11-10T00:00:00-05:00', window_end: '2026-11-30T00:00:00-05:00' });
    samFirstTurn(w, [[toolUse('a', 'check_availability', { start: '2026-11-20T00:00:00-05:00', end: '2026-11-21T00:00:00-05:00' }), toolUse('b', 'check_availability', { start: '2026-11-10T00:00:00-05:00', end: '2026-11-30T00:00:00-05:00' })]]);
    await w.ownerSays(w.alex, 'dinner with sam sometime');
    expect(await refusals(w)).toEqual(['limit:outside_window']);
    const read = (await w.actions({ action: 'a2a.availability' }))[0]!;
    expect(read.detail.to).toBe(new Date('2026-11-17T00:00:00-05:00').toISOString());
  });

  it('50 events, past or out-of-window events are refused; two outward acts in one turn: only the first goes out', async () => {
    w = await createTestWorld();
    open(w);
    const many = Array.from({ length: 50 }, () => dinnerEvent());
    samFirstTurn(w, [
      [
        toolUse('p1', 'propose', { summary: 'lots', events: many }),
        toolUse('p2', 'propose', { summary: 'past', events: [dinnerEvent({ start: '2026-11-01T19:00:00-05:00', end: '2026-11-01T20:00:00-05:00' })] }),
        toolUse('p3', 'propose', { summary: 'later', events: [dinnerEvent({ start: '2026-11-20T19:00:00-05:00', end: '2026-11-20T20:00:00-05:00' })] }),
        toolUse('p4', 'propose', { summary: 'too long', events: [dinnerEvent({ start: '2026-11-13T01:00:00-05:00', end: '2026-11-14T03:00:00-05:00' })] }),
      ],
      [toolUse('s1', 'say', { text: 'first act' }), toolUse('s2', 'say', { text: 'second act' }), toolUse('s3', 'end_conversation', {})],
    ]);
    await w.ownerSays(w.alex, 'dinner friday with sam');
    expect(await refusals(w)).toEqual(['denied:invalid_input', 'denied:invalid_event', 'denied:outside_window', 'denied:invalid_event', 'denied:second_act', 'denied:second_act']);
    expect((await a2aMessages(w)).map((m) => [m.kind, m.body])).toEqual([
      ['open', 'Dinner on Friday?'],
      ['text', 'first act'],
    ]);
    expect((await onlyConversation(w)).status).toBe('open');
  });

  it('accepting its own, a stale or a missing proposal is refused; unknown tools are rejected', async () => {
    w = await createTestWorld();
    open(w);
    scriptEnvoy(w, w.sam, (req) =>
      /You proposed/.test(contextOf(req))
        ? [[toolUse('x', 'accept', { proposal_seq: 2 }), toolUse('y', 'accept', { proposal_seq: 99 }), toolUse('u', 'approve', { id: 'any' }), toolUse('v', 'book_event', {})], 'done']
        : [[toolUse('p', 'propose', { summary: 'dinner', events: [dinnerEvent()] })], 'done'],
    );
    // Alex's Envoy declines, then Sam's turn tries to accept its own (now dead) proposal.
    scriptEnvoy(w, w.alex, (req) => {
      const seq = peerProposalSeq(req);
      return seq ? [[toolUse('d', 'decline', { proposal_seq: seq, reason: 'no' }), toolUse('a', 'accept', { proposal_seq: seq })], 'ok'] : ['wait'];
    });
    await w.ownerSays(w.alex, 'dinner friday with sam');
    expect(await refusals(w)).toEqual(['denied:second_act', 'denied:own_proposal', 'denied:stale_proposal', 'denied:unknown_tool', 'denied:unknown_tool']);
    expect(await w.db.query('SELECT * FROM approvals')).toMatchObject({ rows: [] });
  });

  it('a stale accept: a proposal superseded by a newer one cannot be accepted', async () => {
    w = await createTestWorld();
    open(w);
    scriptEnvoy(w, w.sam, (req) =>
      /You proposed/.test(contextOf(req)) ? ['done'] : [[toolUse('p', 'propose', { summary: 'dinner', events: [dinnerEvent()] })], 'done'],
    );
    scriptEnvoy(w, w.alex, (req) => {
      const seq = peerProposalSeq(req);
      // Counter-proposes, then (next turn) tries to accept the superseded one.
      return seq ? [[toolUse('c', 'propose', { summary: 'later dinner', events: [dinnerEvent({ start: '2026-11-13T20:00:00-05:00', end: '2026-11-13T21:00:00-05:00' })] })], [toolUse('a', 'accept', { proposal_seq: seq })], 'ok'] : ['wait'];
    });
    await w.ownerSays(w.alex, 'dinner friday with sam');
    expect(await refusals(w)).toEqual(['denied:second_act']);
    expect(await w.db.query('SELECT * FROM approvals')).toMatchObject({ rows: [] });
  });

  it('13 messages: the conversation closes with reason limit and both owners get a digest flag', async () => {
    w = await createTestWorld();
    open(w);
    scriptEnvoy(w, w.sam, () => [[toolUse('s', 'say', { text: 'more?' })], 'ok']);
    scriptEnvoy(w, w.alex, () => [[toolUse('s', 'say', { text: 'more!' })], 'ok']);
    await w.ownerSays(w.alex, 'dinner friday with sam');
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'limit' });
    const sides = (await w.db.query<{ agent_id: string; messages_sent: number }>('SELECT agent_id, messages_sent FROM a2a_sides')).rows;
    expect(sides.every((s) => s.messages_sent <= 12)).toBe(true);
    expect((await a2aMessages(w)).filter((m) => m.kind !== 'close')).toHaveLength(24);
    expect(await refusals(w)).toEqual(['limit:messages_per_side']);
    for (const p of [w.alex, w.sam]) {
      expect((await w.app.repos.flags.listByAgent(p.agent.id)).filter((f) => f.kind === 'a2a_closed').map((f) => f.urgency)).toEqual(['digest']);
    }
    // 24 turns (12 per side; Alex's last one hit the limit), then nothing more runs.
    expect(envoyCalls(w).filter((c) => stepOf(c) === 0).length).toBe(24);
  });

  it('ask_owner: at most 2 per side', async () => {
    w = await createTestWorld();
    open(w);
    scriptEnvoy(w, w.sam, () => [[toolUse('q', 'ask_owner', { question: 'Friday ok?' })], 'ok']);
    await w.ownerSays(w.alex, 'dinner friday with sam');
    const conv = await onlyConversation(w);
    // Sam's Brain relays two answers, each a new Envoy turn that asks again.
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('t', 'tell_envoy', { conversation: conv.id, guidance: 'Friday ok' })]) : respond([{ type: 'text', text: 'ok' }]),
    );
    await w.ownerSays(w.sam, 'Friday ok');
    await w.ownerSays(w.sam, 'friday ok again');
    expect(w.textsTo(w.sam.address).filter((t) => t.includes('asks:'))).toHaveLength(2);
    expect(await refusals(w)).toEqual(['limit:questions_per_side']);
  });
});
