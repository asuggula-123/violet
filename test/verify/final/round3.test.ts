/**
 * Independent verifier, final integration pass, round 3: adversarial tests for 30f6c4f
 * (model-written calendar and Envoy text made storable: NUL dropped, lone surrogates U+FFFD).
 * What you see is what gets booked must still hold; nothing booked without the yes; and a look
 * at the other paths where model- or stranger-written text is stored. Failing tests are kept as
 * evidence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalEventText } from '../../../src/approvals/eventText.js';
import { sanitize } from '../../../src/core/sanitize.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, a2aMessages, dinnerEvent, FRI, honestDinnerEnvoys, respond, stepOf, toolUse } from '../../unit/a2a/helpers.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const clean = (s: string) => !s.includes('\u0000') && !LONE.test(s);

const HOSTILE = [
  '\uD800Dinner',
  'Din\uD800ner',
  'Dinner\uD800',
  '\uDC00Dinner',
  'Din\uDC00ner',
  'Dinner\uDC00',
  'Dinner \uDE00\uD83D reversed',
  'Dinner \uD83D\u0000\uDE00 joined',
  '"\u0000Dinner"\u0000 #\u00001 \uD800"',
  '＃\u00001 Dinner 􏿿',
];

describe('canonicalEventText with hostile surrogates and NUL', () => {
  it('output is storable, idempotent, and a real emoji (also one joined by dropping a NUL) is a real pair', () => {
    for (const t of HOSTILE) {
      const c = canonicalEventText(t);
      expect(clean(c), JSON.stringify(t)).toBe(true);
      expect(canonicalEventText(c), JSON.stringify(t)).toBe(c);
    }
    // (A ZWJ is Cf and is dropped by sanitize, I13 by design: not tested here.)
    expect(canonicalEventText('Dinner 🍝 with 👍🏽 🇫🇷')).toBe('Dinner 🍝 with 👍🏽 🇫🇷');
    expect(canonicalEventText('x \uD83D\u0000\uDE00 y')).toBe('x 😀 y');
    expect(canonicalEventText('x \uDE00\uD83D y')).toBe('x �� y');
  });

  it('a cut by sanitize never splits a surrogate pair (cut at every length over emoji text)', () => {
    const s = `${'😀'.repeat(50)}\uD800${'🍝a'.repeat(30)}`;
    const stored = canonicalEventText(s);
    for (let max = 1; max < 140; max += 1) expect(clean(sanitize(stored, max)), `max ${max}`).toBe(true);
  });
});

async function soloCase(title: string, location?: string): Promise<{ payload: { title: string; location?: string }; prompt: string; result: string }> {
  w = await createTestWorld();
  let result = '';
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
    if (stepOf(req) === 0) {
      return respond([toolUse('c', 'request_calendar_event', { title, ...FRI.dinner, ...(location !== undefined ? { location } : {}), description: 'Hidden \uD800 note' })]);
    }
    result = JSON.stringify(req.messages.at(-1));
    return respond([{ type: 'text', text: 'Asked.' }]);
  });
  await w.ownerSays(w.alex, 'book dinner friday');
  const rows = (await w.db.query<{ payload: { title: string; location?: string }; prompt: string }>(
    "SELECT payload, prompt FROM approvals WHERE agent_id = $1 AND kind = 'calendar_event'", [w.alex.agent.id])).rows;
  expect(rows, `${JSON.stringify(title)} ${result}`).toHaveLength(1);
  return { ...rows[0]!, result };
}

describe('solo calendar_event: stored = shown = booked, nothing before the yes', () => {
  for (const [i, title] of HOSTILE.entries()) {
    it(`hostile title/location #${i}`, async () => {
      const loc = `Luigi's ${HOSTILE[(i + 3) % HOSTILE.length]}`;
      const { payload, prompt } = await soloCase(title, loc);
      expect(payload.title).toBe(canonicalEventText(title));
      expect(clean(payload.title) && clean(payload.location ?? '')).toBe(true);
      expect(payload).not.toHaveProperty('description');
      expect(prompt).toContain(`${payload.title} — `);
      expect(prompt).toContain(`at “${payload.location}”`);
      expect(w!.transport.sent.filter((m) => m.text === prompt)).toHaveLength(1);
      expect(w!.calendar.writes).toHaveLength(0);
      await w!.ownerSays(w!.alex, 'yes');
      const creates = w!.calendar.writes.filter((x) => x.op === 'create');
      expect(creates).toHaveLength(1);
      const ev = (creates[0] as { event: { title: string; location?: string; description?: string } }).event;
      expect(ev.title).toBe(payload.title);
      expect(ev.location).toBe(payload.location);
      expect(ev.description ?? '').toBe('');
    }, 30_000);
  }

  it('length limit: a 200-character title ending in a lone surrogate is stored and shown whole (no cut, no new lone half)', async () => {
    const title = `${'😀'.repeat(99)}\uD800`; // 199 code units + 1
    expect(title.length).toBe(199);
    const { payload, prompt, result } = await soloCase(title);
    expect(result).not.toMatch(/That tool failed/);
    expect(payload.title).toBe(`${'😀'.repeat(99)}�`);
    expect(prompt).toContain(payload.title);
  }, 30_000);
});

describe('joint booking by an Envoy: both prompts and both calendars carry the stored text', () => {
  it('hostile title and location', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w, dinnerEvent({ title: 'Din\uD800ner \uD83D\u0000\uDE00 "x"\u0000#2', location: '\uDC00Luigi\'s 🍝\uDBFF' }));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const proposal = (await a2aMessages(w)).find((m) => m.kind === 'proposal')!;
    expect(proposal).toBeDefined();
    const ev = (proposal.payload as { events: Array<{ title: string; location: string }> }).events[0]!;
    expect(ev.title).toBe(canonicalEventText('Din\uD800ner \uD83D\u0000\uDE00 "x"\u0000#2'));
    expect(clean(ev.title) && clean(ev.location)).toBe(true);
    for (const p of [w.alex, w.sam]) {
      const a = (await w.app.approvals!.listPending(p.agent.id)).find((x) => x.kind === 'a2a_outcome')!;
      expect(a.prompt).toContain(`“${ev.title}”`);
      expect(a.prompt).toContain(`“${ev.location}”`);
      expect(w.transport.sent.filter((m) => m.text === a.prompt)).toHaveLength(1);
    }
    await w.ownerSays(w.sam, 'yes');
    expect(w.calendar.writes).toHaveLength(0);
    await w.ownerSays(w.alex, 'yes');
    const creates = w.calendar.writes.filter((x) => x.op === 'create') as Array<{ ownerId: string; event: { title: string; location?: string } }>;
    expect(creates.map((c) => c.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    for (const c of creates) {
      expect(c.event.title).toBe(ev.title);
      expect(c.event.location).toBe(ev.location);
    }
  }, 60_000);
});

/** Runs one Brain tool call with the given input and returns what the model saw as its result. */
async function brainTool(name: string, input: Record<string, unknown>): Promise<string> {
  w = await createTestWorld();
  let result = '';
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
    if (stepOf(req) === 0) return respond([toolUse('t', name, input)]);
    result = JSON.stringify(req.messages.at(-1));
    return respond([{ type: 'text', text: 'Done.' }]);
  });
  await w.ownerSays(w.alex, 'please do it');
  return result;
}

