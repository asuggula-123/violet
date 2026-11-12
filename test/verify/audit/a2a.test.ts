/**
 * Independent audit evidence: agent-to-agent (internal channel, transcript, sharing rule,
 * both-owners approval). Failing tests here are evidence of a finding; passing ones record
 * attacks that were tried and held.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import {
  a2aMessages,
  alexOpensDinner,
  contextOf,
  dinnerEvent,
  envoyCalls,
  FRI,
  onlyConversation,
  peerProposalSeq,
  respond,
  scriptEnvoy,
  stepOf,
  toolUse,
} from '../../unit/a2a/helpers.js';

const dinners = (w: TestWorld, ownerId: string) => w.calendar.eventsOf(ownerId).filter((e) => e.title.startsWith('Dinner'));

describe('audit: a2a', () => {
  let w: TestWorld;
  afterEach(async () => w?.close());

  /** Sam's Envoy proposes `event` with `summary`; Alex's Envoy accepts. */
  function samProposesAlexAccepts(summary: string, event: Record<string, unknown>): void {
    scriptEnvoy(w, w.sam, (req) =>
      peerProposalSeq(req) === null && !/You proposed/.test(contextOf(req)) ? [[toolUse('s1', 'propose', { summary, events: [event] })], 'done'] : ['nothing to add'],
    );
    scriptEnvoy(w, w.alex, (req) => {
      const seq = peerProposalSeq(req);
      return seq === null ? ['waiting'] : [[toolUse('a1', 'accept', { proposal_seq: seq })], 'done'];
    });
  }

  it('transcript: "the full verbatim transcript" shows everything the other agent said (long summary, long title)', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    const tailSummary = 'SUMMARY-TAIL-SAID-TO-ALEXS-ENVOY';
    const summary = `${'Dinner on Friday evening, details follow. '.repeat(10)}${tailSummary}`; // ~450 chars (limit 500)
    const tailTitle = 'TITLE-TAIL';
    const title = `Dinner ${'x'.repeat(70)} ${tailTitle}`; // ~90 chars (limit 120)
    samProposesAlexAccepts(summary, dinnerEvent({ title, location: undefined }));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');

    const proposal = (await a2aMessages(w)).find((m) => m.kind === 'proposal')!;
    // Stored in full, and Alex's Envoy read it in full.
    expect(proposal.body).toContain(tailSummary);
    expect(envoyCalls(w, w.alex).some((c) => contextOf(c).includes(tailSummary) && contextOf(c).includes(tailTitle))).toBe(true);

    // What send_transcript_to_owner sends Alex (the same code path, views.transcript).
    const conv = await onlyConversation(w);
    for (const p of [w.alex, w.sam]) {
      const transcript = await w.app.a2a!.transcript(p.agent.id, conv.id);
      expect(transcript, 'summary tail missing from the owner transcript').toContain(tailSummary);
      expect(transcript, 'title tail missing from the owner transcript').toContain(tailTitle);
    }
  });

  it("calendars are proposer-relative: the accepting Envoy reads 'mine' as its own owner's; the owner is told Booked with nothing on their calendar", async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    // Sam's Envoy: only on MY (Sam's) calendar.
    samProposesAlexAccepts('Dinner on Friday at 7', dinnerEvent({ calendars: 'mine' }));
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');

    const alexCtx = envoyCalls(w, w.alex).map(contextOf).find((c) => c.includes('proposed (proposal_seq'))!;
    // Alex's Envoy is told the event is on "mine" — which its own tool docs define as "only your owner's" (Alex's).
    // Corrected by fix group P (RULING P7): calendars are now rendered for the reader, so Alex's
    // Envoy reads "theirs" (Sam's only) for this event.
    expect(alexCtx).toContain('(calendars: theirs)');

    const alexPrompt = w.textsTo(w.alex.address).find((t) => /^#\d+ With Sam/.test(t))!;
    await w.ownerSays(w.sam, 'yes');
    await w.ownerSays(w.alex, 'yes');
    expect(dinners(w, w.sam.owner.id)).toHaveLength(1);
    expect(dinners(w, w.alex.owner.id)).toHaveLength(0);
    // Alex's prompt said "Book it?" and the code-rendered reply says "Booked: …" although nothing is on Alex's calendar.
    expect(alexPrompt).toMatch(/Book it\?/);
    expect(w.lastTo(w.alex.address)).toMatch(/^Booked: /);
    // Evidence assertion: the owner's lines should say whose calendar it is on.
    expect(`${alexPrompt}\n${w.lastTo(w.alex.address)}`, "Alex's prompt/booked line never says it goes on Sam's calendar only").toMatch(/Sam's calendar|not on your calendar|only on/i);
  });

  it('I14: a paused owner\'s calendar is not read for (or revealed to) the other agent', async () => {
    w = await createTestWorld();
    // Alex opens; Sam's Envoy says hi; Alex's Envoy proposes dinner, then Alex texts "pause".
    alexOpensDinner(w);
    let paused = false;
    scriptEnvoy(w, w.alex, (req) => {
      if (/You proposed/.test(contextOf(req))) return ['nothing'];
      if (!/said:/.test(contextOf(req))) return ['waiting'];
      return [
        [toolUse('a1', 'propose', { summary: 'Dinner Friday at 7', events: [dinnerEvent()] })],
        'done',
      ];
    });
    const origFreeBusy = w.calendar.freeBusy.bind(w.calendar);
    const readsWhilePaused: string[] = [];
    w.calendar.freeBusy = async (ownerId, from, to) => {
      const alexAgent = await w.app.repos.agents.get(w.alex.agent.id);
      if (ownerId === w.alex.owner.id && alexAgent!.paused) readsWhilePaused.push(`${from.toISOString()}..${to.toISOString()}`);
      return origFreeBusy(ownerId, from, to);
    };
    // Pause as soon as Alex's proposal is stored (before Sam's Envoy runs its turn on it).
    w.llm.on({ agentId: w.sam.agent.id, mind: 'envoy' }, async (req) => {
      const seq = peerProposalSeq(req);
      if (seq !== null && !paused) {
        paused = true;
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
        // Alex's calendar fills up after the pause.
        w.calendar.seed(w.alex.owner.id, { title: 'Private appointment', start: new Date(FRI.dinner.start), end: new Date(FRI.dinner.end) });
      }
      if (seq !== null) return stepOf(req) === 0 ? respond([toolUse('s2', 'accept', { proposal_seq: seq })]) : respond([{ type: 'text', text: 'done' }]);
      if (/You said/.test(contextOf(req))) return respond([{ type: 'text', text: 'nothing' }]);
      return stepOf(req) === 0 ? respond([toolUse('s1', 'say', { text: 'Sam can do Friday evening.' })]) : respond([{ type: 'text', text: 'done' }]);
    });
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');

    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(true);
    const rows = await a2aMessages(w);
    expect(rows.map((r) => r.kind)).toContain('proposal');
    const slotGone = rows.filter((r) => r.kind === 'system' && /no longer free/.test(r.body));
    const side = (await w.db.query<{ availability_calls: number }>('SELECT availability_calls FROM a2a_sides WHERE agent_id = $1', [w.alex.agent.id])).rows[0]!;
    // Evidence: while Alex is paused, Sam's accept read Alex's free/busy, spent Alex's budget,
    // and told Sam's Envoy (system message) that Alex is now busy at that time.
    expect({ readsWhilePaused, alexBudgetUsed: side.availability_calls, slotGoneToSam: slotGone.length }).toEqual({ readsWhilePaused: [], alexBudgetUsed: 0, slotGoneToSam: 0 });
  });

  it('I7 holds: one yes, a yes on a superseded group, and a yes after the other said no never book', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    samProposesAlexAccepts('Dinner on Friday at 7', dinnerEvent());
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    expect(w.calendar.writes).toEqual([]);
    expect(w.lastTo(w.alex.address)).toBe('Waiting for Sam.');
    // Sam says no: Alex's approved yes must never book anything later.
    await w.ownerSays(w.sam, 'no');
    expect(w.calendar.writes).toEqual([]);
    // Try to book Alex's stale approved approval directly through the writer (as a fooled path would).
    const alexApproval = (await w.db.query<{ id: string; status: string }>(`SELECT id, status FROM approvals WHERE agent_id = $1 AND kind = 'a2a_outcome'`, [w.alex.agent.id])).rows[0]!;
    expect(alexApproval.status).toBe('approved');
    const r = await w.app.approvals!.calendar.executeApproved(alexApproval.id);
    expect(r.ok).toBe(false);
    expect(dinners(w, w.alex.owner.id)).toHaveLength(0);
    expect(dinners(w, w.sam.owner.id)).toHaveLength(0);
  });
});
