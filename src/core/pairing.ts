import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** No 0/O/1/I to avoid misreading. 10 chars ≈ 50 bits. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export const PAIRING_TTL_MS = 24 * 3_600_000;

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function hashPairingCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

export function pairingCodeMatches(code: string, storedHash: string): boolean {
  const a = Buffer.from(hashPairingCode(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Extracts the code from "/start <code>", or null. */
export function parseStartCommand(text: string): string | null {
  const m = /^\/start(?:@\S+)?\s+(\S+)\s*$/i.exec(text.trim());
  return m?.[1] ?? null;
}
