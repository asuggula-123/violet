/**
 * Pause × agent-to-agent (glue × M4, I14 / 8.6): while paused nothing but the ack is texted —
 * no Envoy turn, no notice, no digest; after resume the waiting Envoy turn runs, held notices are
 * sent, and the a2a digest flags raised meanwhile are in the next digest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, envoyCalls, honestDinnerEnvoys } from '../a2a/helpers.js';

describe('a2a while the responder is paused', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('silent while paused; resumes the conversation, the held notice and the digest lines after resume', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    const sam = () => w.textsTo(w.sam.address);

    await w.ownerSays(w.sam, 'pause');
    const ack = sam();
    expect(ack).toHaveLength(1);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    expect(envoyCalls(w, w.sam)).toEqual([]);
    await w.advance({ hours: 14 }); // Monday 18:00: Sam's digest is deferred while paused
    expect(sam()).toEqual(ack);
    expect((await w.actions({ action: 'digest.deferred', agentId: w.sam.agent.id })).map((a) => a.detail.reason)).toContain('paused');

    await w.ownerSays(w.sam, 'resume');
    // The waiting Envoy turn ran: proposal, Alex's accept, and Sam's prompt right after the ack.
    expect(sam().slice(ack.length)).toEqual([expect.any(String), expect.stringMatching(/^#1 With Alex: “Dinner”/)]);

    await w.ownerSays(w.sam, 'pause');
    const paused = sam().length;
    await w.ownerSays(w.alex, 'no');
    expect(sam()).toHaveLength(paused); // "Alex said no to: …" waits
    await w.ownerSays(w.sam, 'resume');
    expect(sam().slice(paused)).toEqual([expect.any(String), 'Alex said no to: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi\'s”. Nothing was booked.']);

    await w.advance({ hours: 24 }); // Tuesday 18:00: the opened line raised while paused is in the digest
    const digest = sam().filter((t) => t.startsWith('Today:'));
    expect(digest).toHaveLength(1);
    expect(digest[0]).toContain("Agent conversations\n- Alex's Violet started a conversation with your Violet about “Dinner Friday”.");
  });
});
