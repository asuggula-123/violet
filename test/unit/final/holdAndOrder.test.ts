/**
 * S2: a turn's held prompt is held longer than one attempt of the turn can run, and a new
 * attempt (a job retry) holds it again, so the sweep never puts it above the turn's reply.
 * S3: on resume, notices that waited go out first and the unsent prompts last, so a bare yes
 * under the prompt answers it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TURN_HOLD_MS } from '../../../src/approvals/service.js';
import { BRAIN_TURN_MS } from '../../../src/brain/brain.js';
import { LlmError } from '../../../src/llm/errors.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { FRI, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';
import { i19Violations } from '../i19/helpers.js';
import { a2aBodies, OPEN_PROMPT, REPLY, SECRET, statusByRef, talk } from '../seam/helpers.js';

let w: TestWorld;
afterEach(async () => w.close());

const alexOut = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address);

describe('S2: the turn hold outlasts every attempt of the turn', () => {
  it('attempt 1 holds a release and fails; the retry 12 minutes later runs 6 minutes: the sweep meanwhile does not deliver it, the reply comes first', async () => {
    // The hold is longer than the turn deadline plus the time its last tools and reply need.
    expect(TURN_HOLD_MS).toBeGreaterThan(BRAIN_TURN_MS + 5 * 60_000);
    w = await createTestWorld({ jobs: { backoffMs: () => 12 * 60_000 } });
    scriptEnvoy(w, w.sam, () => ['ok']);
    let attempt = 0;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) {
        attempt += 1;
        return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      }
      if (step === 1) return respond([talk('t', 'Saturday', SECRET)]);
      if (attempt === 1) throw new LlmError('overloaded', true, 'overloaded');
      w.clock.advance({ minutes: 6 }); // 18 minutes after the first attempt held the prompt
      await w.app.scheduler.runDue();
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, SECRET);
    expect(alexOut()).toEqual([]);
    await w.advance({ minutes: 12 });
    expect(attempt).toBe(2);
    expect(alexOut().map((m) => m.purpose)).toEqual(['reply', 'approval']);
    expect(await a2aBodies(w)).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect(await a2aBodies(w)).toEqual([{ kind: 'open', body: SECRET }]);
    expect(await i19Violations(w)).toEqual([]);
  });
});

describe('S3: on resume the waiting prompt is the last thing sent', () => {
  it('a notice and a prompt both waited for the resume: notice first, prompt last; a bare yes under it resolves it', async () => {
    w = await createTestWorld();
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, async (req) => {
      const step = stepOf(req);
      if (step === 0) return respond([talk('o', 'Lunch', 'Lunch with Sam this week?')]); // clean: sent at once, its notice queued
      if (step === 1) {
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
        return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
      }
      if (step === 2) return respond([talk('t', 'Saturday', SECRET)]); // tainted now: held
      return respond([{ type: 'text', text: REPLY }]);
    });
    await w.ownerSays(w.alex, 'Ask Sam about lunch, and about Saturday');
    const sentBefore = alexOut().length;
    await w.ownerSays(w.alex, 'resume');
    const after = alexOut().slice(sentBefore).map((m) => m.text);
    expect(after).toEqual(["Resumed. I'm back on.", "Talking to Sam's Violet about “Lunch”: “Lunch with Sam this week?”", OPEN_PROMPT(1, 'Saturday', SECRET)]);
    expect((await a2aBodies(w)).map((m) => m.body)).not.toContain(SECRET);
    await w.ownerSays(w.alex, 'yes');
    expect(await statusByRef(w, w.alex, 1)).toBe('executed');
    expect((await a2aBodies(w)).map((m) => m.body)).toContain(SECRET);
    expect(await i19Violations(w)).toEqual([]);
  });
});
