import { addMs, type Clock } from '../clock.js';
import type { Db } from '../db/db.js';
import type { ActionLog, Actor } from './actionLog.js';
import { generatePairingCode, hashPairingCode, PAIRING_TTL_MS } from './pairing.js';
import { createRepos } from './repos/index.js';
import type { AgentRow } from './types.js';

export class UnknownAgentError extends Error {
  override readonly name = 'UnknownAgentError';
  constructor(agentId: string) {
    super(`Unknown agent ${agentId}`);
  }
}

export class AlreadyPairedError extends Error {
  override readonly name = 'AlreadyPairedError';
  constructor(agentId: string) {
    super(`Agent ${agentId} is already paired. Pass --reset to unpair it and issue a new code.`);
  }
}

export interface ReissueCtx {
  db: Db;
  clock: Clock;
  actionLog: ActionLog;
}

export interface Reissued {
  agent: AgentRow;
  /** Plain one-time code. Only its hash is stored. */
  code: string;
  /** True when --reset unpaired the previous owner chat. */
  unpaired: boolean;
}

/**
 * Issues a fresh pairing code for an agent, replacing (at once) any code it had. A paired
 * agent is refused unless `reset`: then the owner address is forgotten first, so the old
 * chat is a stranger from the next message on (I1). One transaction under the agent row
 * lock; logs `pairing.reset` and `pairing.code_issued` (never the code or its hash).
 */
export async function reissuePairingCode(
  ctx: ReissueCtx,
  agentId: string,
  opts: { reset?: boolean; actor?: Actor; ttlMs?: number } = {},
): Promise<Reissued> {
  const actor = opts.actor ?? 'cli';
  return ctx.db.tx(async (tx) => {
    const repos = createRepos(tx, ctx.clock);
    const found = await repos.agents.getForUpdate(agentId);
    if (!found) throw new UnknownAgentError(agentId);
    const wasPaired = found.owner_address !== null;
    if (wasPaired) {
      if (!opts.reset) throw new AlreadyPairedError(agentId);
      await repos.agents.unbindOwner(found.id);
      await repos.contacts.demoteOwner(found.id, found.transport, found.owner_address!);
      await ctx.actionLog.write({ agentId: found.id, actor, action: 'pairing.reset' }, tx);
    }
    const now = ctx.clock.now();
    const replaced = !found.pairing_code_hash || !found.pairing_expires_at ? 'none' : found.pairing_expires_at.getTime() <= now.getTime() ? 'expired' : 'active';
    const code = generatePairingCode();
    const expiresAt = addMs(now, opts.ttlMs ?? PAIRING_TTL_MS);
    // Under the row lock this cannot fail; if it ever does, roll back rather than print a code.
    if (!(await repos.agents.setPairingCode(found.id, hashPairingCode(code), expiresAt))) {
      throw new Error(`Could not store a new pairing code for agent ${found.id}`);
    }
    await ctx.actionLog.write(
      { agentId: found.id, actor, action: 'pairing.code_issued', detail: { expiresAt: expiresAt.toISOString(), reissued: true, replaced } },
      tx,
    );
    const agent = (await repos.agents.get(found.id))!;
    return { agent, code, unpaired: wasPaired };
  });
}
