/**
 * R1 (I15, 'Log every action'): a text the transport delivered always leaves an outbound row
 * and is never sent again by a retry; every owner-bound text can be stored (U+0000 dropped,
 * lone surrogates replaced), whoever wrote it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnerPurpose } from '../../../src/core/outbound.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, contextOf, FRI, peerProposalSeq, scriptEnvoy, toolUse } from '../a2a/helpers.js';
import { scriptBrain } from '../brain/script.js';
import { at, flagsWorld, later, now } from '../flags/helpers.js';

const DINNER = { title: 'Dinner', ...FRI.dinner };

let w: TestWorld;
afterEach(async () => w?.close());

/** Makes the next `messages` insert of an outbound text that matches `which` fail, once. */
function failStoreOnce(t: TestWorld, which: (purpose: string, body: string) => boolean): () => boolean {
  const add = t.app.repos.messages.add.bind(t.app.repos.messages);
  let failed = false;
  t.app.repos.messages.add = async (m) => {
    if (!failed && m.direction === 'out' && which(String(m.purpose), m.body)) {
      failed = true;
      throw new Error('storage unavailable');
    }
    return add(m);
  };
  return () => failed;
}

const delivered = (t: TestWorld, p: Persona, purpose: OwnerPurpose) => t.transport.sent.filter((m) => m.toAddress === p.address && m.purpose === purpose);

async function sentRows(t: TestWorld, p: Persona, purpose: OwnerPurpose) {
  return (await t.actions({ action: 'outbound.sent', agentId: p.agent.id })).filter((r) => r.detail.purpose === purpose);
}

async function stored(t: TestWorld, p: Persona, purpose: OwnerPurpose): Promise<string[]> {
  const res = await t.db.query<{ body: string }>(
    `SELECT body FROM messages WHERE agent_id = $1 AND direction = 'out' AND purpose = $2 ORDER BY seq`,
    [p.agent.id, purpose],
  );
  return res.rows.map((r) => r.body);
}

/** Exactly one delivery and one outbound.sent row for it, recorded or not; nothing failed; no job left. */
async function once(t: TestWorld, p: Persona, purpose: OwnerPurpose, recorded: boolean): Promise<string> {
  const texts = delivered(t, p, purpose);
  expect(texts).toHaveLength(1);
  const rows = await sentRows(t, p, purpose);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.detail).toMatchObject({ transportMessageId: expect.any(String), chars: texts[0]!.text.length });
  if (recorded) expect(rows[0]!.detail.recorded).toBeUndefined();
  else expect(rows[0]!.detail).toMatchObject({ recorded: false, messageId: null, error: 'storage unavailable' });
  expect(await t.actions({ action: 'outbound.failed', agentId: p.agent.id })).toEqual([]);
  expect((await t.db.query(`SELECT 1 FROM jobs WHERE status NOT IN ('done')`)).rowCount).toBe(0);
  return texts[0]!.text;
}

describe('R1: a NUL or a lone surrogate never makes a delivered text unstorable', () => {
  it('in a Brain reply: one delivery, stored as sent, one outbound row, no resend', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    scriptBrain(w, w.alex, ['Here it is:\u0000 done \uD800 end']);
    await w.ownerSays(w.alex, 'what did the email say?');
    await w.advance({ hours: 1 });
    const text = await once(w, w.alex, 'reply', true);
    expect(text).toBe('Here it is: done � end');
    expect(await stored(w, w.alex, 'reply')).toEqual([text]);
    expect(await w.actions({ action: 'brain.turn' })).toHaveLength(1);
  });

  it('in a flag text: one delivery, stored as sent, one outbound row', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    await w.app.flags.raise(w.alex.agent.id, { kind: 'calendar_conflict', urgency: 'now', text: 'Conflict: “A\u0000B \uDC00”.' });
    await w.advance({ hours: 1 });
    const text = await once(w, w.alex, 'flag', true);
    expect(text).not.toMatch(/\u0000|[\uD800-\uDFFF]/);
    expect(await stored(w, w.alex, 'flag')).toEqual([text]);
  });

  it("in an agent-to-agent notice (the other agent's question): one delivery, stored as sent, one outbound row", async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    scriptBrain(w, w.sam, ['OK.']);
    scriptEnvoy(w, w.sam, (req) => (/You asked Sam/.test(contextOf(req)) ? ['done'] : [[toolUse('q', 'ask_owner', { question: 'Is 7\u0000 fine \uD83D for dinner?' })], 'done']));
    scriptEnvoy(w, w.alex, () => ['waiting']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday');
    await w.advance({ hours: 1 });
    const text = await once(w, w.sam, 'question', true);
    expect(text).toContain('Is 7');
    expect(text).not.toMatch(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(await stored(w, w.sam, 'question')).toEqual([text]);
  });
});

