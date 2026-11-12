import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Db, Queryable } from '../db/db.js';
import { idsAbove } from '../transport/chatOrder.js';

export type DeliveryKind = 'prompt' | 'reprompt' | 'which_one';

/** How far up RUN(m) is walked: more than any "Which one?" re-sends (WHICH_ONE_LIMIT). */
export const RUN_MAX = 20;

/** Thrown inside a claim transaction to roll the whole claim back. */
class ClaimLost extends Error {}

/**
 * approval_deliveries (I19): the messages the approvals service itself sent as the prompt
 * of exactly one approval. Whether a message is a genuine prompt is decided only here.
 */
export function deliveriesRepo(db: Queryable, clock: Clock) {
  return {
    /** The first delivery of an approval (inside markSent's transaction). */
    async recordFirst(agentId: string, approvalId: string, transportMessageId: string): Promise<void> {
      await db.query(
        `INSERT INTO approval_deliveries (id, agent_id, approval_id, kind, transport_message_id, for_message_id, created_at)
         VALUES ($1, $2, $3, 'prompt', $4, NULL, $5) ON CONFLICT DO NOTHING`,
        [randomUUID(), agentId, approvalId, transportMessageId, clock.now()],
      );
    },
    /** The approval whose genuine delivery is `transportMessageId`, or null. */
    async approvalOf(agentId: string, transportMessageId: string): Promise<string | null> {
      const res = await db.query<{ approval_id: string }>(
        'SELECT approval_id FROM approval_deliveries WHERE agent_id = $1 AND transport_message_id = $2',
        [agentId, transportMessageId],
      );
      return res.rows[0]?.approval_id ?? null;
    },
    /** Whether owner message `messageId` already caused a re-prompt or "Which one?" (claimed, sent or not). */
    async claimedFor(agentId: string, messageId: string): Promise<boolean> {
      const res = await db.query('SELECT 1 FROM approval_deliveries WHERE agent_id = $1 AND for_message_id = $2 LIMIT 1', [agentId, messageId]);
      return res.rows.length > 0;
    },
    /**
     * RUN(m): the approvals delivered in the unbroken run of genuine deliveries directly
     * above the message with chat number `chatMessageId`, nearest first. The walk starts at
     * the message directly above and stops at the first that is not a recorded delivery of
     * this agent (or is unknown). Pinned to m's own number, so a retry never sees its own re-sends.
     */
    async run(agentId: string, chatMessageId: string | undefined): Promise<string[]> {
      const above = idsAbove(chatMessageId, RUN_MAX);
      if (above.length === 0) return [];
      const res = await db.query<{ approval_id: string; transport_message_id: string }>(
        'SELECT approval_id, transport_message_id FROM approval_deliveries WHERE agent_id = $1 AND transport_message_id = ANY($2::text[])',
        [agentId, above],
      );
      const byId = new Map(res.rows.map((r) => [r.transport_message_id, r.approval_id]));
      const run: string[] = [];
      for (const id of above) {
        const approvalId = byId.get(id);
        if (!approvalId) break;
        run.push(approvalId);
      }
      return run;
    },
    async markSent(agentId: string, forMessageId: string, approvalId: string, transportMessageId: string): Promise<void> {
      await db.query(
        `UPDATE approval_deliveries SET transport_message_id = $4
         WHERE agent_id = $1 AND for_message_id = $2 AND approval_id = $3 AND transport_message_id IS NULL`,
        [agentId, forMessageId, approvalId, transportMessageId],
      );
    },
  };
}

/**
 * Claims the re-sends of owner message `forMessageId`: one row per approval, all or none, in
 * one transaction (rows in the order given, so concurrent claimers never deadlock). Only an
 * approval still pending and unexpired can be claimed. Returns false when any row exists
 * already or an approval closed meanwhile: then nothing is sent (at most one re-send per (m, A)).
 */
export async function claimDeliveries(db: Db, clock: Clock, agentId: string, forMessageId: string, approvalIds: string[], kind: DeliveryKind): Promise<boolean> {
  try {
    await db.tx(async (tx) => {
      for (const approvalId of approvalIds) {
        const res = await tx.query(
          `INSERT INTO approval_deliveries (id, agent_id, approval_id, kind, transport_message_id, for_message_id, created_at)
           SELECT $1, $2, a.id, $4, NULL, $5, $6 FROM approvals a
           WHERE a.id = $3 AND a.agent_id = $2 AND a.status = 'pending' AND a.expires_at > $6
           ON CONFLICT (for_message_id, approval_id) DO NOTHING`,
          [randomUUID(), agentId, approvalId, kind, forMessageId, clock.now()],
        );
        if (res.rowCount !== 1) throw new ClaimLost();
      }
    });
    return true;
  } catch (err) {
    if (err instanceof ClaimLost) return false;
    throw err;
  }
}
