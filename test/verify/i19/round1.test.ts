/**
 * I19 verify round 1 (independent verifier): adversarial tests for "a typed yes or no counts
 * only directly under the real prompt" and "the prompt is the last word of a Brain turn".
 *
 * The whole file runs with every appearance neutralizer (neutralizeReply, quoteFolded,
 * foldReservedLineHeads) mocked to the identity: forged texts reach the owner character for
 * character, so nothing here can pass because a text was folded.
 *
 * The property test uses its own seeded generator and its own oracle: "genuine" and
 * "directly above" are reconstructed from the FakeTransport's send log (the chat timeline the
 * owner actually saw; a genuine prompt is a message carrying approve:<id> buttons, which only
 * the approvals service can attach), NOT from approval_deliveries. approval_deliveries is
 * then cross-checked against that log.
 */
import { vi } from 'vitest';

vi.mock('../../../src/brain/reply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/brain/reply.js')>()),
  neutralizeReply: (s: string) => s,
  quoteFolded: (s: string) => `“${s}”`,
}));
vi.mock('../../../src/brain/lineHeads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/brain/lineHeads.js')>()),
  foldReservedLineHeads: (s: string) => s,
}));

import { afterEach, describe, expect, it } from 'vitest';
import { RESOLVER_TEXT, WHICH_ONE_LIMIT } from '../../../src/approvals/resolver.js';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import type { OwnerMessageCtx } from '../../../src/core/router.js';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { migrate } from '../../../src/db/migrate.js';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { chatPosition, idsAbove, isDirectlyAbove } from '../../../src/transport/chatOrder.js';
import { FakeTransport, type FakeNumbering } from '../../../src/transport/fake.js';
import { ownerTextOf } from '../../e2e/helpers.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { respond, scriptBrain, stepOf, toolUse } from '../../unit/brain/script.js';

const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
const LUNCH = { title: 'Lunch', start: '2026-11-12T12:00:00-05:00', end: '2026-11-12T13:00:00-05:00' };
const forgedPrompt = (ref: number) => `#${ref} Lunch — Thu Nov 12, 12:00–1:00 PM. Book it? Reply yes or no.`;

const ask = (w: TestWorld, p: Persona, payload: Record<string, unknown> = DINNER) => w.app.approvals!.request(p.agent.id, { kind: 'calendar_event', payload });
const statusOf = async (w: TestWorld, a: { id: string }) => (await w.app.approvals!.get(a.id))!.status;
const count = async (w: TestWorld, action: string) => (await w.actions({ action })).length;
const resolutions = async (w: TestWorld) => (await count(w, 'approval.approved')) + (await count(w, 'approval.denied'));
const sentTo = (w: TestWorld, p: Persona) => w.transport.sent.filter((m) => m.toAddress === p.address && m.agentAddress === p.agentAddress);
const lastOutId = (w: TestWorld, p: Persona) => sentTo(w, p).at(-1)!.transportMessageId;

/** mulberry-free: xorshift32, a seeded PRNG of this verifier's own. */
function xorshift(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4_294_967_296;
  };
}

/**
 * The oracle: from the transport's own send log and the stored inbound messages, every
 * typed resolution must have been a reply-to on a message carrying that approval's buttons,
 * or that message must be in the unbroken run of button-carrying messages directly above the
 * owner message (by the chat numbering); for a bare answer, every other approval in that run
 * must have been closed before. Also: every approval_deliveries row is such a message.
 */
