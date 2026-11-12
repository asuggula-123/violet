/**
 * Verify fix group Q, round 2: adversarial tests from angles the implementer's tests, the audit
 * evidence and round 1 do not cover.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerWithAgent } from '../../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { a2aMessages, alexOpensDinner, contextOf, envoyCalls, FRI, honestDinnerEnvoys, onlyConversation, peerProposalSeq, respond, scriptEnvoy, stepOf, toolUse } from '../../unit/a2a/helpers.js';

const isPaused = async (w: TestWorld, agentId: string) => (await w.app.repos.agents.get(agentId))!.paused;
const creates = (w: TestWorld) => w.calendar.writes.filter((x) => x.op === 'create');

describe('Q1 round 2: a booking held for a paused owner', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  async function heldBooking(): Promise<void> {
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe('Waiting for Alex.');
  }

  it('both paused one after the other: nothing while either is paused, booked exactly once after the last resume', async () => {
    w = await createTestWorld();
    await heldBooking();
    await w.ownerSays(w.sam, 'pause');
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect(creates(w)).toEqual([]);
    await w.ownerSays(w.sam, 'resume');
    await w.app.settle();
    expect(creates(w).map((x) => x.ownerId).sort()).toEqual([w.alex.owner.id, w.sam.owner.id].sort());
    expect(w.textsTo(w.sam.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
    expect(w.textsTo(w.alex.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
  });

  /**
   * Sam was told "Waiting for Alex." after both said yes. If Alex stays paused past the idle
   * limit, the sweep closes the conversation under the held booking. After the resume the
   * booking is either made, or both owners are told at once (not only in a digest) that it was
   * not booked. Nothing is lost silently.
   */
  it('a held booking that outlives the idle limit is not dropped silently', async () => {
    w = await createTestWorld();
    await heldBooking();
    const samBefore = w.textsTo(w.sam.address).length;
    const alexBefore = w.textsTo(w.alex.address).length;
    await w.advance({ hours: 25 });
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    const toSam = w.textsTo(w.sam.address).slice(samBefore);
    const toAlex = w.textsTo(w.alex.address).slice(alexBefore);
    const booked = creates(w).length === 2;
    const toldNotBooked = (t: string[]) => t.some((x) => /not booked|Nothing was booked|Couldn't book/i.test(x));
    const approvals = (await w.db.query<{ status: string }>(`SELECT status FROM approvals WHERE kind = 'a2a_outcome' ORDER BY seq`)).rows.map((r) => r.status);
    expect({ booked, samTold: booked || toldNotBooked(toSam), alexTold: booked || toldNotBooked(toAlex), approvals, conv: (await onlyConversation(w)).status }).toMatchObject({
      samTold: true,
      alexTold: true,
    });
  });
});

describe('Q1 round 2: a pause that commits while the booking write is in flight (known race window)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  /**
   * F2 RULING: the pause is checked right before each calendar write (test/unit/final/pauseWrite
   * covers a pause that commits before the write). The one window left is a pause that lands
   * while the provider call is already in flight: the wrapper below ingests the pause inside
   * createEvent, so that write goes through. ARCHITECTURE 8.6 states this window instead of
   * claiming it away; this test pins the documented behaviour and the doc line.
   */
  it("a pause ingested inside Alex's calendar call does not stop that write (stated in 8.6)", async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    const orig = w.calendar.createEvent.bind(w.calendar);
    const writtenWhilePaused: string[] = [];
    let armed = true;
    w.calendar.createEvent = async (ownerId, ev, key) => {
      if (ownerId === w.alex.owner.id && armed) {
        armed = false;
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
      }
      const out = await orig(ownerId, ev, key);
      if (ownerId === w.alex.owner.id && (await isPaused(w, w.alex.agent.id))) writtenWhilePaused.push(ev.title);
      return out;
    };
    await w.ownerSays(w.sam, 'yes');
    expect(writtenWhilePaused).toEqual(['Dinner']);
    expect(creates(w)).toHaveLength(2); // booked on both, as one booking: never half
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8')).toContain(
      'One window is left: a pause that lands while the call to Google is already in flight does not stop that write.',
    );
  });
});

describe('Q1 round 2: a held booking whose time passes during the pause', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  /**
   * Both said yes on Friday morning; Alex is paused until after dinner time. On resume the
   * held booking must not be written as if nothing happened: an event that is already over is
   * not booked (both owners are told), rather than "Booked" for a past dinner.
   */
  it('on resume, a dinner that already started is not booked', async () => {
    w = await createTestWorld();
    w.clock.advance({ hours: 4 * 24 + 6 }); // Fri Nov 13, 10:00 AM New York
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'pause');
    await w.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe('Waiting for Alex.');
    w.clock.advance({ hours: 11 }); // 9:00 PM: dinner (7:00-8:30 PM) is over
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    expect({ creates: creates(w).length, bookedToSam: w.textsTo(w.sam.address).filter((t) => /^Booked/.test(t)) }).toEqual({ creates: 0, bookedToSam: [] });
  });
});

