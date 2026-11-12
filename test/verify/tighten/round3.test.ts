/**
 * tighten independent verifier, round 3: adversarial tests against I20 (every release in a
 * tainted Brain turn is held for the owner's yes on exactly what crosses). A failing test
 * here is evidence of a defect (see the verifier report); none of these weaken or replace the
 * milestone's tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { releasePrompt, releaseWindowText } from '../../../src/a2a/render.js';
import type { BrainToolCtx } from '../../../src/brain/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, scriptEnvoy } from '../../unit/a2a/helpers.js';

let w: TestWorld;
let open = false;
afterEach(async () => {
  if (open) await w.close();
  open = false;
});

async function world(): Promise<void> {
  w = await createTestWorld();
  open = true;
  scriptEnvoy(w, w.sam, () => ['ok']);
  scriptEnvoy(w, w.alex, () => ['ok']);
}

const samSide = () => JSON.stringify([w.llm.calls.filter((c) => c.meta.agentId === w.sam.agent.id), w.textsTo(w.sam.address)]);
const releases = async () =>
  (await w.db.query<{ status: string; prompt: string }>("SELECT status, prompt FROM approvals WHERE kind = 'a2a_release' ORDER BY ref")).rows;

function ctxOf(p: Persona, callKey: string, tainted: boolean, ownerText = 'Ask Sam about coffee on Friday'): BrainToolCtx {
  return { agent: p.agent, owner: p.owner, turn: { messageId: `v3-${callKey}`, ownerText, tainted }, now: w.clock.now(), callKey };
}

async function callTool(name: string, input: unknown, ctx: BrainToolCtx): Promise<string> {
  const tool = w.app.brain!.tools.get(name)!;
  return tool.handler(tool.input.parse(input), ctx);
}

/** Opens a conversation from a clean turn (goes out at once) and returns its id. */
async function openClean(): Promise<string> {
  const r = await callTool('talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee on Friday?' }, ctxOf(w.alex, 'OPEN', false));
  expect(r).toMatch(/^Sent to/);
  const id = /Conversation id: (\S+)\./.exec(r)![1]!;
  await w.advance({ minutes: 2 });
  return id;
}

const guidanceRows = async (marker: string) =>
  (await w.db.query<{ kind: string }>('SELECT kind FROM a2a_messages WHERE body LIKE $1', [`%${marker}%`])).rows;

describe('tighten verify round 3: the window text determines the stored window', () => {
  it('no two different minute windows render the same text (DST transitions, year boundary, 30/45-minute zones)', () => {
    const req = new Date('2026-11-12T12:00:00Z');
    const zones = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Auckland'];
    const collisions: string[] = [];
    const bases = ['2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z', '2027-03-14T00:00:00Z', '2027-04-03T12:00:00Z'].map(Date.parse);
    for (const tz of zones) {
      const seen = new Map<string, string>();
      for (const b of bases) {
        for (let m = 0; m < 36 * 60; m += 1) {
          const s = new Date(b + m * 60_000);
          for (const len of [1, 61, 24 * 60]) {
            const e = new Date(s.getTime() + len * 60_000);
            const text = releasePrompt("Sam's Violet", 'Coffee?', 'Coffee', { start: s, end: e, timezone: tz, requestedAt: req });
            const key = `${s.toISOString()}/${e.toISOString()}`;
            const before = seen.get(text);
            if (before !== undefined && before !== key) collisions.push(`${tz}: “${text}” is both ${before} and ${key}`);
            seen.set(text, key);
          }
        }
      }
    }
    expect(collisions.slice(0, 5)).toEqual([]);
    // Without a request time the year is always shown.
    expect(releaseWindowText(new Date('2026-11-13T23:00:00Z'), new Date('2026-11-14T02:00:00Z'), 'America/New_York')).toMatch(/2026/);
  }, 240_000);
});

describe('tighten verify round 3: tell_envoy retried with the same call key', () => {
  it('after a yes: an untainted retry sends nothing a second time; the guidance is stored once', async () => {
    await world();
    const conv = await openClean();
    expect(await callTool('tell_envoy', { conversation: conv, guidance: 'Saturday works too MARKG1' }, ctxOf(w.alex, 'G', true))).toMatch(/^Not sent\./);
    expect(await guidanceRows('MARKG1')).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ minutes: 3 });
    expect(await guidanceRows('MARKG1')).toHaveLength(1);
    expect(await callTool('tell_envoy', { conversation: conv, guidance: 'Saturday works too MARKG1' }, ctxOf(w.alex, 'G', false))).toMatch(/already said yes/);
    await w.advance({ minutes: 3 });
    expect(await guidanceRows('MARKG1')).toHaveLength(1);
  });

  it('after a no: neither a tainted nor an untainted retry lets the guidance cross', async () => {
    await world();
    const conv = await openClean();
    await callTool('tell_envoy', { conversation: conv, guidance: 'Saturday works too MARKG2' }, ctxOf(w.alex, 'G', true));
    await w.ownerSays(w.alex, 'no');
    await expect(callTool('tell_envoy', { conversation: conv, guidance: 'Saturday works too MARKG2' }, ctxOf(w.alex, 'G', false))).rejects.toThrow(/said no/);
    await expect(callTool('tell_envoy', { conversation: conv, guidance: 'Saturday works too MARKG2' }, ctxOf(w.alex, 'G', true))).rejects.toThrow(/said no/);
    await w.advance({ minutes: 5 });
    expect(await guidanceRows('MARKG2')).toEqual([]);
    expect(samSide()).not.toContain('MARKG2');
  });

  it('after expiry: an untainted retry is refused and nothing crosses', async () => {
    await world();
    expect(await callTool('talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee MARKX?' }, ctxOf(w.alex, 'X', true))).toMatch(/^Not sent\./);
    await w.advance({ hours: 25 });
    expect((await releases()).map((r) => r.status)).toEqual(['expired']);
    await expect(callTool('talk_to_agent', { with: 'Sam', topic: 'Coffee', brief: 'Coffee MARKX?' }, ctxOf(w.alex, 'X', false))).rejects.toThrow(/did not answer in time/);
    await w.advance({ minutes: 5 });
    expect(await a2aMessages(w)).toEqual([]);
    expect(samSide()).not.toContain('MARKX');
  });
});

describe('tighten verify round 3: what the prompt shows is what crosses', () => {
  it('the stored brief equals the text inside the prompt quotes, byte for byte (NFKC, quotes, number signs, spaces)', async () => {
    await world();
    const brief = 'Coffee  "Friday" at ＃5,​ ﬁne? # ok';
    expect(await callTool('talk_to_agent', { with: 'Sam', topic: 'Coffee', brief }, ctxOf(w.alex, 'B', true))).toMatch(/^Not sent\./);
    const [held] = await releases();
    const shown = /: “(.*)” Send\?/.exec(held!.prompt)![1]!;
    await w.ownerSays(w.alex, 'yes');
    await w.advance({ minutes: 3 });
    const sent = (await a2aMessages(w)).find((m) => m.kind === 'open')!;
    expect(sent.body).toBe(shown);
  });
});
