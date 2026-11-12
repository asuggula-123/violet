/**
 * I20 + idempotency: a tool call that already made an a2a_release approval is answered by that
 * approval, tainted turn or not. A retry (same callKey) after a no sends nothing; after a yes
 * it is not sent a second time; while the approval is pending it stays held.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainToolCtx } from '../../../src/brain/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, scriptEnvoy } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const talk = { with: 'Sam', topic: 'Coffee', brief: 'Coffee on Friday?' };

function ctxOf(p: Persona, callKey: string, tainted: boolean): BrainToolCtx {
  return { agent: p.agent, owner: p.owner, turn: { messageId: `retry-${callKey}`, ownerText: 'Ask Sam about coffee on Friday', tainted }, now: w.clock.now(), callKey };
}

async function callTool(input: unknown, ctx: BrainToolCtx): Promise<string> {
  const tool = w.app.brain!.tools.get('talk_to_agent')!;
  return tool.handler(tool.input.parse(input), ctx);
}

async function world(): Promise<void> {
  w = await createTestWorld();
  scriptEnvoy(w, w.sam, () => ['ok']);
  scriptEnvoy(w, w.alex, () => ['ok']);
}

describe('I20: a retried release call is answered by the approval it already made', () => {
  it('pending: an untainted retry stays held (one approval, nothing crosses)', async () => {
    await world();
    expect(await callTool(talk, ctxOf(w.alex, 'K', true))).toMatch(/^Not sent\./);
    expect(await callTool(talk, ctxOf(w.alex, 'K', false))).toMatch(/^Not sent\./);
    expect((await w.db.query("SELECT id FROM approvals WHERE kind = 'a2a_release'")).rows).toHaveLength(1);
    expect(await a2aMessages(w)).toEqual([]);
  });

  it('after a no: the retry is refused and nothing crosses', async () => {
    await world();
    await callTool(talk, ctxOf(w.alex, 'K', true));
    await w.ownerSays(w.alex, 'no');
    await expect(callTool(talk, ctxOf(w.alex, 'K', false))).rejects.toThrow(/said no to it/);
    await expect(callTool(talk, ctxOf(w.alex, 'K', true))).rejects.toThrow(/said no to it/);
    await w.advance({ minutes: 5 });
    expect(await a2aMessages(w)).toEqual([]);
  });

  it('after a yes: the retry reports it was handled and nothing is sent twice', async () => {
    await world();
    await callTool(talk, ctxOf(w.alex, 'K', true));
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ minutes: 5 });
    expect(await callTool(talk, ctxOf(w.alex, 'K', false))).toMatch(/already said yes/);
    await w.advance({ minutes: 5 });
    expect((await a2aMessages(w)).filter((m) => m.kind === 'open')).toHaveLength(1);
  });
});
