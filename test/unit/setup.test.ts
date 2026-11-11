import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHousehold, createOwnerWithAgent } from '../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('setup helpers', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  it('the test world has Alex and Sam in one household with preset owner addresses', async () => {
    expect(w.alex.owner.household_id).toBe(w.household.id);
    expect(w.sam.owner.household_id).toBe(w.household.id);
    expect([w.alex.agent.name, w.sam.agent.name]).toEqual(['Violet', 'Violet']);
    expect([w.alex.agent.owner_address, w.sam.agent.owner_address]).toEqual(['alex-phone', 'sam-phone']);
    expect(w.alex.owner.digest_hour).toBe(18);
  });

  it('creates an owner with an unpaired agent and a one-time code', async () => {
    const home = await createHousehold(w.setup, 'Second home');
    const created = await createOwnerWithAgent(w.setup, {
      householdId: home.id,
      name: 'Sam',
      timezone: 'Europe/Berlin',
      transport: 'fake',
      agentAddress: 'violet-2',
    });
    expect(created.pairingCode).toMatch(/^[A-Z2-9]{10}$/);
    expect(created.agent.owner_address).toBeNull();
    expect(created.agent.pairing_expires_at).toEqual(new Date(w.clock.now().getTime() + 24 * 3_600_000));
    expect(await w.actions({ action: 'pairing.code_issued', agentId: created.agent.id })).toHaveLength(1);
    expect(await w.actions({ action: 'owner.created', agentId: created.agent.id })).toHaveLength(1);
  });

  it('rejects an unknown timezone, an unknown household and a duplicate agent address', async () => {
    const base = { householdId: w.household.id, name: 'Alex', transport: 'fake' as const };
    await expect(createOwnerWithAgent(w.setup, { ...base, timezone: 'Mars/Base', agentAddress: 'v-x' })).rejects.toThrow(/timezone/);
    await expect(createOwnerWithAgent(w.setup, { ...base, householdId: 'nope', timezone: 'UTC', agentAddress: 'v-y' })).rejects.toThrow(
      /household/,
    );
    await expect(createOwnerWithAgent(w.setup, { ...base, timezone: 'UTC', agentAddress: w.alex.agentAddress })).rejects.toThrow();
  });
});