describe('other paths where model- or stranger-written text is stored', () => {
  it('remember: a note with a lone surrogate and with NUL is stored cleanly, not an internal error', async () => {
    const r1 = await brainTool('remember', { about: 'Sam \uD800', note: 'Likes \uDC00 pasta' });
    expect(r1).not.toMatch(/That tool failed/);
    await w!.close();
    w = undefined;
    const r2 = await brainTool('remember', { about: 'Sam', note: 'Likes\u0000 pasta' });
    expect(r2).not.toMatch(/That tool failed/);
  }, 30_000);

  it('talk_to_agent: a topic and brief with a lone surrogate are released or refused clearly, not an internal error', async () => {
    const r = await brainTool('talk_to_agent', { with: 'Sam', topic: 'Dinner \uD800', brief: 'Dinner Friday \uDC00 evening', window_start: FRI.windowStart, window_end: FRI.windowEnd });
    expect(r).not.toMatch(/That tool failed/);
  }, 30_000);

  it('draft_email: a subject with a lone surrogate does not fail after the draft was made (no duplicate on retry)', async () => {
    const r = await brainTool('draft_email', { to: ['sam@example.com'], subject: 'Hi \uD800 there', body: 'Body \uDC00' });
    expect(r).not.toMatch(/That tool failed/);
  }, 30_000);

  it('inbound owner text with a lone surrogate and NUL: Telegram normalisation stores it; the fake (dev) transport is refused at ingest with nothing stuck', async () => {
    const { storable } = await import('../../../src/transport/telegram/normalize.js');
    expect(storable('hi \uD800 there\u0000')).toBe('hi \uFFFD there');
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'Hello Alex.' }]));
    const outcome = await w.ownerSays(w.alex, 'hi \uD800 there\u0000').then(() => 'answered', () => 'refused');
    if (outcome === 'answered') expect(w.lastTo(w.alex.address)).toBe('Hello Alex.');
    else {
      expect((await w.db.query('SELECT 1 FROM inbound_events')).rows).toHaveLength(0);
      expect((await w.db.query("SELECT 1 FROM jobs WHERE status NOT IN ('done')")).rows).toHaveLength(0);
    }
  }, 30_000);
});
