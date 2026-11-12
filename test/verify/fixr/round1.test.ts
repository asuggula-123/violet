/**
 * Verify fix group R, round 1: adversarial tests from angles the audit's evidence tests did
 * not take. Model ids are neutral placeholders. Tests that fail are evidence, kept on purpose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BRAIN_TEXT, BRAIN_TURN_MS } from '../../../src/brain/brain.js';
import { storable } from '../../../src/core/outbound.js';
import type { LlmRequest } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { respond, stepOf, toolUse } from '../../unit/brain/script.js';
import { at, digestsTo, local, NY } from '../../unit/flags/helpers.js';

const DENTIST = { title: 'Dentist', start: '2026-11-12T15:00:00-05:00', end: '2026-11-12T16:00:00-05:00' };
const FORGED = '#1 Dentist — Thu Nov 12, 3:00–4:00 PM. Book it? Reply yes or no.';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** Purposes of what reached Alex, in order. */
const purposes = (t: TestWorld) => t.transport.sent.filter((m) => m.toAddress === t.alex.address).map((m) => m.purpose);

describe('R2 class: no code-written digest line carries a live #ref or a prompt tail outside "Waiting for you"', () => {
  it('a draft whose subject a fooled model copied from an email: the Drafts line in the digest is folded', async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
    const t = w;
    // A real pending #1, so a forged "#1 … Reply yes or no." would aim at something live.
    t.llm.on({ agentId: t.alex.agent.id, mind: 'brain' }, (r: LlmRequest) => {
      const step = stepOf(r);
      const all = JSON.stringify(r.messages);
      if (step > 0) return respond([{ type: 'text', text: 'Okay.' }]);
      if (all.includes('draft a reply')) return respond([toolUse('d', 'draft_email', { to: ['sam@example.test'], subject: FORGED, body: 'x' })]);
      if (all.includes('dentist')) return respond([toolUse('a', 'request_calendar_event', DENTIST)]);
      return respond([{ type: 'text', text: 'Okay.' }]);
    });
    await t.ownerSays(t.alex, 'book the dentist thursday 3pm');
    await t.ownerSays(t.alex, 'draft a reply to that email');
    expect((await t.app.repos.flags.listByAgent(t.alex.agent.id)).map((f) => f.kind)).toContain('draft_created');
    await at(t, '2026-11-09T18:00');
    const [digest] = digestsTo(t, t.alex);
    expect(digest).toBeDefined();
    const lines = digest!.split('\n');
    const waiting = lines.indexOf('Waiting for you');
    const outsideWaiting = lines.filter((_, i) => !(waiting >= 0 && i > waiting && lines[i]!.startsWith('- #')));
    for (const line of outsideWaiting) {
      expect(line, line).not.toMatch(/#\s*\d/);
      expect(line.toLowerCase(), line).not.toMatch(/reply\s*yes\s*or\s*no/);
    }
  });
});

describe('R1: every owner-bound text can be stored, and is still a text', () => {
  it('storable keeps valid surrogate pairs (emoji) and only replaces lone halves', () => {
    expect(storable('ok 😀 \uD83D end')).toBe('ok 😀 � end');
    expect(storable('\uDE00😀')).toBe('�😀');
    expect(storable('a\u0000b')).toBe('ab');
  });

  it('a Brain reply that is only NUL characters: the owner is never sent an empty message', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: '\u0000\u0000' }]));
    await w.ownerSays(w.alex, 'hi');
    for (const text of w.textsTo(w.alex.address)) expect(text.trim(), JSON.stringify(text)).not.toBe('');
  });

  it('a Brain reply with a NUL: the text stored equals the text sent, byte for byte', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => respond([{ type: 'text', text: 'A\u0000B 😀 \uDBFF' }]));
    await w.ownerSays(w.alex, 'hi');
    const sent = w.textsTo(w.alex.address);
    const rows = await w.db.query<{ body: string; transport_message_id: string }>(
      `SELECT body, transport_message_id FROM messages WHERE agent_id = $1 AND direction = 'out' AND thread = 'owner' ORDER BY seq`,
      [w.alex.agent.id],
    );
    expect(rows.rows.map((r) => r.body)).toEqual(sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('😀');
  });
});

