import type { ActionLog } from './actionLog.js';
import type { OutboundGateway } from './outbound.js';
import type { Repos } from './repos/index.js';
import { sanitize } from './sanitize.js';
import type { FlagRow, FlagUrgency } from './types.js';

export interface FlagInput {
  kind: string;
  urgency: FlagUrgency;
  text: string;
  dedupeKey?: string;
}

export interface FlagService {
  raise(agentId: string, f: FlagInput): Promise<void>;
}

/** How a pending 'now' flag is delivered. M5 (src/flags/policy.ts) installs the I17 policy. */
export type NowDelivery = (flag: FlagRow) => Promise<void>;

/** The app's FlagService plus the hook a module uses to replace 'now' delivery. */
export interface FlagHub extends FlagService {
  setNowDelivery(deliver: NowDelivery): void;
}

export const FLAG_MAX_LENGTH = 500;

/**
 * Basic flags (M1): 'now' goes to the owner at once, 'digest' is stored pending.
 * Raising with a dedupeKey already used for this agent adds nothing; if that flag is a
 * 'now' flag still pending (its send failed), the raise retries the delivery.
 * The same object keeps working after flagsModule swaps the 'now' delivery for the
 * I17 policy (budget, quiet hours, pause), so callers that captured it need no re-wiring.
 */
export function createFlagService(deps: { repos: Repos; gateway: OutboundGateway; actionLog: ActionLog }): FlagHub {
  const { repos, gateway, actionLog } = deps;
  const sendAtOnce: NowDelivery = async (flag) => {
    const sent = await gateway.sendToOwner(flag.agent_id, flag.text, { purpose: 'flag' });
    await repos.flags.setStatus(flag.id, sent ? 'sent' : 'suppressed');
  };
  let deliverNow = sendAtOnce;
  return {
    setNowDelivery(deliver) {
      deliverNow = deliver;
    },
    async raise(agentId, f) {
      const text = sanitize(f.text, FLAG_MAX_LENGTH);
      let flag = await repos.flags.insert({ agentId, kind: f.kind, urgency: f.urgency, text, ...(f.dedupeKey ? { dedupeKey: f.dedupeKey } : {}) });
      if (flag) {
        await actionLog.write({
          agentId,
          actor: 'system',
          action: 'flag.raised',
          detail: { flagId: flag.id, kind: f.kind, urgency: f.urgency },
        });
      } else {
        // Raised before (I18): a retried raise finishes the delivery a failed send left
        // undone, and does nothing once the flag is sent, suppressed or a digest item.
        flag = f.dedupeKey ? await repos.flags.findByDedupeKey(agentId, f.dedupeKey) : null;
        if (!flag || flag.status !== 'pending') return;
      }
      if (flag.urgency !== 'now') return;
      await deliverNow(flag);
    },
  };
}