describe('R1: storage fails after a successful send: outbound.sent recorded:false, and no retry sends it again', () => {
  it('reply (a Brain reply)', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    scriptBrain(w, w.alex, ['Hi there.']);
    const failed = failStoreOnce(w, (purpose) => purpose === 'reply');
    await w.ownerSays(w.alex, 'hello');
    await w.advance({ hours: 1 });
    expect(failed()).toBe(true);
    expect(await once(w, w.alex, 'reply', false)).toBe('Hi there.');
    expect(await stored(w, w.alex, 'reply')).toEqual([]);
    expect(w.llm.calls).toHaveLength(1); // the turn did not run again
  });

  it('approval (a prompt), and its button still works', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    scriptBrain(w, w.alex, [[toolUse('c', 'request_calendar_event', DINNER)], 'Asked.']);
    const failed = failStoreOnce(w, (purpose) => purpose === 'approval');
    await w.ownerSays(w.alex, 'book dinner friday');
    await w.advance({ hours: 1 }); // the sweep
    expect(failed()).toBe(true);
    expect(await once(w, w.alex, 'approval', false)).toMatch(/^#1 Dinner .*Reply yes or no\.$/);
    const [a] = await w.app.approvals!.listPending(w.alex.agent.id);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a!.id}` });
    expect(w.calendar.writes.map((x) => x.op)).toEqual(['create']);
  });

  it('flag (an urgent note)', async () => {
    w = await flagsWorld('2026-11-09T10:00');
    const failed = failStoreOnce(w, (purpose) => purpose === 'flag');
    await now(w, w.alex, 'Two events overlap tomorrow.');
    await w.advance({ hours: 2 });
    expect(failed()).toBe(true);
    expect(await once(w, w.alex, 'flag', false)).toBe('Two events overlap tomorrow.');
  });

  it('digest', async () => {
    w = await flagsWorld('2026-11-09T12:00');
    await later(w, w.alex, 'one');
    const failed = failStoreOnce(w, (purpose) => purpose === 'digest');
    await at(w, '2026-11-09T18:00');
    await at(w, '2026-11-09T19:00');
    await at(w, '2026-11-09T21:00');
    expect(failed()).toBe(true);
    expect(await once(w, w.alex, 'digest', false)).toContain('one');
  });

  it('ack (pause)', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    const failed = failStoreOnce(w, (purpose) => purpose === 'ack');
    await w.ownerSays(w.alex, 'pause');
    await w.advance({ hours: 1 });
    expect(failed()).toBe(true);
    await once(w, w.alex, 'ack', false);
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(true);
  });

  it("question (an agent-to-agent notice) and transcript", async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, (req) => (/You asked Sam/.test(contextOf(req)) ? ['done'] : [[toolUse('q', 'ask_owner', { question: 'Is 7 fine?' })], 'done']));
    scriptEnvoy(w, w.alex, (req) => (peerProposalSeq(req) === null ? ['waiting'] : ['done']));
    scriptBrain(w, w.sam, [
      (req) => {
        const conv = /- (\S+): with Alex's Violet/.exec(req.systemDynamic ?? '')![1]!;
        return { content: [toolUse('t', 'send_transcript_to_owner', { conversation: conv })], stopReason: 'tool_use' };
      },
      'Sent.',
    ]);
    const question = failStoreOnce(w, (purpose) => purpose === 'question');
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday');
    await w.advance({ hours: 1 });
    expect(question()).toBe(true);
    await once(w, w.sam, 'question', false);
    const transcript = failStoreOnce(w, (purpose) => purpose === 'transcript');
    await w.ownerSays(w.sam, 'send me the transcript');
    await w.advance({ hours: 1 });
    expect(transcript()).toBe(true);
    await once(w, w.sam, 'transcript', false);
  });
});

describe('R1: a text that is empty once stored is never sent', () => {
  it("only NULs and spaces: nothing reaches the transport, one outbound.suppressed row (reason 'empty')", async () => {
    w = await createTestWorld();
    const before = w.transport.sent.length;
    const res = await w.app.gateway.sendToOwner(w.alex.agent.id, '\u0000 \u0000\n', { purpose: 'flag' });
    expect(res).toBeNull();
    expect(w.transport.sent.length).toBe(before);
    const rows = await w.actions({ action: 'outbound.suppressed', agentId: w.alex.agent.id });
    expect(rows.map((r) => r.detail.reason)).toEqual(['empty']);
    expect(await w.actions({ action: 'outbound.sent', agentId: w.alex.agent.id })).toHaveLength(0);
  });
});