describe('Q2 round 2: the other side accepts while Alex is paused', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it("Alex's prompt waits for the resume and comes then; Sam's yes waits; then booked once", async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    // Sam proposes; Alex's Envoy accepts; Alex pauses during Alex's Envoy accept call.
    scriptEnvoy(w, w.sam, (req) =>
      peerProposalSeq(req) === null && !/You proposed/.test(contextOf(req)) ? [[toolUse('s2', 'propose', { summary: 'Dinner on Friday at 7', events: [{ title: 'Dinner', ...FRI.dinner, location: "Luigi's", calendars: 'both' }] })], 'done'] : ['nothing to add'],
    );
    let pausedOnce = false;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'envoy' }, async (req) => {
      const seq = peerProposalSeq(req);
      if (seq === null || stepOf(req) > 0) return respond([{ type: 'text', text: 'done' }]);
      return respond([toolUse('a2', 'accept', { proposal_seq: seq })]);
    });
    // Alex pauses as soon as the accept is written (before the prompts go out).
    const write = w.app.actionLog.write.bind(w.app.actionLog);
    w.app.actionLog.write = async (entry, q) => {
      await write(entry, q);
      if (!pausedOnce && entry.action === 'a2a.outcome_requested') {
        pausedOnce = true;
        await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' });
      }
    };
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(pausedOnce).toBe(true);
    expect(await isPaused(w, w.alex.agent.id)).toBe(true);
    const rows = await a2aMessages(w);
    expect(rows.map((r) => r.kind)).toContain('accept');
    await w.ownerSays(w.sam, 'yes');
    expect(creates(w)).toEqual([]);
    await w.ownerSays(w.alex, 'resume');
    await w.app.settle();
    // The prompt is still answerable after the resume. I19: the pause/resume acks sit between,
    // so the first bare yes gets the prompt again; the yes under it counts.
    const prompts = w.textsTo(w.alex.address).filter((t) => /Reply yes or no/i.test(t) && /Dinner/.test(t));
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    await w.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.alex.address)).toMatch(/^Just to be sure: #1 With Sam/);
    expect(creates(w)).toEqual([]);
    await w.ownerSays(w.alex, 'yes');
    expect(creates(w)).toHaveLength(2);
    expect(w.textsTo(w.sam.address).filter((t) => /^Booked/.test(t))).toHaveLength(1);
    expect(envoyCalls(w, w.alex).length).toBeGreaterThan(0);
  });
});

describe('Q5 round 2: the transcript command', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('only the bare word: "transcript please", "the transcript", "transcript 2" go to the Brain', async () => {
    w = await createTestWorld();
    let brainCalls = 0;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => {
      brainCalls += 1;
      return respond([{ type: 'text', text: 'ok' }]);
    });
    for (const t of ['transcript please', 'the transcript', 'transcript 2', '"transcript"']) await w.ownerSays(w.alex, t);
    expect(await w.actions({ action: 'a2a.transcript' })).toEqual([]);
    expect(brainCalls).toBe(4);
  });

  it('the transcript shown is of a conversation the owner is a party to, never another pair in the household', async () => {
    w = await createTestWorld();
    const robin = await createOwnerWithAgent(w.setup, { householdId: w.household.id, name: 'Robin', timezone: 'America/New_York', transport: 'fake', agentAddress: 'violet-robin', ownerAddress: 'robin-phone' });
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, () => [[toolUse('s', 'say', { text: 'Sam can do 7.' })], 'ok']);
    scriptEnvoy(w, w.alex, () => ['waiting']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    // A later conversation between Sam and Robin: Alex is not a party.
    w.llm.on({ agentId: w.sam.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('x', 'talk_to_agent', { with: 'Robin', topic: 'Secret gift for Alex', brief: 'Gift idea for Alex.' })])
        : respond([{ type: 'text', text: 'ok' }]),
    );
    w.llm.on({ agentId: robin.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'ok' }]));
    await w.ownerSays(w.sam, 'Ask Robin about a gift for Alex');
    const before = w.textsTo(w.alex.address).length;
    await w.ownerSays(w.alex, 'transcript');
    const sent = w.textsTo(w.alex.address).slice(before).join('\n');
    expect(sent).toMatch(/Transcript:/);
    expect(sent).not.toMatch(/gift/i);
  });
});