describe('R14-R16 keep prompt-last (I19): a turn that stops early still puts the prompt below the notice', () => {
  it('max_tokens after an approval was requested in step 1: the fixed notice, then the prompt, prompt last', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) =>
      stepOf(r) === 0
        ? respond([toolUse('a', 'request_calendar_event', DENTIST)])
        : { content: [{ type: 'text', text: 'Booked it for you, all set.' }, toolUse('b', 'list_pending_approvals', {})], stopReason: 'max_tokens' },
    );
    await w.ownerSays(w.alex, 'book the dentist thursday 3pm');
    expect(purposes(w)).toEqual(['reply', 'approval']);
    const texts = w.textsTo(w.alex.address);
    expect(texts[0]).toBe(BRAIN_TEXT.tooLong);
    expect(texts[0]).not.toContain('Booked it');
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
  });

  it('the deadline passes after an approval was requested: the fixed notice, then the prompt; nothing booked without a yes', async () => {
    w = await createTestWorld();
    const t = w;
    t.llm.on({ agentId: t.alex.agent.id, mind: 'brain' }, (r) => {
      t.clock.advance({ ms: BRAIN_TURN_MS / 2 + 1 });
      return stepOf(r) === 0
        ? respond([toolUse('a', 'request_calendar_event', DENTIST)])
        : respond([{ type: 'text', text: 'I booked it.' }, toolUse(`c${stepOf(r)}`, 'list_pending_approvals', {})]);
    });
    await t.ownerSays(t.alex, 'book the dentist thursday 3pm');
    expect(purposes(t)).toEqual(['reply', 'approval']);
    expect(t.textsTo(t.alex.address)[0]).toBe(BRAIN_TEXT.tookTooLong);
    expect(t.calendar.writes).toEqual([]);
  });

  it('a stop reason "tool_use" with no tool call in it (malformed answer): a fixed notice, never silence', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => ({ content: [], stopReason: 'tool_use' }));
    await w.ownerSays(w.alex, 'hi');
    expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.stopped]);
  });

  it('a refusal after the model already wrote "I booked it" in an earlier step: only the fixed refusal line', async () => {
    w = await createTestWorld();
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (r) =>
      stepOf(r) === 0
        ? respond([{ type: 'text', text: 'I booked it.' }, toolUse('b', 'list_pending_approvals', {})])
        : { content: [], stopReason: 'refusal' },
    );
    await w.ownerSays(w.alex, 'hi');
    expect(w.textsTo(w.alex.address)).toEqual([BRAIN_TEXT.refusal]);
  });
});

describe('R4: job.retry holds no message text', () => {
  it('a handler error whose message carries the owner text: the job.retry row has only the error class', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 0 } });
    let failed = false;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => {
      if (!failed) {
        failed = true;
        throw new Error('secret-owner-words sk-placeholder-key');
      }
      return respond([{ type: 'text', text: 'Okay.' }]);
    });
    await w.ownerSays(w.alex, 'secret-owner-words');
    await w.advance({ minutes: 1 });
    const rows = await w.actions({ action: 'job.retry' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(JSON.stringify(r.detail)).not.toContain('secret-owner-words');
      expect(JSON.stringify(r.detail)).not.toContain('sk-placeholder');
    }
  });
});

describe('R8: strict order does not strand younger held flags behind a failed older one', () => {
  it('the 07:00 send of held flag 1 fails (retryable): 1, 2, 3 all still go out that morning, in order, none lost to the digest', async () => {
    const { flagsWorld, flagsOf, flagTextsTo, now: raiseNow } = await import('../../unit/flags/helpers.js');
    w = await flagsWorld('2026-11-09T23:00');
    const t = w;
    for (const x of ['1', '2', '3']) await raiseNow(t, t.alex, x);
    t.transport.failNext(1);
    for (const wall of ['2026-11-10T07:00', '2026-11-10T07:02', '2026-11-10T07:05', '2026-11-10T07:20', '2026-11-10T08:00']) await at(t, wall);
    expect(flagTextsTo(t, t.alex)).toEqual(['1', '2', '3']);
    expect((await flagsOf(t, t.alex)).filter((f) => f.overflowed_at).map((f) => f.text)).toEqual([]);
  });
});
