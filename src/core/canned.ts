/**
 * Fixed texts. Nothing here may mention an owner, their name or any of their data (I3).
 */

/** Texts that may be sent to a non-owner through OutboundGateway.sendCanned (I4). */
export type CannedKey = 'stranger_reply';

export const CANNED: Readonly<Record<CannedKey, string>> = Object.freeze({
  stranger_reply:
    "Hi, I'm Violet, an AI assistant. I've taken your message and it will be passed on. I can't share any other information.",
});

export function cannedText(key: CannedKey): string {
  return CANNED[key];
}

/** Fixed texts for the owner thread. */
export const OWNER_TEXT = Object.freeze({
  paused: "Paused. I won't send anything to anyone until you say resume.",
  alreadyPaused: 'Already paused. Say resume to continue.',
  resumed: "Resumed. I'm back on.",
  notPaused: "I'm not paused.",
  paired: "Hi, I'm Violet, your assistant. You're connected now.",
  notSetUp: "I'm not fully set up yet.",
  textOnly: 'I can only read text for now.',
});