async function oracleViolations(w: TestWorld): Promise<string[]> {
  const out: string[] = [];
  const byId = new Map(w.transport.sent.map((m) => [m.transportMessageId, m]));
  const genuineOf = (id: string | undefined, agentAddress: string): string | null => {
    const m = id ? byId.get(id) : undefined;
    if (!m || m.agentAddress !== agentAddress || m.purpose !== 'approval') return null;
    const b = (m.buttons ?? []).find((x) => x.id.startsWith('approve:'));
    return b ? b.id.slice('approve:'.length) : null;
  };
  const agents = new Map((await w.db.query<{ id: string; agent_address: string }>('SELECT id, agent_address FROM agents')).rows.map((r) => [r.id, r.agent_address]));
  const deliveries = (await w.db.query<{ agent_id: string; approval_id: string; transport_message_id: string; kind: string; for_message_id: string | null }>(
    'SELECT agent_id, approval_id, transport_message_id, kind, for_message_id FROM approval_deliveries WHERE transport_message_id IS NOT NULL',
  )).rows;
  for (const d of deliveries) {
    if (genuineOf(d.transport_message_id, agents.get(d.agent_id)!) !== d.approval_id) out.push(`delivery row ${d.transport_message_id} is not a button-carrying prompt of ${d.approval_id}`);
  }
  // Re-sends are caused only by an owner text message of the same agent, at most WHICH_ONE_LIMIT per message.
  const perMessage = new Map<string, number>();
  for (const d of (await w.db.query<{ agent_id: string; for_message_id: string | null; kind: string }>('SELECT agent_id, for_message_id, kind FROM approval_deliveries')).rows) {
    if (d.kind === 'prompt') continue;
    const m = (await w.db.query<{ agent_id: string; direction: string; thread: string }>('SELECT agent_id, direction, thread FROM messages WHERE id = $1', [d.for_message_id])).rows[0];
    if (!m || m.agent_id !== d.agent_id || m.direction !== 'in' || m.thread !== 'owner') out.push(`re-send for ${d.for_message_id} not caused by an owner message`);
    perMessage.set(d.for_message_id!, (perMessage.get(d.for_message_id!) ?? 0) + 1);
  }
  for (const [m, n] of perMessage) if (n > WHICH_ONE_LIMIT) out.push(`${n} re-sends for one message ${m}`);

  const all = await w.actions();
  const closing = new Set(['approval.approved', 'approval.denied', 'approval.cancelled', 'approval.expired']);
  for (const row of all) {
    if ((row.action !== 'approval.approved' && row.action !== 'approval.denied') || row.detail.via !== 'text') continue;
    const target = String(row.detail.approvalId);
    const m = (await w.db.query<{ body: string; reply_to_transport_message_id: string | null; meta: Record<string, unknown>; agent_id: string }>(
      'SELECT body, reply_to_transport_message_id, meta, agent_id FROM messages WHERE id = $1',
      [row.detail.messageId],
    )).rows[0];
    if (!m) {
      out.push(`${row.id}: resolution without a stored message`);
      continue;
    }
    const agentAddress = agents.get(m.agent_id)!;
    if (m.reply_to_transport_message_id) {
      if (genuineOf(m.reply_to_transport_message_id, agentAddress) !== target) out.push(`${row.id}: "${m.body}" replied to ${m.reply_to_transport_message_id}, not a prompt of ${target}`);
      continue;
    }
    const run: string[] = [];
    for (const id of idsAbove(m.meta.chatMessageId as string | undefined, 60)) {
      const g = genuineOf(id, agentAddress);
      if (!g) break;
      run.push(g);
    }
    if (!run.includes(target)) {
      out.push(`${row.id}: "${m.body}" (${String(m.meta.chatMessageId)}) resolved ${target} with no prompt of it directly above`);
      continue;
    }
    if (/\d/.test(m.body)) continue;
    for (const other of new Set(run.filter((a) => a !== target))) {
      if (!all.some((r) => r.id < row.id && closing.has(r.action) && r.detail.approvalId === other)) out.push(`${row.id}: bare "${m.body}" resolved ${target} while ${other} was also pending right above`);
    }
  }
  return out;
}

/** Re-runs the owner interceptors for the persona's latest owner message (a duplicate job run / hook retry). */
async function rerunLast(w: TestWorld, p: Persona): Promise<void> {
  const row = (await w.db.query<{ id: string; body: string; reply_to_transport_message_id: string | null; transport_message_id: string; meta: Record<string, unknown> }>(
    `SELECT id, body, reply_to_transport_message_id, transport_message_id, meta FROM messages WHERE agent_id = $1 AND direction = 'in' AND thread = 'owner' ORDER BY seq DESC LIMIT 1`,
    [p.agent.id],
  )).rows[0];
  if (!row) return;
  const agent = (await w.app.repos.agents.get(p.agent.id))!;
  if (agent.paused) return;
  const meta = row.meta;
  const ctx: OwnerMessageCtx = {
    agent,
    owner: p.owner,
    messageId: row.id,
    msg: {
      transport: 'fake',
      agentAddress: p.agentAddress,
      fromAddress: p.address,
      kind: (meta.kind as 'text' | 'button') ?? 'text',
      text: row.body,
      transportMessageId: row.transport_message_id,
      ...(row.reply_to_transport_message_id ? { replyToTransportMessageId: row.reply_to_transport_message_id } : {}),
      ...(meta.chatMessageId ? { chatMessageId: String(meta.chatMessageId) } : {}),
      ...(meta.buttonPayload ? { buttonPayload: String(meta.buttonPayload) } : {}),
      receivedAt: w.clock.now(),
    },
  };
  for (const intercept of w.app.router.hooks.ownerInterceptors) if (await intercept(ctx)) break;
  await w.app.settle();
}

interface Actor {
  p: Persona;
  paused: boolean;
  forged: string[];
  reply: string;
  books: Map<string, Record<string, unknown>>;
}

