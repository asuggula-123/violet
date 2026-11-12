/**
 * Production without Google (gfix × M4): an agent-to-agent outcome both owners approve can never
 * be booked. Both owners are told plainly, nothing is (half-)booked, nothing retries forever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_CONFIGURED_REASON } from '../../../src/google/unconfigured.js';
import { contextOf, dinnerEvent, peerProposalSeq, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';
import { noGoogleWorld, type NoGoogleWorld } from '../gfix/helpers.js';

const FAILED = `Couldn't book “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”: ${NOT_CONFIGURED_REASON}. Nothing was booked.`;

describe('a2a outcome in production without Google', () => {
  let n: NoGoogleWorld;
  afterEach(async () => n.close());

  it('both yes: both owners told the reason, no live calendar write, conversation reopened, no booked flag, nothing left to retry', async () => {
    n = await noGoogleWorld();
    const { w } = n;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
      stepOf(req) === 0
        ? respond([toolUse('b1', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief: 'Dinner with Sam on Friday evening' })])
        : respond([{ type: 'text', text: 'On it.' }]),
    );
    scriptEnvoy(w, w.sam, (req) => (/You proposed/.test(contextOf(req)) ? ['nothing to add'] : [[toolUse('s1', 'propose', { summary: 'Dinner on Friday at 7', events: [dinnerEvent()] })], 'done']));
    scriptEnvoy(w, w.alex, (req) => {
      const seq = peerProposalSeq(req);
      return seq === null ? ['waiting'] : [[toolUse('a1', 'accept', { proposal_seq: seq })], 'done'];
    });

    await n.ownerSays(w.alex, 'Dinner with Sam on Friday evening');
    // The EgressGuard cannot read the calendar, so the release is held for the owner's yes (I11).
    expect(w.textsTo(w.alex.address)).toEqual(['On it.', expect.stringMatching(/^#1 Tell Sam's Violet about “Dinner Friday”: .* Send\? Reply yes or no\.$/)]);
    await n.ownerSays(w.alex, 'yes');
    expect(w.lastTo(w.sam.address)).toMatch(/^#1 With Alex: “Dinner” .* Book it\? Reply yes or no\.$/);
    await n.ownerSays(w.alex, 'yes 2');
    expect(w.lastTo(w.alex.address)).toBe('Waiting for Sam.');

    await n.ownerSays(w.sam, 'yes');
    expect(w.lastTo(w.sam.address)).toBe(FAILED);
    expect(w.lastTo(w.alex.address)).toBe(FAILED);
    for (const p of [w.alex, w.sam]) expect(w.textsTo(p.address).some((t) => t.startsWith('Booked'))).toBe(false);

    const live = await w.db.query(`SELECT 1 FROM calendar_writes WHERE deleted_at IS NULL OR event_id IS NOT NULL`);
    expect(live.rowCount).toBe(0);
    expect(await w.actions({ action: 'calendar.event_created' })).toEqual([]);
    expect(await w.actions({ action: 'calendar.event_deleted' })).toEqual([]);
    const conv = (await w.db.query<{ status: string; outcome_state: string | null }>('SELECT status, outcome_state FROM a2a_conversations')).rows;
    expect(conv).toEqual([{ status: 'open', outcome_state: null }]);
    expect((await w.actions({ action: 'a2a.booking_failed' })).map((a) => a.detail)).toEqual([expect.objectContaining({ slotGone: false, undoPending: false })]);
    for (const p of [w.alex, w.sam]) {
      const kinds = (await w.app.repos.flags.listByAgent(p.agent.id)).map((f) => f.kind);
      expect(kinds).not.toContain('booked');
      expect(kinds).not.toContain('a2a_booked');
    }

    // Nothing retries: no job left, and the sweeps over the next hours text nobody.
    const sent = w.transport.sent.length;
    await n.advance({ hours: 3 });
    expect((await w.db.query(`SELECT type, status FROM jobs WHERE status <> 'done'`)).rows).toEqual([]);
    expect(w.transport.sent.length).toBe(sent);
  });
});
