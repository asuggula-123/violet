import { addMs, type Clock } from '../clock.js';
import { firstName } from '../a2a/repo.js';
import type { TransportName } from '../transport/types.js';
import type { ActionLog, Actor } from './actionLog.js';
import { generatePairingCode, hashPairingCode, PAIRING_TTL_MS } from './pairing.js';
import type { Repos } from './repos/index.js';
import type { AgentRow, HouseholdRow, OwnerRow } from './types.js';

export interface SetupCtx {
  repos: Repos;
  actionLog: ActionLog;
  clock: Clock;
}

export async function createHousehold(ctx: SetupCtx, name: string, actor: Actor = 'system'): Promise<HouseholdRow> {
  const household = await ctx.repos.households.create(name);
  await ctx.actionLog.write({ actor, action: 'household.created', detail: { householdId: household.id } });
  return household;
}

export interface NewOwnerWithAgent {
  householdId: string;
  name: string;
  timezone: string;
  transport: TransportName;
  agentAddress: string;
  /** Preset the owner's address (no pairing needed). */
  ownerAddress?: string;
  digestHour?: number;
  pairingTtlMs?: number;
}

export interface CreatedOwner {
  owner: OwnerRow;
  agent: AgentRow;
  /** Plain one-time pairing code, or null when ownerAddress was preset. Only its hash is stored. */
  pairingCode: string | null;
}

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

/**
 * Multi-owner: agents and every code-written line name another owner by first name
 * (`Sam's Violet`), so a first name (as `firstNameKey` compares it) is used once per household.
 */
/**
 * The key two first names are compared by: NFKC (a decomposed accent, a full-width or other
 * compatibility form looks the same as the plain one, so it is the same name), then any case.
 */
export function firstNameKey(name: string): string {
  return firstName(name.normalize('NFKC')).normalize('NFKC').toLowerCase();
}

export function assertFirstNameFree(name: string, members: Array<Pick<OwnerRow, 'name'>>): void {
  const key = firstNameKey(name);
  const taken = members.find((m) => firstNameKey(m.name) === key);
  if (taken) {
    throw new Error(
      `The first name "${firstName(name)}" is already used in this household (by "${taken.name}"). Agents tell owners apart by first name, so pick a different first name.`,
    );
  }
}

export async function createOwnerWithAgent(ctx: SetupCtx, input: NewOwnerWithAgent, actor: Actor = 'system'): Promise<CreatedOwner> {
  assertTimezone(input.timezone);
  const household = await ctx.repos.households.get(input.householdId);
  if (!household) throw new Error(`Unknown household ${input.householdId}`);
  assertFirstNameFree(input.name, await ctx.repos.owners.inHousehold(household.id));
  const owner = await ctx.repos.owners.create({
    householdId: household.id,
    name: input.name,
    timezone: input.timezone,
    ...(input.digestHour !== undefined ? { digestHour: input.digestHour } : {}),
  });
  const pairingCode = input.ownerAddress ? null : generatePairingCode();
  const agent = await ctx.repos.agents.create({
    ownerId: owner.id,
    transport: input.transport,
    agentAddress: input.agentAddress,
    ownerAddress: input.ownerAddress ?? null,
    pairingCodeHash: pairingCode ? hashPairingCode(pairingCode) : null,
    pairingExpiresAt: pairingCode ? addMs(ctx.clock.now(), input.pairingTtlMs ?? PAIRING_TTL_MS) : null,
  });
  await ctx.actionLog.write({
    agentId: agent.id,
    actor,
    action: 'owner.created',
    detail: { ownerId: owner.id, householdId: household.id, transport: agent.transport, preset: !pairingCode },
  });
  if (pairingCode) {
    await ctx.actionLog.write({
      agentId: agent.id,
      actor,
      action: 'pairing.code_issued',
      detail: { expiresAt: agent.pairing_expires_at?.toISOString() ?? null },
    });
  }
  return { owner, agent, pairingCode };
}