async function makeActor(w: TestWorld, tag: string): Promise<Actor> {
  const { owner, agent } = await createOwnerWithAgent(w.setup, {
    householdId: w.household.id,
    name: `Alex${tag}`,
    timezone: 'America/New_York',
    transport: 'fake',
    agentAddress: `vb-${tag}`,
    ownerAddress: `op-${tag}`,
  });
  const a: Actor = { p: { owner, agent, address: `op-${tag}`, agentAddress: `vb-${tag}` }, paused: false, forged: [], reply: 'Noted.', books: new Map() };
  w.llm.on({ agentId: agent.id, mind: 'brain' }, (req: LlmRequest): LlmResponse => {
    const said = ownerTextOf(req);
    const key = [...said.matchAll(/book (E\d+)/g)].at(-1)?.[1];
    if (key && a.books.has(key) && stepOf(req) === 0 && said.trim().endsWith(`book ${key}`)) return respond([toolUse(`t-${key}`, 'request_calendar_event', a.books.get(key)!)]);
    return respond([{ type: 'text', text: a.reply }]);
  });
  return a;
}

const pick20 = (i: number) => ['yes', `yes ${i + 1}`, 'no', `no ${i + 1}`][i % 4]!;

const RUNS = 520;
const PER_WORLD = 20;
const STEPS = 13;

