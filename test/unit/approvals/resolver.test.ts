import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESOLVER_TEXT } from '../../../src/approvals/resolver.js';
import type { ApprovalRow } from '../../../src/approvals/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';

describe('approval resolver', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  async function ask(p: Persona, title: string, hour = 19): Promise<ApprovalRow> {
    return w.app.approvals!.request(p.agent.id, {
      kind: 'calendar_event',
      payload: { title, start: `2026-11-13T${hour}:00:00-05:00`, end: `2026-11-13T${hour}:30:00-05:00` },
    });
  }
  const status = async (a: ApprovalRow) => (await w.app.approvals!.get(a.id))!.status;
  const brainCalls = () => w.llm.calls.length;

  it('yes with one pending approval books it and confirms in one line', async () => {
    const a = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).toBe('executed');
    expect(w.calendar.eventsOf(w.alex.owner.id)).toEqual([expect.objectContaining({ title: 'Dinner' })]);
    expect(w.lastTo(w.alex.address)).toBe('Booked: Dinner — Fri Nov 13, 7:00–7:30 PM.');
    expect(brainCalls()).toBe(0);
    const [approved] = await w.actions({ action: 'approval.approved' });
    expect(approved!.actor).toBe('owner');
    expect((await w.actions({ action: 'calendar.event_created' })).length).toBe(1);
    expect((await w.actions({ action: 'approval.executed' })).length).toBe(1);
  });

  it('no denies it with a short ack and books nothing', async () => {
    const a = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.alex, 'nope');
    expect(await status(a)).toBe('denied');
    expect(w.calendar.writes).toEqual([]);
    expect(w.lastTo(w.alex.address)).toBe("Okay, I won't book #1.");
    expect((await w.actions({ action: 'approval.denied' })).length).toBe(1);
  });

  it('several pending: a bare yes under both asks "Which one?" and re-sends each prompt; an explicit ref then picks one', async () => {
    const a = await ask(w.alex, 'Dinner', 19);
    const b = await ask(w.alex, 'Lunch', 12);
    const before = w.textsTo(w.alex.address).length;
    await w.ownerSays(w.alex, 'yes');
    // I19 (e): one fixed line with no refs, then each prompt as its own genuine message.
    expect(w.textsTo(w.alex.address).slice(before)).toEqual([RESOLVER_TEXT.whichOne(0), a.prompt, b.prompt]);
    expect([await status(a), await status(b)]).toEqual(['pending', 'pending']);
    expect((await w.actions({ action: 'approval.ambiguous' })).length).toBe(1);
    await w.ownerSays(w.alex, 'no #2'); // #2's copy is in the run right above
    expect([await status(a), await status(b)]).toEqual(['pending', 'denied']);
    await w.ownerSays(w.alex, 'yes'); // only #1 is pending, but its prompt is not right above: shown again
    expect(await status(a)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${a.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).toBe('executed');
    expect(brainCalls()).toBe(0);
  });

  it('replying to a prompt targets that prompt', async () => {
    const a = await ask(w.alex, 'Dinner', 19);
    const b = await ask(w.alex, 'Lunch', 12);
    await w.ownerSays(w.alex, 'ok', { replyToTransportMessageId: b.prompt_transport_message_id! });
    expect([await status(a), await status(b)]).toEqual(['pending', 'executed']);
  });

  it('a reply to a message that is not a prompt resolves nothing, even with a ref: the prompt is shown again', async () => {
    const a = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: 'something-else' });
    expect(await status(a)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`Just to be sure: ${a.prompt}`);
    // I19 (a): the reply-to is checked first; it names no prompt, so the ref only gets a re-prompt.
    await w.ownerSays(w.alex, `yes ${a.ref}`, { replyToTransportMessageId: 'something-else' });
    expect(await status(a)).toBe('pending');
    expect((await w.actions({ action: 'approval.reprompted' })).length).toBe(2);
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).toBe('executed');
  });

  it('buttons resolve the named approval', async () => {
    const a = await ask(w.alex, 'Dinner', 19);
    const b = await ask(w.alex, 'Lunch', 12);
    const sent = w.transport.sent.find((m) => m.text.startsWith('#2'))!;
    expect(sent.buttons).toEqual([
      { id: `approve:${b.id}`, label: 'Yes' },
      { id: `deny:${b.id}`, label: 'No' },
    ]);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${b.id}` });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    expect([await status(a), await status(b)]).toEqual(['executed', 'denied']);
    expect((await w.actions({ action: 'approval.denied' }))[0]!.detail.via).toBe('button');
  });

  it("a button naming another agent's approval resolves nothing", async () => {
    const alexs = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.sam, '', { kind: 'button', buttonPayload: `approve:${alexs.id}` });
    await w.ownerSays(w.sam, '', { kind: 'button', buttonPayload: 'approve:does-not-exist' });
    await w.ownerSays(w.sam, '', { kind: 'button', buttonPayload: 'garbage payload' });
    expect(await status(alexs)).toBe('pending');
    expect(w.textsTo(w.sam.address)).toEqual([RESOLVER_TEXT.notOpen(), RESOLVER_TEXT.notOpen(), RESOLVER_TEXT.notOpen()]);
    expect((await w.actions({ action: 'approval.not_open' })).map((a) => a.detail.reason)).toEqual(['wrong_agent', 'unknown_approval', 'bad_button']);
    expect(w.calendar.writes).toEqual([]);
  });

  it('an already resolved or expired approval is "no longer open"', async () => {
    const a = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.alex, 'no');
    await w.ownerSays(w.alex, 'yes #1');
    expect(w.lastTo(w.alex.address)).toBe(RESOLVER_TEXT.notOpen(1));
    expect(await status(a)).toBe('denied');
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    expect(w.lastTo(w.alex.address)).toBe(RESOLVER_TEXT.notOpen(1));
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: a.prompt_transport_message_id! });
    expect(w.lastTo(w.alex.address)).toBe(RESOLVER_TEXT.notOpen(1));

    const b = await ask(w.alex, 'Lunch');
    await w.advance({ hours: 25 }); // the sweep expires it
    expect(await status(b)).toBe('expired');
    await w.ownerSays(w.alex, 'yes 2');
    expect(w.lastTo(w.alex.address)).toBe(RESOLVER_TEXT.notOpen(2));
    await w.ownerSays(w.alex, 'yes 99');
    expect(w.lastTo(w.alex.address)).toBe(RESOLVER_TEXT.notOpen(99));
    expect(w.calendar.writes).toEqual([]);
    expect(brainCalls()).toBe(0);
  });

  it('yes / no with nothing pending is not handled: the Brain gets it', async () => {
    await w.ownerSays(w.alex, 'yes');
    expect(brainCalls()).toBe(1);
    expect(w.lastTo(w.alex.address)).toBe('OK.');
  });

  it('a message that is not a decision goes to the Brain even with approvals pending', async () => {
    const a = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.alex, 'yes please, and also book lunch');
    expect(brainCalls()).toBe(1);
    expect(await status(a)).toBe('pending');
  });

  it('is idempotent across hook retries: a retry finishes the same resolution and books once', async () => {
    await w.close();
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
    const a = await ask(w.alex, 'Dinner');
    w.transport.failNext(1); // the confirmation fails after the booking
    await w.ownerSays(w.alex, 'yes');
    expect(await status(a)).toBe('executed');
    await w.advance({ seconds: 2 });
    expect(w.lastTo(w.alex.address)).toBe('Booked: Dinner — Fri Nov 13, 7:00–7:30 PM.');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
    expect((await w.actions({ action: 'approval.approved' })).length).toBe(1);
    expect(brainCalls()).toBe(0);
  });

  it('while paused, nothing is resolved (the router holds the message)', async () => {
    const a = await ask(w.alex, 'Dinner');
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'resume');
    expect(await status(a)).toBe('pending');
  });
});
