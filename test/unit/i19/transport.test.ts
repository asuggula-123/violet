/** I19 E5: the transport numbering is the only ground truth; anything unknown fails closed. */
import { afterEach, describe, expect, it } from 'vitest';
import { REPROMPT_PREFIX } from '../../../src/approvals/service.js';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { reissuePairingCode } from '../../../src/core/pairingReissue.js';
import { FakeTransport } from '../../../src/transport/fake.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { ask, count, DINNER, i19Violations, lastPromptId, statusOf } from './helpers.js';

describe('I19 transport cases', () => {
  let w: TestWorld;
  afterEach(async () => {
    expect(await i19Violations(w)).toEqual([]);
    await w.close();
  });

  const reprompted = () => count(w, 'approval.reprompted');

  it('a gap in the numbering (a message the app never saw) between prompt and answer: re-prompt, then the yes under it counts', async () => {
    w = await createTestWorld();
    const a = await ask(w, w.alex);
    w.transport.skip(w.alex.agentAddress, w.alex.address);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('pending');
    expect(w.lastTo(w.alex.address)).toBe(`${REPROMPT_PREFIX}${a.prompt}`);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('executed');
  });

  it("if Telegram numbered all of a bot's chats together, a stranger writing between prompt and answer is a gap: re-prompt (fail closed)", async () => {
    w = await createTestWorld({ transport: new FakeTransport({ numbering: 'per-bot' }) });
    const a = await ask(w, w.alex);
    await w.strangerSays(w.alex, 'stranger-1', 'hello?');
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('pending');
    expect(await reprompted()).toBe(1);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusOf(w, a)).toBe('executed');
  });

  it('an unknown or malformed chat number: re-prompt; never a resolution', async () => {
    w = await createTestWorld();
    const a = await ask(w, w.alex);
    const above = lastPromptId(w, w.alex);
    const n = Number(above.split(':').at(-1));
    const chat = above.slice(0, above.lastIndexOf(':'));
    for (const id of ['', 'garbage', `${chat}:0${n + 1}`, `${chat}:${n + 1}.0`, `other-chat:${n + 1}`, `${chat}:${n + 1000}`]) {
      await w.ownerSays(w.alex, 'yes 1', { chatMessageId: id });
      expect(await statusOf(w, a), id).toBe('pending');
    }
    expect(await reprompted()).toBe(6);
  });

  it('a transport with no chat numbering: typed answers always re-prompt; reply-to and buttons work', async () => {
    w = await createTestWorld({ transport: new FakeTransport({ numbering: 'none' }) });
    const a = await ask(w, w.alex);
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'yes 1');
    expect(await statusOf(w, a)).toBe('pending');
    expect(await reprompted()).toBe(3);
    await w.ownerSays(w.alex, 'yes', { replyToTransportMessageId: lastPromptId(w, w.alex) });
    expect(await statusOf(w, a)).toBe('executed');
    const b = await ask(w, w.alex, { ...DINNER, title: 'Lunch' });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${b.id}` });
    expect(await statusOf(w, b)).toBe('denied');
  });

  it('pairing reset: a prompt delivered to the old chat is never "above" a message from the new chat', async () => {
    w = await createTestWorld();
    const a = await ask(w, w.sam);
    const { code } = await reissuePairingCode({ db: w.db, clock: w.clock, actionLog: w.app.actionLog }, w.sam.agent.id, { reset: true });
    await w.strangerSays(w.sam, 'sam-new-phone', `/start ${code}`);
    expect(w.lastTo('sam-new-phone')).toBe(OWNER_TEXT.paired);
    const newSam = { ...w.sam, address: 'sam-new-phone' };
    // Even a number that would sit right under the old prompt, if it were the same chat.
    const old = lastPromptId(w, w.sam);
    const n = Number(old.split(':').at(-1));
    await w.ownerSays(newSam, 'yes', { chatMessageId: `${FakeTransport.chat(w.sam.agentAddress, 'sam-new-phone')}:${n + 1}` });
    expect(await statusOf(w, a)).toBe('pending');
    expect(w.lastTo('sam-new-phone')).toBe(`${REPROMPT_PREFIX}${a.prompt}`);
    await w.ownerSays(newSam, 'yes');
    expect(await statusOf(w, a)).toBe('executed');
  });

  it("two owners with the same ref numbers never cross: one owner's prompt is never in the other's run", async () => {
    w = await createTestWorld();
    const alexs = await ask(w, w.alex);
    const sams = await ask(w, w.sam);
    expect([alexs.ref, sams.ref]).toEqual([1, 1]);
    // Sam's message claims the number right under Alex's prompt: it is not Sam's delivery.
    const alexPrompt = lastPromptId(w, w.alex);
    const n = Number(alexPrompt.split(':').at(-1));
    await w.ownerSays(w.sam, 'no 1', { chatMessageId: `${alexPrompt.slice(0, alexPrompt.lastIndexOf(':'))}:${n + 1}` });
    expect([await statusOf(w, alexs), await statusOf(w, sams)]).toEqual(['pending', 'pending']);
    await w.ownerSays(w.sam, 'no', { replyToTransportMessageId: alexPrompt });
    expect([await statusOf(w, alexs), await statusOf(w, sams)]).toEqual(['pending', 'pending']);
    await w.ownerSays(w.alex, 'yes');
    expect([await statusOf(w, alexs), await statusOf(w, sams)]).toEqual(['executed', 'pending']);
  });
});
