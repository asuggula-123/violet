/**
 * E1: the Envoy turn has a wall-clock bound (ENVOY_TURN_MS), like the Brain turn (R16). A model
 * call gets the time left as timeoutMs and is cut off there; the tools of a cut-off call never
 * run. The hostile model below would propose a booking if it were allowed to answer late.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ENVOY_TURN_MS } from '../../../src/a2a/envoy.js';
import { LlmError } from '../../../src/llm/errors.js';
import type { LlmRequest } from '../../../src/llm/types.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, dinnerEvent, envoyCalls, FRI, respond, stepOf, toolUse } from '../a2a/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

describe('E1: the Envoy turn deadline', () => {
  it('a model that answers only after the deadline: cut off, nothing proposed, the side stalled (its owner is told), the conversation still open', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    const seen: Array<number | undefined> = [];
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, async (req: LlmRequest) => {
      seen.push(req.timeoutMs);
      if (stepOf(req) === 0) return respond([toolUse('s1', 'check_availability', { start: FRI.windowStart, end: FRI.windowEnd })]);
      // The slowest model: 20 minutes, then a proposal. A client honouring timeoutMs is cut off first.
      if (req.timeoutMs !== undefined && req.timeoutMs < 20 * 60_000) {
        w.clock.advance({ ms: req.timeoutMs });
        throw new LlmError('deadline', false, 'cut off at timeoutMs');
      }
      w.clock.advance({ minutes: 20 });
      return respond([toolUse('s2', 'propose', { summary: 'Dinner on Friday at 7', events: [dinnerEvent()] })]);
    });
    w.llm.on({ agentId: w.alex.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'waiting' }]));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((t) => t !== undefined && t <= ENVOY_TURN_MS)).toBe(true);
    expect((await a2aMessages(w)).map((m) => m.kind)).toEqual(['open']);
    const turn = (await w.actions({ action: 'a2a.envoy_turn', agentId: w.sam.agent.id })).at(-1)!;
    expect(turn.detail).toMatchObject({ act: null, stopReason: 'deadline' });
    const side = (await w.db.query<{ stalled: boolean }>('SELECT stalled FROM a2a_sides WHERE agent_id = $1', [w.sam.agent.id])).rows[0]!;
    expect(side.stalled).toBe(true);
    expect((await w.db.query<{ status: string }>('SELECT status FROM a2a_conversations')).rows[0]!.status).toBe('open');
    expect(envoyCalls(w, w.sam).length).toBe(seen.length);
  });
});
