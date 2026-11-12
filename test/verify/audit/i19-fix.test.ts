/**
 * Independent audit of commit 305a14a (I19 round 1 fixes): the stricter bare-answer rule (c)
 * in the resolver and the closing mark that keeps a retried / duplicate Brain turn's text
 * above its prompts. Failing tests here are evidence of findings; passing ones are checks
 * that held.
 */
import { vi } from 'vitest';

// A test hook around claimDeliveries: lets a test close an approval in the window between the
// resolver choosing its candidates and its claim (a concurrent close from another lane).
const claimHook: { before?: () => Promise<void> } = {};
vi.mock('../../../src/approvals/deliveries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/approvals/deliveries.js')>();
  return {
    ...real,
    claimDeliveries: async (...args: Parameters<typeof real.claimDeliveries>) => {
      const hook = claimHook.before;
      claimHook.before = undefined;
      if (hook) await hook();
      return real.claimDeliveries(...args);
    },
  };
});

import { afterEach, describe, expect, it } from 'vitest';
import { RESOLVER_TEXT } from '../../../src/approvals/resolver.js';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { BRAIN_TEXT } from '../../../src/brain/brain.js';
import type { OwnerMessageCtx } from '../../../src/core/router.js';
import { LlmError } from '../../../src/llm/errors.js';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { respond, stepOf, toolUse } from '../../unit/brain/script.js';

const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
const LUNCH = { title: 'Lunch', start: '2026-11-12T12:00:00-05:00', end: '2026-11-12T13:00:00-05:00' };
const DINNER_PROMPT = '#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.';

let w: TestWorld;
afterEach(async () => {
  claimHook.before = undefined;
  await w?.close();
});

const ask = (p: Persona, payload: Record<string, unknown>): Promise<ApprovalRow> => w.app.approvals!.request(p.agent.id, { kind: 'calendar_event', payload });
const statusOf = async (a: { id: string }) => (await w.app.approvals!.get(a.id))!.status;
const flag = (p: Persona) => w.app.gateway.sendToOwner(p.agent.id, 'Two events overlap tomorrow.', { purpose: 'flag' });

