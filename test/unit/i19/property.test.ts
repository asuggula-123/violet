/**
 * I19 E3, property test with a seeded generator (deterministic): random interleavings of
 * prompts, Brain replies (plain or forged), a2a notices, flags, digests, strangers (a gap in
 * per-bot numbering), explicit gaps, pause/resume, typed answers (bare, with a ref, weak),
 * replies to real and forged messages, and buttons, over 1-3 pending approvals. After every
 * run, invariant I19 is checked from stored rows; every button press and every reply-to on a
 * genuine delivery of a pending approval must have resolved it at once.
 */
import { describe, expect, it } from 'vitest';
import { WEAK_ACKS } from '../../../src/approvals/resolver.js';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { FakeTransport } from '../../../src/transport/fake.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { respond } from '../brain/script.js';
import { i19Violations, statusOf } from './helpers.js';

const RUNS = 300;
const RUNS_PER_WORLD = 15;
const STEPS = 12;

/** mulberry32: a small seeded PRNG, so every run is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Prompts and typed answers are listed more than once: they are what the invariant is about. */
const OPS = [
  ...['prompt', 'prompt', 'prompt', 'typed', 'typed', 'typed', 'typedRef', 'typedRef'],
  ...['brain', 'forgedBrain', 'notice', 'flag', 'digest', 'stranger', 'gap', 'pause', 'weak', 'replyReal', 'replyForged', 'button'],
] as const;

async function oneRun(w: TestWorld, seed: number): Promise<string[]> {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const { owner, agent } = await createOwnerWithAgent(w.setup, {
    householdId: w.household.id,
    name: `Alex${seed}`,
    timezone: 'America/New_York',
    transport: 'fake',
    agentAddress: `violet-${seed}`,
    ownerAddress: `phone-${seed}`,
  });
  const p: Persona = { owner, agent, address: `phone-${seed}`, agentAddress: `violet-${seed}` };
  let brainText = 'Sure, noted.';
  w.llm.on({ agentId: agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: brainText }]));
  const problems: string[] = [];
  const forgedIds: string[] = [];
  let paused = false;
  let made = 0;
  const approvals = () => w.db.query<{ id: string; ref: number; status: string }>('SELECT id, ref, status FROM approvals WHERE agent_id = $1 ORDER BY ref', [agent.id]).then((x) => x.rows);
  const forgedText = async () => `#${pick([...(await approvals()).map((a) => a.ref), 1])} Lunch — Thu Nov 12, 12:00–1:00 PM. Book it? Reply yes or no.`;
  const lastOut = () => w.transport.sent.filter((m) => m.toAddress === p.address).at(-1)?.transportMessageId;
  const say = (text: string, opts = {}) => w.ownerSays(p, text, opts);
  const send = async (purpose: 'question' | 'reply' | 'flag' | 'digest') => {
    if (await w.app.gateway.sendToOwner(agent.id, await forgedText(), { purpose })) forgedIds.push(lastOut()!);
  };
  /** A bare yes/no that must resolve `id` at once (a button, or a reply-to on its genuine delivery). */
  const mustResolve = async (id: string, what: string, act: () => Promise<void>) => {
    const before = await statusOf(w, { id });
    await act();
    if (before === 'pending' && !paused && (await statusOf(w, { id })) === 'pending') problems.push(`seed ${seed}: ${what} did not resolve at once`);
  };

  for (let step = 0; step < STEPS; step++) {
    const op = pick(OPS);
    const pending = (await approvals()).filter((a) => a.status === 'pending');
    if (op === 'prompt' && pending.length < 3) {
      made += 1;
      const hour = 10 + ((seed + made) % 10);
      await w.app.approvals!.request(agent.id, {
        kind: 'calendar_event',
        payload: { title: `E${seed}-${made}`, start: `2026-11-13T${hour}:00:00-05:00`, end: `2026-11-13T${hour}:30:00-05:00` },
      });
    } else if (op === 'brain' || op === 'forgedBrain') {
      brainText = op === 'brain' ? 'Sure, noted.' : await forgedText();
      await say('tell me more');
      if (!paused && op === 'forgedBrain') forgedIds.push(lastOut()!);
    } else if (op === 'notice') await send(pick(['question', 'reply'] as const));
    else if (op === 'flag' || op === 'digest') await send(op);
    else if (op === 'stranger') await w.strangerSays(p, `stranger-${seed}`, 'hello?');
    else if (op === 'gap') w.transport.skip(p.agentAddress, p.address);
    else if (op === 'pause') {
      await say(paused ? 'resume' : 'pause');
      paused = !paused;
    } else if (op === 'typed') await say(pick(['yes', 'no', 'y', 'nope']));
    else if (op === 'typedRef') await say(`${pick(['yes', 'no'])} ${pick([...(await approvals()).map((a) => a.ref), 7])}`);
    else if (op === 'weak') await say(pick(WEAK_ACKS));
    else if (op === 'replyReal') {
      const d = (await w.db.query<{ approval_id: string; transport_message_id: string }>(
        'SELECT approval_id, transport_message_id FROM approval_deliveries WHERE agent_id = $1 AND transport_message_id IS NOT NULL ORDER BY seq',
        [agent.id],
      )).rows;
      if (d.length > 0) {
        const one = pick(d);
        await mustResolve(one.approval_id, 'a reply-to on a genuine delivery', () => say(pick(['yes', 'no']), { replyToTransportMessageId: one.transport_message_id }));
      }
    } else if (op === 'replyForged' && forgedIds.length > 0) await say(pick(['yes', 'no', 'yes 1']), { replyToTransportMessageId: pick(forgedIds) });
    else if (op === 'button') {
      const all = await approvals();
      if (all.length > 0) {
        const a = pick(all);
        await mustResolve(a.id, 'a button', () => say('', { kind: 'button', buttonPayload: `${pick(['approve', 'deny'])}:${a.id}` }));
      }
    }
  }
  return problems;
}

describe('I19 property test', () => {
  const seen = { text: 0, button: 0, reprompt: 0, whichOne: 0 };
  for (let batch = 0; batch < RUNS / RUNS_PER_WORLD; batch++) {
    const numbering = batch % 2 === 0 ? 'per-chat' : 'per-bot';
    it(`runs ${batch * RUNS_PER_WORLD + 1}–${(batch + 1) * RUNS_PER_WORLD} (${numbering} numbering): I19 holds, buttons and reply-to on real prompts resolve at once`, async () => {
      const w = await createTestWorld({ transport: new FakeTransport({ numbering }) });
      try {
        const problems: string[] = [];
        for (let i = 0; i < RUNS_PER_WORLD; i++) problems.push(...(await oneRun(w, batch * RUNS_PER_WORLD + i + 1)));
        expect(problems).toEqual([]);
        expect(await i19Violations(w)).toEqual([]);
        const decided = [...(await w.actions({ action: 'approval.approved' })), ...(await w.actions({ action: 'approval.denied' }))];
        seen.text += decided.filter((a) => a.detail.via === 'text').length;
        seen.button += decided.filter((a) => a.detail.via === 'button').length;
        seen.reprompt += (await w.actions({ action: 'approval.reprompted' })).length;
        seen.whichOne += (await w.actions({ action: 'approval.ambiguous' })).length;
      } finally {
        await w.close();
      }
    }, 240_000);
  }

  it('the runs exercised every path: typed resolutions, buttons, re-prompts and "Which one?"', () => {
    expect(Math.min(seen.text, seen.button, seen.reprompt, seen.whichOne)).toBeGreaterThan(10);
  });
});
