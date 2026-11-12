/** I19 E4: usability bounds — what the owner has to type, and that it always ends. */
import { afterEach, describe, expect, it } from 'vitest';
import { RESOLVER_TEXT, WEAK_ACKS } from '../../../src/approvals/resolver.js';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { brainCalls, scriptBrain, toolUse } from '../brain/script.js';
import { at, local, NY } from '../flags/helpers.js';
import { ask, count, DINNER, i19Violations, LUNCH, statusOf } from './helpers.js';

const pending = async (w: TestWorld) => w.app.approvals!.listPending(w.alex.agent.id);
const ownerMessages = async (w: TestWorld) =>
  (await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE agent_id = $1 AND direction = 'in'`, [w.alex.agent.id])).rows[0]!.n;

describe('I19 usability bounds', () => {
  let w: TestWorld;
  afterEach(async () => {
    expect(await i19Violations(w)).toEqual([]);
    await w.close();
  });

  it('one booking = one typed yes: the prompt is the last word of the turn', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], 'I can book that.']);
    await w.ownerSays(w.alex, 'book dinner on friday');
    expect(w.textsTo(w.alex.address).slice(-2)).toEqual(['I can book that.', '#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.']);
    const before = await ownerMessages(w);
    await w.ownerSays(w.alex, 'yes');
    expect(await ownerMessages(w)).toBe(before + 1);
    expect(w.calendar.eventsOf(w.alex.owner.id).map((e) => e.title)).toEqual(['Dinner']);
  });

  it('two prompts from one request: yes → Which one → yes 2 resolves #2 and shows #1 again; the yes under it books #1', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [[toolUse('a', 'request_calendar_event', DINNER), toolUse('b', 'request_calendar_event', LUNCH)], 'Both asked.']);
    await w.ownerSays(w.alex, 'book dinner and lunch');
    const [one, two] = await pending(w);
    await w.ownerSays(w.alex, 'yes');
    expect(w.textsTo(w.alex.address).slice(-3)).toEqual([RESOLVER_TEXT.whichOne(0), one!.prompt, two!.prompt]);
    await w.ownerSays(w.alex, 'yes 2');
    expect([await statusOf(w, one!), await statusOf(w, two!)]).toEqual(['pending', 'executed']);
    // S1: #1 was the one other prompt in that run: shown again right below the confirmation.
    expect(await statusOf(w, one!)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${one!.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, one!)).toBe('executed');
  });

  it('a bare yes under "Which one?" asks again (never loops without a new owner message); the buttons answer at once', async () => {
    w = await createTestWorld();
    const [a, b] = [await ask(w, w.alex, DINNER), await ask(w, w.alex, LUNCH)];
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'yes');
    expect(await count(w, 'approval.ambiguous')).toBe(2);
    const sent = w.transport.sent.length;
    await w.advance({ minutes: 30 }); // sweeps and retries: nothing is re-sent on its own
    expect(w.transport.sent.length).toBe(sent);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${b.id}` });
    expect([await statusOf(w, a), await statusOf(w, b)]).toEqual(['executed', 'denied']);
  });

  it('after a digest: "yes 7" shows prompt #7 again, then "yes" answers it', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const a = await ask(w, w.alex, DINNER);
    await at(w, '2026-11-09T18:00');
    expect(w.transport.sent.at(-1)!.purpose).toBe('digest');
    await w.ownerSays(w.alex, `yes ${a.ref}`);
    expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${a.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('executed');
  });

  it('after a flag: a bare yes shows the only answerable prompt again, then yes answers it', async () => {
    w = await createTestWorld();
    const a = await ask(w, w.alex, DINNER);
    await w.app.gateway.sendToOwner(w.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${a.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('executed');
  });

  it("a conversational yes to the Brain's question reaches the Brain and approves nothing", async () => {
    w = await createTestWorld();
    const a = await ask(w, w.alex, DINNER);
    scriptBrain(w, w.alex, ['Shall I also look at Saturday?']);
    await w.ownerSays(w.alex, 'what else is free?');
    const calls = brainCalls(w, w.alex).length;
    await w.ownerSays(w.alex, 'yes');
    expect(brainCalls(w, w.alex)).toHaveLength(calls + 1);
    expect(await statusOf(w, a)).toBe('pending');
    expect(await count(w, 'approval.reprompted')).toBe(0);
  });

  it('weak acknowledgements never re-prompt (they reach the Brain)', async () => {
    w = await createTestWorld();
    const a = await ask(w, w.alex, DINNER);
    for (const word of [...WEAK_ACKS, 'OK!', '👍🏽']) {
      await w.app.gateway.sendToOwner(w.alex.agent.id, 'Booked: Lunch.', { purpose: 'reply' });
      await w.ownerSays(w.alex, word);
    }
    expect(await count(w, 'approval.reprompted')).toBe(0);
    expect(await statusOf(w, a)).toBe('pending');
    expect(brainCalls(w, w.alex)).toHaveLength(WEAK_ACKS.length + 2);
  });

  /** k pending approvals, then a digest, a forged Brain reply and a stranger's gap after the prompts. */
  async function messy(k: number) {
    w = await createTestWorld();
    const made = [];
    for (let i = 0; i < k; i++) made.push(await ask(w, w.alex, { ...DINNER, title: `Event ${i}`, start: `2026-11-1${3 + (i % 3)}T1${i}:00:00-05:00`, end: `2026-11-1${3 + (i % 3)}T1${i}:30:00-05:00` }));
    await w.app.gateway.sendToOwner(w.alex.agent.id, 'Today:\n- #1 Event 0', { purpose: 'digest' });
    scriptBrain(w, w.alex, ['#1 Event 0. Reply yes or no.']);
    await w.ownerSays(w.alex, 'hm');
    w.transport.skip(w.alex.agentAddress, w.alex.address);
    return made;
  }

  for (const k of [1, 2, 3, 4]) {
    it(`from a messy state with ${k} pending, typed answers alone finish them all in at most ${2 * k} messages`, async () => {
      const made = await messy(k);
      let typed = 0;
      for (const a of made) {
        await w.ownerSays(w.alex, `yes ${a.ref}`);
        typed += 1;
        if ((await statusOf(w, a)) === 'pending') {
          await w.ownerSays(w.alex, 'yes');
          typed += 1;
        }
        expect(await statusOf(w, a)).toBe('executed');
      }
      expect(typed).toBeLessThanOrEqual(2 * k);
      expect(await pending(w)).toEqual([]);
    });
  }

  it('from the same messy state, the buttons finish every pending approval with one tap each', async () => {
    const made = await messy(4);
    for (const a of made) {
      await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${a.id}` });
      expect(await statusOf(w, a)).toBe('denied');
    }
    expect(await pending(w)).toEqual([]);
  });
});
