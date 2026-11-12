import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, contextOf, envoyCalls, onlyConversation, peerProposalSeq, respond, scriptEnvoy, stepOf, toolUse } from './helpers.js';

describe('a2a open conversation (not about times)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('who picks up the kids: a question to Sam, guidance, a zero-event agreement both approve', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('b', 'talk_to_agent', { with: 'sam', topic: 'Kids pickup Thursday', brief: 'Can Sam pick up the kids on Thursday?' })])
        : respond([{ type: 'text', text: 'Asked.' }]),
    );
    // Sam's Envoy has no brief: it asks Sam, then proposes what Sam said.
    scriptEnvoy(w, w.sam, (req) => {
      const ctx = contextOf(req);
      if (!/told you \(instruction\)/.test(ctx)) return [[toolUse('q', 'ask_owner', { question: 'Can you pick up the kids on Thursday?' })], 'ok'];
      return [[toolUse('p', 'propose', { summary: 'Sam picks up the kids on Thursday.', events: [] })], 'ok'];
    });
    scriptEnvoy(w, w.alex, (req) => {
      const seq = peerProposalSeq(req);
      return seq === null ? ['wait'] : [[toolUse('a', 'accept', { proposal_seq: seq })], 'ok'];
    });
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) => {
      const convId = /- ([0-9a-f-]{36}): with Alex's Violet/.exec(req.systemDynamic ?? '')?.[1];
      return stepOf(req) === 0 && convId
        ? respond([toolUse('t', 'tell_envoy', { conversation: convId, guidance: 'Yes, I can pick up the kids on Thursday.' })])
        : respond([{ type: 'text', text: 'Told it.' }]);
    });

    await w.ownerSays(w.alex, 'Can you ask Sam if she can pick up the kids on Thursday?');
    expect(w.textsTo(w.sam.address)).toEqual(['Violet ↔ Alex\'s Violet (“Kids pickup Thursday”) asks: “Can you pick up the kids on Thursday?”']);
    expect(w.transport.sent.at(-1)!.purpose).toBe('question');

    await w.ownerSays(w.sam, 'yes I can pick up the kids on thursday');
    const samBrain = w.llm.calls.filter((c) => c.meta.agentId === w.sam.agent.id && c.meta.mind === 'brain')[0]!;
    // D4: the open question reaches the Brain as untrusted data (and taints the turn) …
    expect(samBrain.systemDynamic).toMatch(/Open questions from your Envoy[\s\S]*<untrusted source="agent">[\s\S]*Can you pick up the kids on Thursday\?/);
    expect((await w.actions({ action: 'brain.turn', agentId: w.sam.agent.id })).at(-1)!.detail.tainted).toBe(true);
    // … so (I20) the guidance is held for Sam's yes on the exact words, even though they are her own; nothing crosses before it.
    expect(w.textsTo(w.sam.address)).toContain('#1 Tell Alex\'s Violet: “Yes, I can pick up the kids on Thursday.” Send? Reply yes or no.');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'question']);
    await w.ownerSays(w.sam, 'yes');
    expect(w.textsTo(w.sam.address)).toContain('Told Alex\'s Violet: “Yes, I can pick up the kids on Thursday.”');
    const prompt = '#1 With Sam: agreed “Sam picks up the kids on Thursday.”. OK? Reply yes or no.';
    expect(w.lastTo(w.alex.address)).toBe(prompt);
    expect(w.lastTo(w.sam.address)).toBe('#2 With Alex: agreed “Sam picks up the kids on Thursday.”. OK? Reply yes or no.');

    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe('Waiting for Alex.');
    await w.ownerSays(w.alex, 'ok');
    expect(w.lastTo(w.alex.address)).toBe('Agreed: “Sam picks up the kids on Thursday.”.');
    expect(w.lastTo(w.sam.address)).toBe('Agreed: “Sam picks up the kids on Thursday.”.');
    expect(w.calendar.writes).toEqual([]);
    expect(await onlyConversation(w)).toMatchObject({ status: 'closed', close_reason: 'booked' });
    // Guidance and the question stay on Sam's side: Alex's Envoy never saw them.
    expect(JSON.stringify(envoyCalls(w, w.alex))).not.toContain('Can you pick up the kids on Thursday?');
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open', 'question', 'guidance', 'proposal', 'accept', 'close']);
  });

  it('a turn with no outward act sends nothing, marks the side stalled and tells its owner once (digest)', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Weekend', brief: 'Plans for the weekend?' })]) : respond([{ type: 'text', text: 'ok' }]),
    );
    scriptEnvoy(w, w.sam, () => ['I am thinking.']);
    await w.ownerSays(w.alex, 'Ask Sam about plans for the weekend');
    expect(envoyCalls(w, w.sam)).toHaveLength(1);
    expect(envoyCalls(w, w.alex)).toHaveLength(0);
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);
    const side = (await w.db.query<{ stalled: boolean }>('SELECT stalled FROM a2a_sides WHERE agent_id = $1', [w.sam.agent.id])).rows[0]!;
    expect(side.stalled).toBe(true);
    const flags = (await w.app.repos.flags.listByAgent(w.sam.agent.id)).filter((f) => f.kind === 'a2a_stalled');
    expect(flags.map((f) => f.urgency)).toEqual(['digest']);
    expect(w.textsTo(w.sam.address)).toEqual([]);
  });

  it('the transcript is code-rendered, verbatim, one line per message, for either owner', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('b', 'talk_to_agent', { with: 'Sam', topic: 'Weekend', brief: 'Plans for the weekend?' })]) : respond([{ type: 'text', text: 'ok' }]),
    );
    scriptEnvoy(w, w.sam, () => [[toolUse('s', 'say', { text: 'Sam is around on Sunday.' })], 'ok']);
    scriptEnvoy(w, w.alex, () => [[toolUse('e', 'end_conversation', { reason: 'Thanks, noted.' })], 'ok']);
    await w.ownerSays(w.alex, 'Ask Sam about plans for the weekend');
    const conv = await onlyConversation(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0 ? respond([toolUse('t', 'send_transcript_to_owner', { conversation: conv.id })]) : respond([{ type: 'text', text: 'Sent.' }]),
    );
    await w.ownerSays(w.sam, 'send me the transcript');
    const transcript = w.transport.sent.find((m) => m.purpose === 'transcript')!;
    expect(transcript.toAddress).toBe(w.sam.address);
    expect(transcript.text.split('\n')).toEqual([
      'Transcript: Violet ↔ Alex\'s Violet, “Weekend” (closed: ended)',
      'Alex\'s Violet opened “Weekend”: “Plans for the weekend?”',
      'Violet: “Sam is around on Sunday.”',
      'Alex\'s Violet ended the conversation: “Thanks, noted.”',
    ]);
    // The other agent's words, as stored: the model never paraphrases a transcript.
    expect(await w.app.a2a!.transcript(w.alex.agent.id, conv.id)).toContain('Sam\'s Violet: “Sam is around on Sunday.”');
  });
});
