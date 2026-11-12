/**
 * I19 ground truth for "directly above": the transport's own numbering of a chat. In a
 * Telegram private chat every message, in either direction, takes the next message_id, so
 * outbound '<chat>:<n>' is directly above inbound '<chat>:<n + 1>'. Never stored row order.
 * Unknown, malformed, another chat or any gap → not above (fail closed).
 */
const ID = /^(.+):(0|[1-9]\d{0,19})$/;

export interface ChatPosition {
  chat: string;
  n: bigint;
}

/** '<chat>:<n>' → its parts, or null when it is not in that shape. */
export function chatPosition(id: string | null | undefined): ChatPosition | null {
  const m = id ? ID.exec(id) : null;
  return m ? { chat: m[1]!, n: BigInt(m[2]!) } : null;
}

/** Whether outbound transport id `outboundId` is the message directly above inbound `chatMessageId`. */
export function isDirectlyAbove(outboundId: string | null | undefined, chatMessageId: string | null | undefined): boolean {
  const out = chatPosition(outboundId);
  const msg = chatPosition(chatMessageId);
  return out !== null && msg !== null && out.chat === msg.chat && msg.n === out.n + 1n;
}

/** The ids of the `count` messages above `chatMessageId`, nearest first ([] if unknown). */
export function idsAbove(chatMessageId: string | null | undefined, count: number): string[] {
  const p = chatPosition(chatMessageId);
  const ids: string[] = [];
  for (let k = 1n; p && ids.length < count && p.n - k >= 0n; k += 1n) ids.push(`${p.chat}:${p.n - k}`);
  return ids;
}
