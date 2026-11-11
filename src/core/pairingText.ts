import { telegramPairingInstructions } from '../transport/telegram/pairing.js';
import type { TransportName } from '../transport/types.js';

/** What owner:add and pairing:reissue print for a new code (the code is shown only here). */
export function pairingCodeLines(code: string, expiresAt: Date | null, transport: TransportName, botUsername?: string): string[] {
  const lines = [`Pairing code (shown once, expires ${expiresAt?.toISOString()}):`, `  /start ${code}`];
  if (transport === 'telegram') lines.push('', ...telegramPairingInstructions(code, botUsername));
  return lines;
}