describe('Q8 round 2: first names that look the same', () => {
  let w: TestWorld;
  afterEach(async () => w.close());
  const add = (name: string, addr: string) =>
    createOwnerWithAgent(w.setup, { householdId: w.household.id, name, timezone: 'America/New_York', transport: 'fake', agentAddress: addr, ownerAddress: `${addr}-owner` });

  it('a zero-width or no-break character does not make a second "Sam"', async () => {
    w = await createTestWorld();
    await expect(add('Sam​', 'violet-zw')).rejects.toThrow(/already used in this household/);
    await expect(add('Sam Two', 'violet-nb')).rejects.toThrow(/already used in this household/);
    await expect(add('​Sam Three', 'violet-zw2')).rejects.toThrow(/already used in this household/);
  });
});

/**
 * Real Postgres, own race: the pause flip of Alex against, all at once, Alex's guidance on one
 * conversation, Alex's owner close of another, Sam's guidance on the first one (the other
 * agent's row and the same conversation row) and the a2a sweep. 20 iterations: no deadlock,
 * nothing but a 'paused' refusal, and every message of Alex's written in an iteration is
 * logged before that iteration's pause.
 */
const PG = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG)('Q1 round 2: pause vs several writers and the sweep at once (real Postgres)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('20 iterations', async () => {
    const { addGuidance, endByOwner, openConversation } = await import('../../../src/a2a/conversations.js');
    const { isRefusal } = await import('../../../src/a2a/deps.js');
    w = await createTestWorld();
    const robin = await createOwnerWithAgent(w.setup, { householdId: w.household.id, name: 'Robin', timezone: 'America/New_York', transport: 'fake', agentAddress: 'violet-robin', ownerAddress: 'robin-phone' });
    scriptEnvoy(w, w.sam, () => ['ok']);
    scriptEnvoy(w, w.alex, () => ['ok']);
    w.llm.on({ agentId: robin.agent.id, mind: 'envoy' }, () => respond([{ type: 'text', text: 'ok' }]));
    const app = w.app;
    const d = { db: w.db, clock: w.clock, jobs: app.jobs, actionLog: app.actionLog, flags: app.flags, repos: app.repos, gateway: app.gateway, approvals: app.approvals!, calendar: w.calendar, log: app.deps.log } as never;
    let n = 0;
    const say = (text: string) =>
      app.ingest({ transport: 'fake', kind: 'text', agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text, transportMessageId: `r2-${(n += 1)}`, receivedAt: w.clock.now() });
    const tally = { refused: 0, before: 0 };
    for (let i = 0; i < 20; i += 1) {
      await w.db.query(`UPDATE a2a_conversations SET status = 'closed' WHERE status <> 'closed'`);
      w.clock.advance({ hours: 3 });
      const a = (await openConversation(d, { initiator: w.alex.agent, responder: w.sam.agent, householdId: w.household.id, topic: 'A', brief: 'A?', window: null, key: `r2-a-${i}`, notice: false })).conv;
      const b = (await openConversation(d, { initiator: w.alex.agent, responder: robin.agent, householdId: w.household.id, topic: 'B', brief: 'B?', window: null, key: `r2-b-${i}`, notice: false })).conv;
      const from = (await w.db.query<{ id: number }>('SELECT coalesce(max(id), 0)::int AS id FROM action_log')).rows[0]!.id;
      const results = await Promise.allSettled([
        addGuidance(d, { agentId: w.alex.agent.id, conversationId: a.id, text: `Alex ${i}`, key: `r2-ga-${i}`, notice: false }),
        endByOwner(d, w.alex.agent.id, b.id),
        addGuidance(d, { agentId: w.sam.agent.id, conversationId: a.id, text: `Sam ${i}`, key: `r2-gs-${i}`, notice: false }),
        app.a2a!.sweep(),
        say('pause'),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          if (!isRefusal(r.reason) || r.reason.reason !== 'paused') throw r.reason;
          tally.refused += 1;
        }
      }
      const pausedAt = (await w.db.query<{ id: number }>(`SELECT id::int AS id FROM action_log WHERE action = 'agent.paused' ORDER BY id DESC LIMIT 1`)).rows[0]!.id;
      const alexMsgs = await w.db.query<{ id: number }>(`SELECT id::int AS id FROM action_log WHERE action IN ('a2a.message', 'a2a.closed') AND agent_id = $1 AND id > $2`, [w.alex.agent.id, from]);
      for (const m of alexMsgs.rows) expect(m.id).toBeLessThan(pausedAt);
      tally.before += alexMsgs.rows.length;
      // Sam is not paused: Sam's guidance always goes through.
      expect(results[2]!.status).toBe('fulfilled');
      await say('resume');
      await app.settle();
    }
    expect(tally.refused + tally.before).toBeGreaterThan(0);
  }, 300_000);
});
