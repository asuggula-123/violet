import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANNED, OWNER_TEXT } from '../../src/core/canned.js';
import { hashPairingCode, parseStartCommand } from '../../src/core/pairing.js';
import { createOwnerWithAgent, type CreatedOwner } from '../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('pairing (flow 8.1 step 3)', () => {
  let w: TestWorld;
  let created: CreatedOwner;
  let code: string;
  const agentAddress = 'violet-new';
  const phone = 'new-owner-phone';

  beforeEach(async () => {
    w = await createTestWorld();
    created = await createOwnerWithAgent(w.setup, {
      householdId: w.household.id,
      name: 'Alex',
      timezone: 'Europe/London',
      transport: 'fake',
      agentAddress,
    });
    code = created.pairingCode!;
  });
  afterEach(async () => w.close());

  async function say(from: string, text: string) {
    await w.inbound({ agentAddress, fromAddress: from, text });
    await w.app.settle();
  }

  async function ownerAddress() {
    return (await w.app.repos.agents.get(created.agent.id))?.owner_address ?? null;
  }

  it('stores only a hash of the code', async () => {
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    const row = await w.db.query<{ pairing_code_hash: string }>('SELECT pairing_code_hash FROM agents WHERE id = $1', [created.agent.id]);
    expect(row.rows[0]?.pairing_code_hash).toBe(hashPairingCode(code));
    const dump = JSON.stringify((await w.db.query('SELECT * FROM agents')).rows);
    expect(dump).not.toContain(code);
    const log = JSON.stringify(await w.actions());
    expect(log).not.toContain(code);
  });

  it('the right code binds the sender as owner and acks once', async () => {
    await say(phone, `/start ${code}`);
    expect(await ownerAddress()).toBe(phone);
    expect(w.textsTo(phone)).toEqual([OWNER_TEXT.paired]);
    const after = await w.db.query<{ h: string | null }>('SELECT pairing_code_hash AS h FROM agents WHERE id = $1', [created.agent.id]);
    expect(after.rows[0]?.h).toBeNull();
    expect(await w.actions({ action: 'pairing.bound', agentId: created.agent.id })).toHaveLength(1);

    await say(phone, 'hello');
    expect(w.lastTo(phone)).toBe(OWNER_TEXT.notSetUp);
  });

  it('accepts the code case-insensitively', async () => {
    await say(phone, `/start ${code.toLowerCase()}`);
    expect(await ownerAddress()).toBe(phone);
  });

  it('a wrong code falls through to the stranger flow', async () => {
    await say(phone, '/start WRONGCODE2');
    expect(await ownerAddress()).toBeNull();
    expect(w.textsTo(phone)).toEqual([CANNED.stranger_reply]);
    const failed = await w.actions({ action: 'pairing.failed' });
    expect(failed.map((a) => a.detail.reason)).toEqual(['wrong_code']);
  });

  it('a missing code falls through to the stranger flow', async () => {
    await say(phone, '/start');
    expect(await ownerAddress()).toBeNull();
    expect(w.textsTo(phone)).toEqual([CANNED.stranger_reply]);
  });

  it('an expired code falls through to the stranger flow', async () => {
    w.clock.advance({ hours: 24, seconds: 1 });
    await say(phone, `/start ${code}`);
    expect(await ownerAddress()).toBeNull();
    expect(w.textsTo(phone)).toEqual([CANNED.stranger_reply]);
    const failed = await w.actions({ action: 'pairing.failed' });
    expect(failed.map((a) => a.detail.reason)).toEqual(['expired']);
  });

  it('an already-paired agent treats /start from anyone else as a stranger', async () => {
    await say(phone, `/start ${code}`);
    await say('intruder', `/start ${code}`);
    expect(await ownerAddress()).toBe(phone);
    expect(w.textsTo('intruder')).toEqual([CANNED.stranger_reply]);
  });

  it('an agent created with a preset owner address has no pairing code', async () => {
    expect(w.alex.agent.owner_address).toBe('alex-phone');
    expect(w.alex.agent.pairing_code_hash).toBeNull();
    await w.strangerSays(w.alex, 'someone', '/start ANYTHING22');
    expect(w.textsTo('someone')).toEqual([CANNED.stranger_reply]);
    expect((await w.app.repos.agents.get(w.alex.agent.id))?.owner_address).toBe('alex-phone');
  });

  it('parses the start command', () => {
    expect(parseStartCommand('/start ABC')).toBe('ABC');
    expect(parseStartCommand('  /START abc  ')).toBe('abc');
    expect(parseStartCommand('/start@violet_bot ABC')).toBe('ABC');
    expect(parseStartCommand('/start')).toBeNull();
    expect(parseStartCommand('/start A B')).toBeNull();
    expect(parseStartCommand('please /start ABC')).toBeNull();
  });
});
