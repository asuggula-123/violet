import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEXT } from '../../../src/core/canned.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { at, digestsTo, local, NY } from '../flags/helpers.js';

/** 8.6: a stranger's message taken while paused is silent (I14) but reaches the first digest after resume. */
describe('stranger messages while paused (8.6)', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld({ start: local(NY, '2026-11-09T10:00') });
  });
  afterEach(async () => w.close());

  const STRANGER = '+15550002';
  const TAKEN = 'Message from “+15550002”: “Is Alex around?”';

  it('paused: nothing is sent anywhere; after resume the next digest lists the message once', async () => {
    await w.ownerSays(w.alex, 'pause');
    await w.strangerSays(w.alex, STRANGER, 'Is Alex around?');
    expect(w.transport.sent.map((m) => [m.toAddress, m.text])).toEqual([[w.alex.address, OWNER_TEXT.paused]]);
    expect(await w.actions({ action: 'inbound.held' })).toHaveLength(1);

    // Still paused at digest_hour: no digest.
    await at(w, '2026-11-09T18:00');
    expect(digestsTo(w, w.alex)).toEqual([]);
    expect(w.textsTo(STRANGER)).toEqual([]);

    await w.ownerSays(w.alex, 'resume');
    await at(w, '2026-11-09T19:00');
    expect(digestsTo(w, w.alex)).toEqual([`Today:\nMessages taken\n- ${TAKEN}`]);
    // No canned reply after resume either: the stranger hears nothing for a held message.
    expect(w.textsTo(STRANGER)).toEqual([]);

    // Listed once: the next date's digest does not repeat it.
    await at(w, '2026-11-10T18:00');
    expect(digestsTo(w, w.alex)).toHaveLength(1);
  });

  it('a message that arrived paused but is processed after resume stays silent and is still listed', async () => {
    await w.ownerSays(w.alex, 'pause');
    await w.inbound({ agentAddress: w.alex.agentAddress, fromAddress: STRANGER, text: 'Is Alex around?' });
    await w.ownerSays(w.alex, 'resume');
    expect(w.textsTo(STRANGER)).toEqual([]);
    expect(await w.app.digest!.preview(w.alex.agent.id)).toBe(`Today:\nMessages taken\n- ${TAKEN}`);
  });

  it('a retried job (the flag step failed once) holds once and flags once', async () => {
    await w.ownerSays(w.alex, 'pause');
    const raise = w.app.flags.raise.bind(w.app.flags);
    let fail = true;
    w.app.flags.raise = async (agentId, f) => {
      if (fail) {
        fail = false;
        throw new Error('db hiccup');
      }
      return raise(agentId, f);
    };
    await w.strangerSays(w.alex, STRANGER, 'Is Alex around?');
    const job = await w.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'inbound.process' ORDER BY seq DESC LIMIT 1`);
    expect(job.rows[0]!.status).toBe('failed');
    for (let i = 0; i < 5; i += 1) await w.advance({ minutes: 1 });
    const done = await w.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'inbound.process' ORDER BY seq DESC LIMIT 1`);
    expect(done.rows[0]!.status).toBe('done');
    expect(await w.actions({ action: 'inbound.held' })).toHaveLength(1);
    expect(await w.actions({ action: 'inbound.received', agentId: w.alex.agent.id })).toHaveLength(2);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).map((f) => [f.kind, f.text])).toEqual([['message_taken', TAKEN]]);
    expect(w.transport.sent).toHaveLength(1);
  });
});
