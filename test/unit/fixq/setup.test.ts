/** Q8: a first name is used once per household (owner:add / createOwnerWithAgent refuse a second one). */
import { afterEach, describe, expect, it } from 'vitest';
import { assertFirstNameFree, createHousehold, createOwnerWithAgent } from '../../../src/core/setup.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

describe('Q8: household first names are unique', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  const add = (householdId: string, name: string, addr: string) =>
    createOwnerWithAgent(w.setup, { householdId, name, timezone: 'America/New_York', transport: 'fake', agentAddress: addr, ownerAddress: `${addr}-owner` });

  it('refuses a second "Sam" in any case or spacing, writes nothing, and allows the name in another household', async () => {
    w = await createTestWorld();
    const count = async () => (await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM owners')).rows[0]!.n;
    const before = await count();
    for (const name of ['Sam', 'sam two', ' SAM  ']) {
      await expect(add(w.household.id, name, `x-${name.trim().replace(/\s+/g, '-')}`)).rejects.toThrow('The first name "');
    }
    expect(await count()).toBe(before);
    expect(await w.actions({ action: 'owner.created' })).toHaveLength(2); // Alex and Sam only
    await add(w.household.id, 'Robin', 'violet-robin');
    const other = await createHousehold(w.setup, 'Other');
    await add(other.id, 'Sam', 'violet-sam-other');
    expect(await count()).toBe(before + 2);
  });
});

describe('Q8: assertFirstNameFree', () => {
  it('the rule matches how agents name owners: the first word, any case', () => {
    expect(() => assertFirstNameFree('Sam Two', [{ name: 'Alex' }])).not.toThrow();
    expect(() => assertFirstNameFree('Sam Two', [{ name: 'sam' }])).toThrow('The first name "Sam" is already used in this household (by "sam")');
    expect(() => assertFirstNameFree('Samantha', [{ name: 'Sam' }])).not.toThrow();
  });
});