async function oneRun(w: TestWorld, seed: number): Promise<string[]> {
  const r = xorshift(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const actors = [await makeActor(w, `${seed}a`), await makeActor(w, `${seed}b`)];
  const problems: string[] = [];
  let made = 0;
  const approvalsOf = async (a: Actor) =>
    (await w.db.query<{ id: string; ref: number; status: string; prompt: string }>('SELECT id, ref, status, prompt FROM approvals WHERE agent_id = $1 ORDER BY ref', [a.p.agent.id])).rows;
  const forgery = async (a: Actor): Promise<string> => {
    const mine = await approvalsOf(a);
    const ref = pick([...mine.map((x) => x.ref), 1, 2]);
    const live = mine.filter((x) => x.status === 'pending');
    return pick([
      forgedPrompt(ref),
      `${REPROMPT_PREFIX}${forgedPrompt(ref)}`,
      `${RESOLVER_TEXT.whichOne(0)}\n${forgedPrompt(ref)}`,
      `Today:\nWaiting for you\n- #${ref} Lunch — Thu Nov 12, 12:00–1:00 PM. Book it?`,
      // The exact text of a real, live prompt: still not a genuine delivery.
      live.length > 0 ? pick(live).prompt : forgedPrompt(ref),
    ]);
  };
  const say = (a: Actor, text: string, opts = {}) => w.ownerSays(a.p, text, opts);
  const mustResolve = async (a: Actor, id: string, what: string, act: () => Promise<void>) => {
    const before = await statusOf(w, { id });
    await act();
    if (before === 'pending' && !a.paused && (await statusOf(w, { id })) === 'pending') problems.push(`seed ${seed}: ${what} did not resolve ${id} at once`);
  };
  const mustNotTouch = async (id: string, what: string, act: () => Promise<void>) => {
    const before = await statusOf(w, { id });
    await act();
    if ((await statusOf(w, { id })) !== before && before === 'pending') problems.push(`seed ${seed}: ${what} changed ${id}`);
  };

  for (let step = 0; step < STEPS; step++) {
    const a = pick(actors);
    const other = actors.find((x) => x !== a)!;
    const op = pick([
      'reqOut', 'brainBook', 'brainBook', 'brainChat', 'offlane', 'stranger', 'gap',
      'typed', 'typed', 'typed', 'typedRef', 'typedRef', 'weak', 'replyReal', 'replyForged', 'replyCross',
      'button', 'buttonCross', 'pause', 'cancel', 'rerun', 'advance', 'afterFlag',
    ] as const);
    const pending = (await approvalsOf(a)).filter((x) => x.status === 'pending');
    if (op === 'reqOut' && pending.length < 3) {
      made += 1;
      await ask(w, a.p, { title: `O${seed}-${made}`, start: `2026-11-1${3 + (made % 5)}T1${made % 10}:00:00-05:00`, end: `2026-11-1${3 + (made % 5)}T1${made % 10}:30:00-05:00` });
    } else if (op === 'brainBook' && pending.length < 3) {
      made += 1;
      const key = `E${made}`;
      a.books.set(key, { title: `B${seed}-${made}`, start: `2026-11-1${3 + (made % 5)}T0${made % 10}:00:00-05:00`, end: `2026-11-1${3 + (made % 5)}T0${made % 10}:45:00-05:00` });
      a.reply = r() < 0.6 ? await forgery(a) : 'I can book that.';
      await say(a, `book ${key}`);
      if (!a.paused) a.forged.push(...sentTo(w, a.p).filter((m) => m.purpose === 'reply').slice(-1).map((m) => m.transportMessageId));
    } else if (op === 'brainChat') {
      a.reply = r() < 0.7 ? await forgery(a) : 'Sure, noted.';
      await say(a, 'tell me more');
      if (!a.paused) a.forged.push(lastOutId(w, a.p));
    } else if (op === 'offlane') {
      const sent = await w.app.gateway.sendToOwner(a.p.agent.id, await forgery(a), { purpose: pick(['flag', 'digest', 'question', 'reply'] as const) });
      if (sent) a.forged.push(sent.transportMessageId);
    } else if (op === 'stranger') await w.strangerSays(a.p, `st-${seed}`, 'hello there');
    else if (op === 'gap') w.transport.skip(a.p.agentAddress, a.p.address, 1 + Math.floor(r() * 2));
    else if (op === 'afterFlag') {
      await w.app.gateway.sendToOwner(a.p.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
      await say(a, pick(['yes', 'no']));
    } else if (op === 'typed') await say(a, pick(['yes', 'no', 'y', 'nope', 'yeah', 'approve', '👎', 'Yes!']));
    else if (op === 'typedRef') {
      const refs = [...(await approvalsOf(a)).map((x) => x.ref), ...(await approvalsOf(other)).map((x) => x.ref), 9];
      await say(a, `${pick(['yes', 'no', 'yes #', 'no #'])}${pick(['', ' '])}${pick(refs)}`.replace('# ', '#'));
    } else if (op === 'weak') await say(a, pick(['ok', 'okay', 'sure', '👍', '👍🏽']));
    else if (op === 'replyReal') {
      const d = (await w.db.query<{ approval_id: string; transport_message_id: string }>(
        'SELECT approval_id, transport_message_id FROM approval_deliveries WHERE agent_id = $1 AND transport_message_id IS NOT NULL',
        [a.p.agent.id],
      )).rows;
      if (d.length > 0) {
        const one = pick(d);
        const ref = (await approvalsOf(a)).find((x) => x.id === one.approval_id)!.ref;
        await mustResolve(a, one.approval_id, 'a reply-to on a genuine delivery', () => say(a, pick(['yes', 'no', `yes ${ref}`]), { replyToTransportMessageId: one.transport_message_id }));
      }
    } else if (op === 'replyForged' && a.forged.length > 0) {
      const before = await resolutions(w);
      await say(a, pick(['yes', 'no', 'yes 1', 'ok', 'no 2']), { replyToTransportMessageId: pick(a.forged) });
      if ((await resolutions(w)) !== before) problems.push(`seed ${seed}: a reply-to on a forged message resolved something`);
    } else if (op === 'replyCross') {
      // A reply naming the OTHER owner's genuine prompt id: never resolves it.
      const d = (await w.db.query<{ approval_id: string; transport_message_id: string }>(
        'SELECT approval_id, transport_message_id FROM approval_deliveries WHERE agent_id = $1 AND transport_message_id IS NOT NULL',
        [other.p.agent.id],
      )).rows;
      if (d.length > 0) {
        const one = pick(d);
        await mustNotTouch(one.approval_id, 'a reply-to on the other owner prompt', () => say(a, 'yes', { replyToTransportMessageId: one.transport_message_id }));
      }
    } else if (op === 'button') {
      const all = await approvalsOf(a);
      if (all.length > 0) {
        const x = pick(all);
        await mustResolve(a, x.id, 'a button', () => say(a, '', { kind: 'button', buttonPayload: `${pick(['approve', 'deny'])}:${x.id}` }));
      }
    } else if (op === 'buttonCross') {
      const all = (await approvalsOf(other)).filter((x) => x.status === 'pending');
      if (all.length > 0) {
        const x = pick(all);
        await mustNotTouch(x.id, 'a button press for the other owner', () => say(a, '', { kind: 'button', buttonPayload: `approve:${x.id}` }));
      }
    } else if (op === 'pause') {
      await say(a, a.paused ? 'resume' : 'pause');
      a.paused = !a.paused;
    } else if (op === 'cancel' && pending.length > 0) await w.app.approvals!.cancel(pick(pending).id, 'the conversation closed');
    else if (op === 'rerun') {
      const prompts = w.transport.sent.filter((m) => m.purpose === 'approval').length;
      const before = await resolutions(w);
      await rerunLast(w, a.p);
      if (w.transport.sent.filter((m) => m.purpose === 'approval').length !== prompts) problems.push(`seed ${seed}: a re-run of the same message sent a prompt again`);
      if ((await resolutions(w)) !== before) problems.push(`seed ${seed}: a re-run of the same message resolved something new`);
    } else if (op === 'advance') await w.advance({ minutes: 1 + Math.floor(r() * 3) });
  }

  // Liveness: with nobody interfering, typed answers alone finish every pending approval, two messages each at most.
  for (const a of actors) {
    if (a.paused) {
      await say(a, 'resume');
      a.paused = false;
    }
    for (const x of (await approvalsOf(a)).filter((y) => y.status === 'pending')) {
      await say(a, `no ${x.ref}`);
      if ((await statusOf(w, x)) === 'pending') await say(a, 'no');
      if ((await statusOf(w, x)) === 'pending') problems.push(`seed ${seed}: typed "no ${x.ref}" then "no" did not finish #${x.ref}`);
    }
  }
  return problems;
}

describe('I19 verify round 1', () => {
  let w: TestWorld;
  afterEach(async () => {
    if (w) {
      expect(await oracleViolations(w)).toEqual([]);
      await w.close();
    }
  });

  describe('own seeded interleavings, own oracle (transport log), 520 runs', () => {
    const tally = { text: 0, button: 0, reprompt: 0, whichOne: 0 };
    for (let batch = 0; batch < Math.ceil(RUNS / PER_WORLD); batch++) {
      const numbering: FakeNumbering = batch % 3 === 2 ? 'per-bot' : 'per-chat';
      it(`runs ${batch * PER_WORLD + 1}-${(batch + 1) * PER_WORLD} (${numbering})`, async () => {
        w = await createTestWorld({ transport: new FakeTransport({ numbering }) });
        const problems: string[] = [];
        for (let i = 0; i < PER_WORLD; i++) problems.push(...(await oneRun(w, 7919 * (batch * PER_WORLD + i + 1))));
        expect(problems).toEqual([]);
        const decided = [...(await w.actions({ action: 'approval.approved' })), ...(await w.actions({ action: 'approval.denied' }))];
        tally.text += decided.filter((d) => d.detail.via === 'text').length;
        tally.button += decided.filter((d) => d.detail.via === 'button').length;
        tally.reprompt += await count(w, 'approval.reprompted');
        tally.whichOne += await count(w, 'approval.ambiguous');
      }, 600_000);
    }
    it('the runs exercised typed resolutions, buttons, re-prompts and Which one', () => {
      w = undefined as never;
      console.log('I19 verify tally', JSON.stringify(tally));
      expect(Math.min(tally.text, tally.button, tally.reprompt, tally.whichOne)).toBeGreaterThan(20);
    });
  });

  describe('chat numbering: malformed, collisions, large ids', () => {
    it('fails closed on every malformed or foreign id, and handles ids beyond 2^53 exactly', () => {
      w = undefined as never;
      expect(isDirectlyAbove('c:5', 'c:6')).toBe(true);
      expect(isDirectlyAbove('-1001:5', '-1001:6')).toBe(true);
      expect(isDirectlyAbove('a:b:5', 'a:b:6')).toBe(true);
      for (const [out, m] of [
        ['c:05', 'c:6'], ['c:5', 'c:06'], ['c:5', 'c:7'], ['c:6', 'c:6'], ['c:6', 'c:5'], ['c:5', 'd:6'], ['c:5', 'c :6'],
        ['c:+5', 'c:6'], ['c:5 ', 'c:6'], ['c:5', 'c:6 '], ['c:5.0', 'c:6'], ['c:-1', 'c:0'], ['5', '6'], ['', 'c:1'], ['c:5', undefined],
        ['c:٥', 'c:٦'], ['c:5', 'C:6'], ['c:1e1', 'c:11'],
      ] as Array<[string, string | undefined]>) {
        expect(isDirectlyAbove(out, m), `${out} above ${String(m)}`).toBe(false);
      }
      // 2^53 + 1 is not representable as a double: Number would say these are adjacent.
      expect(isDirectlyAbove('c:9007199254740993', 'c:9007199254740994')).toBe(true);
      expect(isDirectlyAbove('c:9007199254740992', 'c:9007199254740994')).toBe(false);
      expect(isDirectlyAbove('c:99999999999999999999', 'c:100000000000000000000')).toBe(false); // over the cap: unknown
      expect(idsAbove('c:1', 5)).toEqual(['c:0']);
      expect(idsAbove('c:007', 5)).toEqual([]);
      expect(chatPosition('c:0')).toEqual({ chat: 'c', n: 0n });
    });

    it("a message numbered in ANOTHER owner's chat right under that owner's prompt resolves nothing", async () => {
      w = await createTestWorld();
      const sams = await ask(w, w.sam);
      const alexs = await ask(w, w.alex);
      const samPrompt = chatPosition(sams.prompt_transport_message_id)!;
      await w.ownerSays(w.alex, 'yes', { chatMessageId: `${samPrompt.chat}:${samPrompt.n + 1n}` });
      expect([await statusOf(w, sams), await statusOf(w, alexs)]).toEqual(['pending', 'pending']);
      // Alex's own prompt was the last in his chat; this message claimed another place, so it re-prompts (fail closed).
      expect(await resolutions(w)).toBe(0);
    });

    it('a chat number with a leading zero or an unknown shape never counts as under the prompt', async () => {
      w = await createTestWorld();
      const a = await ask(w, w.alex);
      const p = chatPosition(a.prompt_transport_message_id)!;
      for (const id of [`${p.chat}:0${p.n + 1n}`, `${p.chat}:${p.n + 1n}.0`, `${p.n + 1n}`, `${p.chat}:${p.n}`]) {
        await w.ownerSays(w.alex, 'yes', { chatMessageId: id });
        expect(await statusOf(w, a), id).toBe('pending');
      }
      expect(await count(w, 'approval.reprompted')).toBe(4);
    });
  });

  describe('races and retries', () => {
    it('a closing that lands between the owner typing "yes" under two prompts and the resolver running does not turn the ambiguous yes into a yes for the other one', async () => {
      w = await createTestWorld();
      scriptBrain(w, w.alex, [[toolUse('a', 'request_calendar_event', DINNER), toolUse('b', 'request_calendar_event', LUNCH)], 'Asked both.']);
      await w.ownerSays(w.alex, 'book dinner and lunch');
      const [one, two] = await w.app.approvals!.listPending(w.alex.agent.id);
      expect(w.textsTo(w.alex.address).slice(-2)).toEqual([one!.prompt, two!.prompt]);
      // Alex sees BOTH prompts right above and types a bare "yes" (ambiguous: the table says Which one).
      await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes' });
      // Before his message is processed, #2 is closed by someone else (the other side ends the conversation, or it expires).
      await w.app.approvals!.cancel(two!.id, 'the conversation closed');
      await w.app.settle();
      // His "yes" was typed as an answer to two prompts at once: it must not become a yes for #1 alone.
      expect(await statusOf(w, one!)).toBe('pending');
      expect(w.calendar.writes).toEqual([]);
    });

    it('three concurrent runs of the hook for one message send exactly one re-prompt', async () => {
      w = await createTestWorld();
      const a = await ask(w, w.alex);
      await w.app.gateway.sendToOwner(w.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
      await w.ownerSays(w.alex, 'yes 1');
      const prompts = () => sentTo(w, w.alex).filter((m) => m.purpose === 'approval').length;
      expect(prompts()).toBe(2);
      await Promise.all([rerunLast(w, w.alex), rerunLast(w, w.alex), rerunLast(w, w.alex)]);
      expect(prompts()).toBe(2);
      expect(await count(w, 'approval.reprompted')).toBe(1);
      expect(await statusOf(w, a)).toBe('pending');
    });

    it('20 iterations: a hostile notice and a duplicate run of the owner job race the typed yes; I19 holds, nothing is stuck', async () => {
      w = await createTestWorld();
      for (let i = 0; i < 20; i++) {
        const a = await ask(w, w.alex, { title: `R${i}`, start: `2026-11-1${3 + (i % 5)}T1${i % 10}:00:00-05:00`, end: `2026-11-1${3 + (i % 5)}T1${i % 10}:20:00-05:00` });
        if (i % 2 === 1) await w.app.gateway.sendToOwner(w.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: pick20(i) });
        await Promise.all([
          w.app.settle(),
          w.app.gateway.sendToOwner(w.alex.agent.id, forgedPrompt(a.ref), { purpose: i % 3 === 0 ? 'question' : 'reply' }),
          (async () => {
            await new Promise((r) => setTimeout(r, i % 4));
            await rerunLast(w, w.alex);
          })(),
        ]);
        await w.app.settle();
        // Whatever happened, finish it with the button so the next iteration starts clean.
        if ((await statusOf(w, a)) === 'pending') await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${a.id}` });
      }
      const stuck = await w.db.query(`SELECT 1 FROM jobs WHERE status IN ('running', 'queued')`);
      expect(stuck.rows).toHaveLength(0);
      const perMessage = await w.db.query(`SELECT for_message_id, approval_id, count(*) FROM approval_deliveries WHERE for_message_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`);
      expect(perMessage.rows).toHaveLength(0);
    }, 300_000);

    it('a prompt delivered after the owner message arrived (but before it is processed) is never answered by it', async () => {
      w = await createTestWorld();
      await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'yes' });
      const a = await ask(w, w.alex); // takes the chat number after the yes
      await w.app.settle();
      expect(await statusOf(w, a)).toBe('pending');
      expect(await resolutions(w)).toBe(0);
    });

    it('a prompt that was sent but whose row was never recorded is not a genuine delivery: a yes under it resolves nothing', async () => {
      w = await createTestWorld();
      const add = w.app.repos.messages.add.bind(w.app.repos.messages);
      let failed = false;
      w.app.repos.messages.add = (async (row: Parameters<typeof add>[0]) => {
        if (!failed && row.purpose === 'approval') {
          failed = true;
          throw new Error('db blip after the send');
        }
        return add(row);
      }) as typeof add;
      const a = await ask(w, w.alex);
      expect(sentTo(w, w.alex).map((m) => m.purpose)).toEqual(['approval']); // on screen…
      expect((await w.db.query('SELECT 1 FROM approval_deliveries WHERE approval_id = $1 AND transport_message_id IS NOT NULL', [a.id])).rows).toHaveLength(0); // …not recorded
      await w.ownerSays(w.alex, 'yes');
      expect(await statusOf(w, a)).toBe('pending');
      expect(await count(w, 'approval.reprompted')).toBe(0); // never sent as far as Violet knows: the Brain gets the yes
      // The owner is not stuck: the sweep delivers the prompt again (recorded now), and the yes under it books.
      await w.advance({ minutes: 3 });
      expect(w.lastTo(w.alex.address)).toBe(a.prompt);
      await w.ownerSays(w.alex, 'yes');
      expect(await statusOf(w, a)).toBe('executed');
    });

    it('an approval that expired while its prompt is right above: the yes does not resolve it and does not re-prompt it', async () => {
      w = await createTestWorld();
      const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: DINNER, expiresAt: new Date(w.clock.now().getTime() + 60_000) });
      w.clock.advance({ minutes: 2 });
      await w.ownerSays(w.alex, 'yes');
      expect(await statusOf(w, a)).toBe('expired');
      expect(await count(w, 'approval.reprompted')).toBe(0);
      expect(w.calendar.writes).toEqual([]);
    });
  });

  describe('reply-to, refs and Which one', () => {
    it('reply-to on an OLD delivery still answers after a re-prompt; reply-to on the Which-one line answers nothing; a ref that conflicts with the replied prompt resolves nothing', async () => {
      w = await createTestWorld();
      const a = await ask(w, w.alex, DINNER);
      const firstId = a.prompt_transport_message_id!;
      const b = await ask(w, w.alex, LUNCH);
      await w.app.gateway.sendToOwner(w.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
      await w.ownerSays(w.alex, 'yes');
      const line = sentTo(w, w.alex).find((m) => m.text === RESOLVER_TEXT.whichOne(0))!;
      expect(line).toBeDefined();
      await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: line.transportMessageId });
      expect([await statusOf(w, a), await statusOf(w, b)]).toEqual(['pending', 'pending']);
      // Reply-to on #1's prompt naming #2: a conflict, nothing resolved.
      await w.ownerSays(w.alex, `yes ${b.ref}`, { replyToTransportMessageId: firstId });
      expect([await statusOf(w, a), await statusOf(w, b)]).toEqual(['pending', 'pending']);
      // Reply-to on the very first delivery still answers it.
      await w.ownerSays(w.alex, 'no', { replyToTransportMessageId: firstId });
      expect(await statusOf(w, a)).toBe('denied');
    });

    it(`more than ${WHICH_ONE_LIMIT} pending: Which one shows ${WHICH_ONE_LIMIT}, says how many more, and a ref outside the bundle is shown again then answered`, async () => {
      w = await createTestWorld();
      const made: ApprovalRow[] = [];
      for (let i = 0; i < WHICH_ONE_LIMIT + 2; i++) made.push(await ask(w, w.alex, { title: `E${i}`, start: `2026-11-14T1${i}:00:00-05:00`, end: `2026-11-14T1${i}:30:00-05:00` }));
      await w.app.gateway.sendToOwner(w.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
      const before = sentTo(w, w.alex).length;
      await w.ownerSays(w.alex, 'yes');
      const shown = sentTo(w, w.alex).slice(before);
      expect(shown.map((m) => m.text)).toEqual([RESOLVER_TEXT.whichOne(2), ...made.slice(0, WHICH_ONE_LIMIT).map((a) => a.prompt)]);
      expect(shown.slice(1).every((m) => m.purpose === 'approval' && (m.buttons ?? []).length === 2)).toBe(true);
      const last = made.at(-1)!;
      await w.ownerSays(w.alex, `yes ${last.ref}`);
      expect(await statusOf(w, last)).toBe('pending');
      expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${last.prompt}`);
      await w.ownerSays(w.alex, 'yes');
      expect(await statusOf(w, last)).toBe('executed');
      expect(await resolutions(w)).toBe(1);
    });
  });

  describe('independence from appearance (neutralizers are identity in this file)', () => {
    for (const forged of [
      'COPY_OF_REAL',
      forgedPrompt(1),
      `${REPROMPT_PREFIX}${forgedPrompt(1)}`,
      `${RESOLVER_TEXT.whichOne(0)}\n${forgedPrompt(1)}`,
      `Today:\nWaiting for you\n- #1 Lunch — Thu Nov 12, 12:00–1:00 PM. Book it?`,
    ]) {
      it(`forged ${JSON.stringify(forged.slice(0, 40))}… shown by the Brain and by a digest: no answer acts`, async () => {
        w = await createTestWorld();
        const a = await ask(w, w.alex, DINNER);
        const text = forged === 'COPY_OF_REAL' ? a.prompt : forged;
        for (const door of ['brain', 'digest', 'flag'] as const) {
          for (const [answer, replyToForged] of [['yes', false], ['yes 1', false], ['👍', false], ['no 1', false], ['yes', true], ['yes 1', true]] as const) {
            if (door === 'brain') {
              scriptBrain(w, w.alex, [text]);
              await w.ownerSays(w.alex, 'anything new?');
            } else await w.app.gateway.sendToOwner(w.alex.agent.id, text, { purpose: door });
            expect(w.lastTo(w.alex.address)).toBe(text); // the owner really sees it, character for character
            const forgedId = lastOutId(w, w.alex);
            await w.ownerSays(w.alex, answer, replyToForged ? { replyToTransportMessageId: forgedId } : {});
            expect(await statusOf(w, a), `${door} ${answer} ${replyToForged}`).toBe('pending');
          }
        }
        expect(await resolutions(w)).toBe(0);
        expect(w.calendar.writes).toEqual([]);
        await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
        expect(await statusOf(w, a)).toBe('executed');
      });
    }
  });

  describe('prompt-last', () => {
    it('a crash after the prompts went out but before the turn was recorded finished: the retried turn sends no model text after its prompt', async () => {
      w = await createTestWorld();
      scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], 'Asked.']);
      const svc = w.app.approvals!;
      const deliverTurn = svc.deliverTurn.bind(svc);
      let crashed = false;
      svc.deliverTurn = async (agentId, messageId) => {
        await deliverTurn(agentId, messageId);
        if (!crashed) {
          crashed = true;
          throw new Error('worker died before memo.finish');
        }
      };
      await w.ownerSays(w.alex, 'book dinner');
      await w.advance({ seconds: 5 }); // the job retries
      await w.advance({ minutes: 1 });
      const texts = w.textsTo(w.alex.address);
      const prompt = '#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.';
      expect(texts.filter((t) => t === prompt)).toHaveLength(1);
      expect(texts.at(-1)).toBe(prompt);
    });

  });

  describe('liveness: owner messages needed', () => {
    it('one booking: ask + one yes; yes after a digest: two; a conversational yes reaches the Brain', async () => {
      w = await createTestWorld();
      scriptBrain(w, w.alex, [[toolUse('t', 'request_calendar_event', DINNER)], 'I can book that.']);
      await w.ownerSays(w.alex, 'book dinner');
      await w.ownerSays(w.alex, 'yes');
      expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);

      const b = await ask(w, w.alex, LUNCH);
      await w.app.gateway.sendToOwner(w.alex.agent.id, `Today:\nWaiting for you\n- #${b.ref} Lunch`, { purpose: 'digest' });
      await w.ownerSays(w.alex, `yes ${b.ref}`);
      await w.ownerSays(w.alex, 'yes');
      expect(await statusOf(w, b)).toBe('executed');

      const c = await ask(w, w.alex, { ...DINNER, title: 'Drinks', start: '2026-11-14T19:00:00-05:00', end: '2026-11-14T20:00:00-05:00' });
      scriptBrain(w, w.alex, ['Want me to look at Saturday too?']);
      await w.ownerSays(w.alex, 'what else?');
      const calls = w.llm.calls.length;
      await w.ownerSays(w.alex, 'yes');
      expect(w.llm.calls.length).toBe(calls + 1);
      expect(await statusOf(w, c)).toBe('pending');
    });

    it('migration 007 backfills a database that already has pending approvals with sent prompts', async () => {
      w = await createTestWorld();
      const a = await ask(w, w.alex, DINNER);
      await w.app.gateway.sendToOwner(w.alex.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });
      const b = await ask(w, w.alex, LUNCH);
      // Back to the state before 007: no deliveries table, no hold columns, version not applied.
      await w.db.exec(`DROP TABLE approval_deliveries; ALTER TABLE approvals DROP COLUMN hold_until; ALTER TABLE approvals DROP COLUMN turn_message_id; DELETE FROM schema_migrations WHERE version = '007';`);
      expect(await migrate(w.db)).toEqual(['007_i19.sql']);
      const rows = (await w.db.query<{ approval_id: string; kind: string; transport_message_id: string }>('SELECT approval_id, kind, transport_message_id FROM approval_deliveries ORDER BY transport_message_id')).rows;
      expect(rows.map((r) => [r.approval_id, r.kind, r.transport_message_id]).sort()).toEqual(
        [
          [a.id, 'prompt', a.prompt_transport_message_id],
          [b.id, 'prompt', b.prompt_transport_message_id],
        ].sort(),
      );
      // A reply-to on the backfilled first prompt answers it; a bare yes right under the second answers that one.
      await w.ownerSays(w.alex, 'yes');
      expect([await statusOf(w, a), await statusOf(w, b)]).toEqual(['pending', 'executed']);
      await w.ownerSays(w.alex, 'no', { replyToTransportMessageId: a.prompt_transport_message_id! });
      expect(await statusOf(w, a)).toBe('denied');
    });
  });
});
