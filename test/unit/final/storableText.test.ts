/**
 * Round 2, finding 1: model-written text that goes into a jsonb column is made storable first.
 * Postgres jsonb rejects U+0000 and lone surrogates; a calendar title or an Envoy message that
 * holds one used to fail the tool ("That tool failed") and lose the owner's request. Now NUL is
 * dropped and a lone surrogate becomes U+FFFD, and the prompt shows exactly the stored text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalEventText } from '../../../src/approvals/eventText.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, dinnerEvent, FRI, respond, stepOf, toolUse } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w?.close());

describe('storable model text', () => {
  it('canonicalEventText: NUL dropped, lone surrogates become U+FFFD, a real pair is kept', () => {
    expect(canonicalEventText('Din\u0000ner \uD800 x')).toBe('Dinner \uFFFD x');
    expect(canonicalEventText('a \uDC00 b')).toBe('a \uFFFD b');
    expect(canonicalEventText('Dinner 🍝')).toBe('Dinner 🍝');
    // Idempotent: the stored text is its own canonical form.
    const once = canonicalEventText('x \uD800\uD800 y');
    expect(canonicalEventText(once)).toBe(once);
  });

  it('a hostile model writes a title with a lone surrogate: one prompt with the storable title, nothing booked before a yes', async () => {
    w = await createTestWorld();
    let result = '';
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => {
      if (stepOf(req) === 0) return respond([toolUse('c', 'request_calendar_event', { title: 'Din\u0000ner \uD800 x', ...FRI.dinner })]);
      result = JSON.stringify(req.messages.at(-1));
      return respond([{ type: 'text', text: 'Asked.' }]);
    });
    await w.ownerSays(w.alex, 'book dinner friday');
    expect(result).not.toMatch(/That tool failed/);
    const rows = (await w.db.query<{ payload: { title: string }; status: string; prompt: string }>(
      "SELECT payload, status, prompt FROM approvals WHERE agent_id = $1 AND kind = 'calendar_event'", [w.alex.agent.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe('Dinner \uFFFD x');
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.prompt).toContain('Dinner \uFFFD x');
    expect(w.transport.sent.some((m) => m.text === rows[0]!.prompt)).toBe(true);
    expect(w.calendar.writes).toHaveLength(0);
  });

  it('an Envoy proposes with a lone surrogate in the summary: the proposal is stored (U+FFFD), not an internal failure', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, (req) => {
      if (stepOf(req) === 0) return respond([toolUse('s1', 'propose', { summary: 'Dinner \uD800 Friday\u0000', events: [dinnerEvent()] })]);
      return respond([{ type: 'text', text: 'done' }]);
    });
    w.llm.on({ agentId: w.alex.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'waiting' }]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    const proposals = (await a2aMessages(w)).filter((m) => m.kind === 'proposal');
    expect(proposals.map((m) => m.body)).toEqual(['Dinner \uFFFD Friday']);
    expect(proposals[0]!.payload.summary).toBe('Dinner \uFFFD Friday');
    // Still only a proposal: nothing is booked before both owners say yes (I7).
    expect(w.calendar.writes).toHaveLength(0);
  });
});
