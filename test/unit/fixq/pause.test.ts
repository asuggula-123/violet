/**
 * Q1 (I14): a pause ingested while a Brain turn is in flight silences that turn towards other
 * agents too. A hostile (or just busy) model calls talk_to_agent, tell_envoy or
 * end_agent_conversation after the pause landed: code refuses each one inside the transaction
 * that would write the outward message. A release the owner approved just before the pause does
 * not cross while paused; it is carried out once, after resume.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, envoyCalls, FRI, onlyConversation, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';

const PAUSED_TOOL_TEXT = 'Not sent: your owner paused you, so nothing goes to another agent until they text resume. Do not try again.';

describe('Q1: pause silences agent-to-agent for a turn already running', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  /** Alex texts "pause" while the Brain's first model call is in flight (ingest only: the flip is immediate). */
  function pauseDuringStep0(then: (req: LlmRequest) => LlmResponse): void {
    let paused = false;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      if (stepOf(req) === 0 && !paused) {
        paused = true;
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
      }
      return then(req);
    });
  }

  /** Alex opens "Dinner Friday" with Sam in an untainted turn; Sam's Envoy answers once. */
  async function openDinner(): Promise<string> {
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('o', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner on Friday?', window_start: FRI.windowStart, window_end: FRI.windowEnd })])
        : respond([{ type: 'text', text: 'Asked.' }]),
    );
    scriptEnvoy(w, w.sam, (req) => (/Sam can do 7/.test(JSON.stringify(req.messages)) ? ['ok'] : [[toolUse('s', 'say', { text: 'Sam can do 7.' })], 'ok']));
    scriptEnvoy(w, w.alex, () => ['waiting']);
    await w.ownerSays(w.alex, 'Ask Sam about dinner on Friday');
    return (await onlyConversation(w)).id;
  }

  const denied = async (tool: string) => (await w.actions({ action: 'a2a.tool_denied', agentId: w.alex.agent.id })).filter((a) => a.detail.tool === tool).map((a) => a.detail.reason);
  const toolResults = (tool: string) =>
    w.llm.calls
      .filter((c) => c.meta.agentId === w.alex.agent.id && c.meta.mind === 'brain')
      .flatMap((c) => c.messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === tool)
      .map((b) => (b as { content: string }).content);

  it('talk_to_agent after the pause: refused in code, nothing reaches Sam, not before and not after resume', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => [[toolUse('s', 'say', { text: 'Hi.' })], 'ok']);
    pauseDuringStep0((req) =>
      stepOf(req) === 0
        ? respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner on Friday?', window_start: FRI.windowStart, window_end: FRI.windowEnd })])
        : respond([{ type: 'text', text: "I've asked Sam's Violet." }]),
    );
    await w.ownerSays(w.alex, 'Ask Sam about dinner on Friday');
    expect(await a2aMessages(w)).toEqual([]);
    expect(await w.db.query('SELECT id FROM a2a_conversations')).toMatchObject({ rows: [] });
    expect(envoyCalls(w, w.sam)).toEqual([]);
    expect(w.textsTo(w.sam.address)).toEqual([]);
    expect(await denied('talk_to_agent')).toEqual(['paused']);
    expect(toolResults('t')).toEqual([PAUSED_TOOL_TEXT]);
    // Silent to Alex too: only the pause ack went out.
    expect(w.textsTo(w.alex.address)).toEqual([expect.stringMatching(/^Paused/)]);

    await w.ownerSays(w.alex, 'resume');
    expect(await a2aMessages(w)).toEqual([]);
    expect(envoyCalls(w, w.sam)).toEqual([]);
    expect(w.textsTo(w.sam.address)).toEqual([]);
  });

  it('tell_envoy after the pause: no guidance row, no Envoy turn, no Told line', async () => {
    w = await createTestWorld();
    const convId = await openDinner();
    const before = await a2aMessages(w);
    const samCalls = envoyCalls(w, w.sam).length;
    const alexCalls = envoyCalls(w, w.alex).length;
    pauseDuringStep0((req) =>
      stepOf(req) === 0 ? respond([toolUse('g', 'tell_envoy', { conversation: convId, guidance: '7 works for Alex.' })]) : respond([{ type: 'text', text: 'Told it.' }]),
    );
    await w.ownerSays(w.alex, 'Tell it 7 works');
    expect(await a2aMessages(w)).toEqual(before);
    expect(envoyCalls(w, w.alex)).toHaveLength(alexCalls);
    expect(envoyCalls(w, w.sam)).toHaveLength(samCalls);
    expect(await denied('tell_envoy')).toEqual(['paused']);
    expect(toolResults('g')).toEqual([PAUSED_TOOL_TEXT]);

    await w.ownerSays(w.alex, 'resume');
    expect((await a2aMessages(w)).filter((m) => m.kind === 'guidance')).toEqual([]);
    expect(envoyCalls(w, w.sam)).toHaveLength(samCalls);
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Told '))).toEqual([]);
  });

  it('end_agent_conversation after the pause: refused, the conversation stays open, Sam sees no close', async () => {
    w = await createTestWorld();
    const convId = await openDinner();
    const before = await a2aMessages(w);
    pauseDuringStep0((req) => (stepOf(req) === 0 ? respond([toolUse('e', 'end_agent_conversation', { conversation: convId })]) : respond([{ type: 'text', text: 'Ended.' }])));
    await w.ownerSays(w.alex, 'End that conversation');
    expect(await a2aMessages(w)).toEqual(before);
    expect((await onlyConversation(w)).status).toBe('open');
    expect(await denied('end_agent_conversation')).toEqual(['paused']);
    expect(await w.actions({ action: 'a2a.closed' })).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    expect((await onlyConversation(w)).status).toBe('open');
    expect(await a2aMessages(w)).toEqual(before);
  });

  /**
   * The pause lands after the owner's yes resolved the release and before it is carried out
   * (between the approval's resolution and its callback).
   */
  function pauseRightAfterYes(): void {
    let armed = false;
    const write = w.app.actionLog.write.bind(w.app.actionLog);
    w.app.actionLog.write = async (entry, q) => {
      await write(entry, q);
      if (entry.action === 'approval.approved') armed = true;
    };
    const get = w.app.repos.owners.get.bind(w.app.repos.owners);
    w.app.repos.owners.get = async (id) => {
      if (armed) {
        armed = false;
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
      }
      return get(id);
    };
  }

  it('a talk_to_agent release approved just before the pause: held while paused, carried out once after resume', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => [[toolUse('s', 'say', { text: 'Hi Alex.' })], 'ok']);
    scriptEnvoy(w, w.alex, () => ['waiting']);
    // A tainted turn (it reads the calendar first): the release is held for Alex's yes (I20).
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]),
        respond([toolUse('t', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner on Friday?' })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Ask Sam about dinner on Friday');
    expect(w.lastTo(w.alex.address)).toBe("#1 Tell Sam's Violet about “Dinner Friday”: “Dinner on Friday?” Send? Reply yes or no.");

    pauseRightAfterYes();
    await w.ownerSays(w.alex, 'yes');
    const approval = async () => (await w.db.query<{ status: string }>("SELECT status FROM approvals WHERE kind = 'a2a_release'")).rows[0]!.status;
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(true);
    expect(await a2aMessages(w)).toEqual([]);
    expect(envoyCalls(w, w.sam)).toEqual([]);
    expect(w.textsTo(w.sam.address)).toEqual([]);
    expect(await approval()).toBe('approved');
    expect((await w.actions({ action: 'a2a.tool_denied' })).map((a) => a.detail.reason)).toEqual(['paused']);

    const sent = w.textsTo(w.alex.address).length;
    await w.ownerSays(w.alex, 'resume');
    expect((await a2aMessages(w)).filter((m) => m.from_agent_id === w.alex.agent.id).map((m) => [m.kind, m.body])).toEqual([['open', 'Dinner on Friday?']]);
    expect(w.textsTo(w.alex.address).slice(sent)).toEqual(["Resumed. I'm back on.", "Talking to Sam's Violet about “Dinner Friday”: “Dinner on Friday?”"]);
    expect(envoyCalls(w, w.sam).length).toBeGreaterThan(0);
    expect(await approval()).toBe('executed');

    // Exactly once: a second pause and resume carries out nothing more.
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'resume');
    expect((await a2aMessages(w)).filter((m) => m.kind === 'open')).toHaveLength(1);
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Talking to'))).toHaveLength(1);
  });

  it('a tell_envoy release approved just before the pause: no guidance until resume, then once', async () => {
    w = await createTestWorld();
    const convId = await openDinner();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]),
        respond([toolUse('g', 'tell_envoy', { conversation: convId, guidance: '7 works for Alex.' })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Tell it 7 works');
    expect(w.lastTo(w.alex.address)).toMatch(/^#1 Tell Sam's Violet: “7 works for Alex\.” Send\? Reply yes or no\.$/);
    const alexCalls = envoyCalls(w, w.alex).length;

    pauseRightAfterYes();
    await w.ownerSays(w.alex, 'yes');
    expect((await a2aMessages(w)).filter((m) => m.kind === 'guidance')).toEqual([]);
    expect(envoyCalls(w, w.alex)).toHaveLength(alexCalls);

    await w.ownerSays(w.alex, 'resume');
    expect((await a2aMessages(w)).filter((m) => m.kind === 'guidance').map((m) => m.body)).toEqual(['7 works for Alex.']);
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith('Told '))).toEqual(["Told Sam's Violet: “7 works for Alex.”"]);
    expect(envoyCalls(w, w.alex).length).toBeGreaterThan(alexCalls);
  });

  it('an approved release refused for another reason after resume: one true line, never tried again', async () => {
    w = await createTestWorld();
    const convId = await openDinner();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      [
        respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]),
        respond([toolUse('g', 'tell_envoy', { conversation: convId, guidance: '7 works for Alex.' })]),
        respond([{ type: 'text', text: "I'll check with you first." }]),
      ][Math.min(stepOf(req), 2)]!,
    );
    await w.ownerSays(w.alex, 'Tell it 7 works');
    pauseRightAfterYes();
    await w.ownerSays(w.alex, 'yes');
    // Sam ends the conversation while Alex is paused.
    await w.db.query("UPDATE a2a_conversations SET status = 'closed', close_reason = 'ended' WHERE id = $1", [convId]);
    await w.ownerSays(w.alex, 'resume');
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith("Couldn't send"))).toEqual([
      "Couldn't send #1: That conversation is closed. Start a new one with talk_to_agent.",
    ]);
    expect((await w.db.query<{ status: string }>("SELECT status FROM approvals WHERE kind = 'a2a_release'")).rows[0]!.status).toBe('failed');
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'resume');
    expect(w.textsTo(w.alex.address).filter((t) => t.startsWith("Couldn't send"))).toHaveLength(1);
    expect((await a2aMessages(w)).filter((m) => m.kind === 'guidance')).toEqual([]);
  });
});
