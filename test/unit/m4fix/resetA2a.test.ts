/**
 * pairing:reissue --reset × agent-to-agent (gfix × M4): after a reset the old chat is a stranger.
 * It cannot answer the agent's pending a2a approvals (typed or by button) or its Envoy questions,
 * and reaches no model. The newly paired chat inherits the agent: its open conversations, its
 * pending approvals (answerable by ref) and the lines held while no chat was paired.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../../src/core/canned.js';
import { reissuePairingCode } from '../../../src/core/pairingReissue.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, honestDinnerEnvoys, respond, scriptEnvoy, toolUse } from '../a2a/helpers.js';

const NEW = 'sam-new-phone';

describe('a2a after pairing:reissue --reset', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  const reset = async () => (await reissuePairingCode({ db: w.db, clock: w.clock, actionLog: w.app.actionLog }, w.sam.agent.id, { reset: true })).code;
  const samBrainCalls = () => w.llm.calls.filter((c) => c.meta.agentId === w.sam.agent.id && c.meta.mind === 'brain').length;

  it('the old chat cannot answer the pending outcome approval; the new chat answers it by ref and the booking completes', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    // A hostile Brain for Sam, scripted to claim anything: it must never run for the old chat.
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'Done, booked it for you.' }]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const approval = (await w.db.query<{ id: string }>(`SELECT id FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'`, [w.sam.agent.id])).rows[0]!;
    const code = await reset();

    await w.ownerSays(w.sam, 'yes');
    await w.ownerSays(w.sam, 'yes 1');
    await w.inbound({ agentAddress: w.sam.agentAddress, fromAddress: w.sam.address, kind: 'button', text: '', buttonPayload: `approve:${approval.id}` });
    await w.app.settle();
    expect((await w.app.approvals!.get(approval.id))!.status).toBe('pending');
    expect(samBrainCalls()).toBe(0);
    expect(w.textsTo(w.sam.address).at(-1)).toBe(CANNED.stranger_reply);
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toBe('Waiting for Sam.');
    expect(w.calendar.writes).toEqual([]);

    await w.strangerSays(w.sam, NEW, `/start ${code}`);
    expect(w.lastTo(NEW)).toBe(OWNER_TEXT.paired);
    await w.ownerSays({ ...w.sam, address: NEW }, 'yes 1');
    expect(w.lastTo(NEW)).toBe('Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.');
    expect(w.lastTo(w.alex.address)).toBe('Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.');
    expect(w.textsTo(w.sam.address).filter((t) => t.startsWith('Booked'))).toEqual([]);
  });

  it('an Envoy question asked while no chat is paired waits; the old chat cannot answer it; the new chat gets it from the sweep', async () => {
    w = await createTestWorld();
    const code = await reset();
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, () => [[toolUse('q', 'ask_owner', { question: 'Is 7 pm on Friday fine?' })], 'asked']);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, () => respond([toolUse('g', 'tell_envoy', { conversation_id: 'x', text: 'yes' })]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const question = "Violet ↔ Alex's Violet (“Dinner Friday”) asks: “Is 7 pm on Friday fine?”";
    expect(w.transport.sent.some((m) => m.text === question)).toBe(false);

    await w.ownerSays(w.sam, '7 pm is fine');
    expect(w.lastTo(w.sam.address)).toBe(CANNED.stranger_reply);
    expect(samBrainCalls()).toBe(0);
    const guidance = await w.db.query(`SELECT 1 FROM a2a_messages WHERE kind = 'guidance'`);
    expect(guidance.rowCount).toBe(0);
    await w.advance({ minutes: 11 });
    expect(w.transport.sent.some((m) => m.text === question)).toBe(false); // still no chat: nothing sent

    await w.strangerSays(w.sam, NEW, `/start ${code}`);
    await w.advance({ minutes: 11 });
    expect(w.textsTo(NEW)).toEqual([OWNER_TEXT.paired, question]);
    expect(w.textsTo(w.sam.address).filter((t) => t === question)).toEqual([]);
  });
});
