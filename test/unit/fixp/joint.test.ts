/**
 * P7, P12, P13: the two-owner outcome. Whose calendar an event goes on is rendered for the
 * reader (Envoy context, prompts, Booked lines); the booking guard itself refuses while the
 * other owner's approval is pending; and the Brain's own calendar tool cannot book a time that
 * belongs to a plan still waiting for both yeses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { calendarsFor } from '../../../src/a2a/envoyPrompt.js';
import { bookedLine, outcomePrompt } from '../../../src/a2a/render.js';
import type { ApprovalServiceImpl } from '../../../src/approvals/service.js';
import { CALENDAR_TOOL_TEXT } from '../../../src/brain/tools/calendar.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, contextOf, dinnerEvent, envoyCalls, FRI, honestDinnerEnvoys, lastResults, respond, stepOf, toolUse } from '../a2a/helpers.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function agreed(event = dinnerEvent()): Promise<TestWorld> {
  w = await createTestWorld();
  alexOpensDinner(w);
  honestDinnerEnvoys(w, event);
  await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
  return w;
}

const outcomeOf = async (world: TestWorld, agentId: string) => (await world.app.approvals!.listPending(agentId)).find((a) => a.kind === 'a2a_outcome')!;

describe('P7: whose calendar, for the reader', () => {
  it('calendarsFor reads the resolved agents relative to the reader', () => {
    expect(calendarsFor(['a', 'b'], 'a')).toBe('both');
    expect(calendarsFor(['a'], 'a')).toBe('mine');
    expect(calendarsFor(['b'], 'a')).toBe('theirs');
  });

  it("Sam's event on Sam's calendar only: Alex's Envoy reads 'theirs', Alex's prompt and Booked line say so, Sam's do not", async () => {
    const world = await agreed(dinnerEvent({ calendars: 'mine' })); // proposed by Sam's Envoy
    const alexCtx = envoyCalls(world, world.alex).map(contextOf).find((c) => c.includes('proposed (proposal_seq'))!;
    expect(alexCtx).toContain('(calendars: theirs)');
    expect(alexCtx).not.toContain('(calendars: mine)');
    const alexPrompt = (await outcomeOf(world, world.alex.agent.id)).prompt;
    const samPrompt = (await outcomeOf(world, world.sam.agent.id)).prompt;
    expect(alexPrompt).toContain("(only on Sam's calendar)");
    expect(samPrompt).not.toContain('only on');
    await world.ownerSays(world.sam, 'yes');
    await world.ownerSays(world.alex, 'yes');
    expect(world.lastTo(world.alex.address)).toBe("Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM (only on Sam's calendar).");
    expect(world.textsTo(world.sam.address).at(-1)).toBe('Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM.');
  });

  it('render: an event not on this owner calendar is marked in prompt and Booked line', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const p = { peer: 'Sam', summary: 's', events: [{ title: 'Dinner', ...FRI.dinner, mine: false }, { title: 'Lunch', start: '2026-11-13T12:00:00-05:00', end: '2026-11-13T13:00:00-05:00', mine: true }] };
    expect(outcomePrompt(p, 'America/New_York', now)).toBe("With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM (only on Sam's calendar); “Lunch” — Fri Nov 13, 12:00–1:00 PM. Book them?");
    expect(bookedLine(p, 'America/New_York', now)).toBe("Booked: “Dinner” — Fri Nov 13, 7:00–8:30 PM (only on Sam's calendar); “Lunch” — Fri Nov 13, 12:00–1:00 PM.");
  });
});

describe('P12: the booking guard refuses while the other owner has not approved', () => {
  it("guard() on an approved approval whose sibling is pending throws 'the other owner has not approved it'", async () => {
    const world = await agreed();
    const alex = await outcomeOf(world, world.alex.agent.id);
    const sam = await outcomeOf(world, world.sam.agent.id);
    expect(sam.status).toBe('pending');
    // Everything else the guard checks is in order: the conversation is booking this group.
    await world.db.query(`UPDATE approvals SET status = 'approved', resolved_at = $2 WHERE id = $1`, [alex.id, world.clock.now()]);
    await world.db.query(`UPDATE a2a_conversations SET outcome_state = 'booking'`);
    const kind = (world.app.approvals as ApprovalServiceImpl).kind('a2a_outcome')!;
    const approved = (await world.app.approvals!.get(alex.id))!;
    await expect(kind.guard!(approved)).rejects.toMatchObject({ ownerMessage: 'the other owner has not approved it' });
    // With the sibling approved the same guard passes.
    await world.db.query(`UPDATE approvals SET status = 'approved', resolved_at = $2 WHERE id = $1`, [sam.id, world.clock.now()]);
    await expect(kind.guard!(approved)).resolves.toBeUndefined();
    expect(world.calendar.writes).toEqual([]);
  });
});

describe('P13: request_calendar_event cannot book a time of a plan waiting for both yeses', () => {
  it('a fooled model files the agreed dinner as a solo event: refused with the fixed text, no prompt; a different time still works', async () => {
    const world = await agreed();
    const outcome = await outcomeOf(world, world.alex.agent.id);
    const results: string[] = [];
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
      const step = stepOf(req);
      if (step > 0) results.push(...lastResults(req).map((r) => r.content));
      if (step === 0) return respond([toolUse('c1', 'request_calendar_event', { title: 'Dinner', start: '2026-11-13T19:30:00-05:00', end: '2026-11-13T21:00:00-05:00' })]);
      if (step === 1) return respond([toolUse('c2', 'request_calendar_event', { title: 'Gym', start: '2026-11-13T08:00:00-05:00', end: '2026-11-13T09:00:00-05:00' })]);
      return respond([{ type: 'text', text: 'Sam agreed. Approve the booking below.' }]);
    });
    await world.ownerSays(world.alex, 'How is it going with Sam?');
    expect(results[0]).toBe(CALENDAR_TOOL_TEXT.jointPending(outcome.ref));
    expect(results[1]).toBe(CALENDAR_TOOL_TEXT.requested);
    const kinds = (await world.app.approvals!.listPending(world.alex.agent.id)).map((a) => [a.kind, a.prompt.replace(/^#\d+ /, '').slice(0, 10)]);
    expect(kinds).toEqual([['a2a_outcome', 'With Sam: '], ['calendar_event', 'Gym — Fri ']]);
  });
});

describe('P13 after this owner said yes: the plan still waits for the other owner', () => {
  const soloDinner = (world: TestWorld, results: string[]) =>
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
      if (stepOf(req) === 0) return respond([toolUse('c1', 'request_calendar_event', { title: 'Dinner', ...FRI.dinner })]);
      results.push(...lastResults(req).map((r) => r.content));
      return respond([{ type: 'text', text: 'Approve the booking below.' }]);
    });

  it('a solo request for the agreed time is refused with the answered text while Sam has not answered', async () => {
    const world = await agreed();
    const outcome = await outcomeOf(world, world.alex.agent.id);
    await world.ownerSays(world.alex, '', { kind: 'button', buttonPayload: `approve:${outcome.id}` });
    const results: string[] = [];
    soloDinner(world, results);
    await world.ownerSays(world.alex, 'How is it going with Sam?');
    expect(results[0]).toBe(CALENDAR_TOOL_TEXT.jointPending(outcome.ref, true));
    expect((await world.app.approvals!.listPending(world.alex.agent.id)).filter((a) => a.kind === 'calendar_event')).toEqual([]);
  });

  it('once Sam says no the plan is closed: the same time may be asked about alone again', async () => {
    const world = await agreed();
    const outcome = await outcomeOf(world, world.alex.agent.id);
    await world.ownerSays(world.alex, '', { kind: 'button', buttonPayload: `approve:${outcome.id}` });
    const sam = await outcomeOf(world, world.sam.agent.id);
    await world.ownerSays(world.sam, '', { kind: 'button', buttonPayload: `deny:${sam.id}` });
    const results: string[] = [];
    soloDinner(world, results);
    await world.ownerSays(world.alex, 'Then just put dinner on my calendar');
    expect(results[0]).toBe(CALENDAR_TOOL_TEXT.requested);
  });
});