/** The ctx of the persona's latest owner message, as the router builds it (for a duplicate run). */
async function lastCtx(p: Persona): Promise<OwnerMessageCtx> {
  const row = (
    await w.db.query<{ id: string; body: string; transport_message_id: string; meta: Record<string, unknown> }>(
      `SELECT id, body, transport_message_id, meta FROM messages WHERE agent_id = $1 AND direction = 'in' AND thread = 'owner' ORDER BY seq DESC LIMIT 1`,
      [p.agent.id],
    )
  ).rows[0]!;
  const agent = (await w.app.repos.agents.get(p.agent.id))!;
  return {
    agent,
    owner: p.owner,
    messageId: row.id,
    msg: {
      transport: 'fake',
      agentAddress: p.agentAddress,
      fromAddress: p.address,
      kind: 'text',
      text: row.body,
      transportMessageId: row.transport_message_id,
      ...(row.meta.chatMessageId ? { chatMessageId: String(row.meta.chatMessageId) } : {}),
      receivedAt: w.clock.now(),
    },
  };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('closing mark (brain.ts / memo.ts)', () => {
  it('holds: a duplicate run still in its model loop when the other run closed sends no text after the prompt', async () => {
    w = await createTestWorld();
    const g = gate();
    let first = true;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req: LlmRequest): Promise<LlmResponse> => {
      if (first) {
        first = false;
        await g.wait; // run A: the slow, stale run
      }
      return stepOf(req) === 0 ? respond([toolUse('t', 'request_calendar_event', DINNER)]) : respond([{ type: 'text', text: 'Asked.' }]);
    });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'book dinner' });
    const settling = w.app.settle(); // run A (the job) blocks in its first model call
    await until(() => w.llm.calls.length >= 1, 'run A to call the model');
    await w.app.brain!.handle(await lastCtx(w.alex)); // run B (the requeued duplicate) completes
    expect(w.textsTo(w.alex.address)).toEqual(['Asked.', DINNER_PROMPT]);
    g.open();
    await settling;
    await w.app.settle();
    expect(w.textsTo(w.alex.address)).toEqual(['Asked.', DINNER_PROMPT]);
  });

  it('holds: a duplicate run whose model then fails (non-retryable) sends no apology after the prompt', async () => {
    w = await createTestWorld();
    const g = gate();
    let first = true;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req: LlmRequest): Promise<LlmResponse> => {
      if (first) {
        first = false;
        await g.wait;
        throw new LlmError('bad_request', false, 'boom');
      }
      return stepOf(req) === 0 ? respond([toolUse('t', 'request_calendar_event', DINNER)]) : respond([{ type: 'text', text: 'Asked.' }]);
    });
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'book dinner' });
    const settling = w.app.settle();
    await until(() => w.llm.calls.length >= 1, 'run A to call the model');
    await w.app.brain!.handle(await lastCtx(w.alex));
    g.open();
    await settling;
    await w.app.settle();
    const texts = w.textsTo(w.alex.address);
    expect(texts).not.toContain(BRAIN_TEXT.modelFailed);
    expect(texts.at(-1)).toBe(DINNER_PROMPT);
  });

  it('HOLDS (window, R7): two runs that both pass the closing check before either marks it: one reply lands after the prompt, and it fails closed', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req: LlmRequest): LlmResponse =>
      stepOf(req) === 0 ? respond([toolUse('t', 'request_calendar_event', DINNER)]) : respond([{ type: 'text', text: 'Asked.' }]),
    );
    const t = w.transport;
    const send = t.send.bind(t);
    let held = false;
    t.send = async (msg) => {
      // Run A has checked the mark (none) and its reply is in flight; run B (a stale requeue) finishes meanwhile.
      if (!held && msg.purpose === 'reply' && msg.text === 'Asked.') {
        held = true;
        await w.app.brain!.handle(await lastCtx(w.alex));
      }
      return send(msg);
    };
    await w.ownerSays(w.alex, 'book dinner');
    const texts = w.textsTo(w.alex.address);
    expect(texts).toEqual(['Asked.', DINNER_PROMPT, 'Asked.']);
    // Fails closed: a bare yes under the late reply approves nothing (the Brain gets it).
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'Okay.' }]));
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.writes).toEqual([]);
    // R7 ruling (doc fix, no code change): 8.2 no longer claims "no reply lands after its prompts"
    // for two runs at once; it promises this fail-closed case. The button on the real prompt still books.
    const [dinner] = await w.app.approvals!.listPending(w.alex.agent.id);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${dinner!.id}` });
    expect(w.calendar.writes.map((x) => x.op)).toEqual(['create']);
  });

  it('holds: a first attempt whose reply send failed (before any mark) still replies on retry, then the prompt', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req: LlmRequest): LlmResponse =>
      stepOf(req) === 0 ? respond([toolUse('t', 'request_calendar_event', DINNER)]) : respond([{ type: 'text', text: 'Asked.' }]),
    );
    w.transport.failNext(1); // the reply is the first send of the turn
    await w.ownerSays(w.alex, 'book dinner');
    await w.advance({ seconds: 30 });
    await w.advance({ minutes: 2 });
    expect(w.textsTo(w.alex.address)).toEqual(['Asked.', DINNER_PROMPT]);
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
  });

  it('holds: a crash after the mark, inside beforePrompts, retries to one reply then the prompt (no second model run)', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req: LlmRequest): LlmResponse =>
      stepOf(req) === 0 ? respond([toolUse('t', 'request_calendar_event', DINNER)]) : respond([{ type: 'text', text: 'Asked.' }]),
    );
    let crashed = false;
    w.app.brain!.beforePrompts.unshift(async () => {
      if (!crashed) {
        crashed = true;
        throw new Error('worker died after the mark');
      }
    });
    await w.ownerSays(w.alex, 'book dinner');
    const calls = w.llm.calls.length;
    await w.advance({ seconds: 30 });
    await w.advance({ minutes: 2 });
    expect(w.llm.calls.length).toBe(calls);
    expect(w.textsTo(w.alex.address)).toEqual(['Asked.', DINNER_PROMPT]);
  });

  it('holds: the mark is per message: the next owner message gets a normal reply', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'Sure.' }]));
    await w.ownerSays(w.alex, 'hello');
    await w.ownerSays(w.alex, 'hello again');
    expect(w.textsTo(w.alex.address)).toEqual(['Sure.', 'Sure.']);
    const marks = await w.db.query(`SELECT message_id FROM brain_tool_memo WHERE tool = '#closing'`);
    expect(marks.rows).toHaveLength(2);
  });
});

describe('resolver rule (c) after 305a14a', () => {
  it('holds: Which-one bundle [#1, #2], #1 closes, a bare yes re-prompts #2 (no resolution); the yes under that resolves it: 2 typed messages', async () => {
    w = await createTestWorld();
    const a = await ask(w.alex, DINNER);
    const b = await ask(w.alex, LUNCH);
    await flag(w.alex);
    await w.ownerSays(w.alex, 'yes'); // Which one? + both prompts
    expect(w.textsTo(w.alex.address).slice(-3)).toEqual([RESOLVER_TEXT.whichOne(0), a.prompt, b.prompt]);
    await w.app.approvals!.cancel(a.id, 'the other side said no');
    await w.ownerSays(w.alex, 'yes'); // typed 1
    expect(await statusOf(b)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${b.prompt}`);
    await w.ownerSays(w.alex, 'yes'); // typed 2
    expect(await statusOf(b)).toBe('executed');
  });

  it('EVIDENCE (doc): RUN names two approvals, one closed: 8.3 (c) says "(e) with those still pending (one left -> (d))", but the code shows every answerable approval', async () => {
    w = await createTestWorld();
    const old = await ask(w.alex, { title: 'Old', start: '2026-11-14T10:00:00-05:00', end: '2026-11-14T10:30:00-05:00' });
    await flag(w.alex);
    const c = await ask(w.alex, DINNER);
    const d = await ask(w.alex, LUNCH);
    await w.app.approvals!.cancel(c.id, 'the conversation closed');
    const before = w.transport.sent.length;
    await w.ownerSays(w.alex, 'yes'); // RUN(m) = [d, c]; only d still pending
    const shown = w.transport.sent.slice(before).map((m) => m.text);
    expect(await statusOf(old)).toBe('pending');
    // Documented: one left -> (d): a re-prompt of #3 only.
    expect(shown).toEqual([`${REPROMPT_PREFIX}${d.prompt}`]);
  });

  it('EVIDENCE (doc gap): a bare yes directly under ONE closed prompt, another approval answerable: falls to the Q branch and re-prompts the other one, no not-open line', async () => {
    w = await createTestWorld();
    const other = await ask(w.alex, LUNCH);
    await flag(w.alex);
    const a = await ask(w.alex, DINNER);
    await w.app.approvals!.cancel(a.id, 'the conversation closed');
    const before = w.transport.sent.length;
    await w.ownerSays(w.alex, 'yes'); // directly under #2 (closed)
    const shown = w.transport.sent.slice(before).map((m) => m.text);
    expect(await statusOf(other)).toBe('pending'); // safe: nothing resolved
    // The owner answered #2 and is asked about #1 instead, never told #2 is closed
    // (a reply-to or `yes 2` would get "#2 isn't open any more."). 8.3 (c) has no row for this case.
    expect(shown).toEqual([RESOLVER_TEXT.notOpen(a.ref)]);
  });

  it('EVIDENCE: a candidate closes between the resolver choosing it and its claim: the owner\'s yes gets no answer at all', async () => {
    w = await createTestWorld();
    const a = await ask(w.alex, DINNER);
    const b = await ask(w.alex, LUNCH);
    await flag(w.alex);
    claimHook.before = async () => {
      await w.app.approvals!.cancel(a.id, 'the other side said no');
    };
    const before = w.transport.sent.length;
    await w.ownerSays(w.alex, 'yes'); // Which one? chosen for [#1, #2]; #1 closes before the claim
    expect(await statusOf(b)).toBe('pending');
    const shown = w.transport.sent.slice(before).map((m) => m.text);
    // Nothing is resolved (safe), but the owner hears nothing back for this message.
    expect(shown.length).toBeGreaterThan(0);
  });

  it('EVIDENCE (doc): a bare yes under two adjacent prompts while 5 older ones wait: Which one shows the 5 older ones and neither of the two right above', async () => {
    w = await createTestWorld();
    for (let i = 0; i < 5; i++) await ask(w.alex, { title: `E${i}`, start: `2026-11-14T1${i}:00:00-05:00`, end: `2026-11-14T1${i}:30:00-05:00` });
    await flag(w.alex);
    const x = await ask(w.alex, DINNER);
    const y = await ask(w.alex, LUNCH);
    const before = w.transport.sent.length;
    await w.ownerSays(w.alex, 'yes'); // RUN(m) = [y, x]
    const shown = w.transport.sent.slice(before).map((m) => m.text);
    // 8.3 (c): "(e) with those still pending": the two the owner answered under.
    expect(shown).toEqual([RESOLVER_TEXT.whichOne(0), x.prompt, y.prompt]);
  });

  it('holds: duplicate deliveries of the same approval in RUN count once (re-prompt then yes resolves)', async () => {
    w = await createTestWorld();
    const a = await ask(w.alex, DINNER);
    await flag(w.alex);
    await w.ownerSays(w.alex, `yes ${a.ref}`); // re-prompt
    // Owner messages and re-prompts interleave; make two deliveries of #1 adjacent via a which-one-free path:
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(a)).toBe('executed');
  });
});
