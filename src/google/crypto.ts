import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * I16: refresh tokens at rest. AES-256-GCM, a random 12-byte IV per encryption, and
 * the owner id as associated data (a ciphertext copied to another owner's row does
 * not decrypt). Format: `v1.<iv>.<ciphertext>.<tag>`, each part base64url.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenKeyError extends Error {}
export class TokenDecryptError extends Error {}

/** TOKEN_ENC_KEY: exactly 32 bytes, standard base64 (e.g. `openssl rand -base64 32`). */
export function parseEncKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === '') throw new TokenKeyError('TOKEN_ENC_KEY is missing: set it to 32 random bytes, base64-encoded');
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) throw new TokenKeyError('TOKEN_ENC_KEY is not valid base64');
  const key = Buffer.from(s, 'base64');
  if (key.length !== 32) throw new TokenKeyError(`TOKEN_ENC_KEY must decode to 32 bytes (got ${key.length})`);
  return key;
}

export function encryptToken(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, ct, cipher.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptToken(key: Buffer, sealed: string, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenDecryptError('unsupported token ciphertext format');
  const [iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new TokenDecryptError('malformed token ciphertext');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenDecryptError('token ciphertext failed authentication (wrong TOKEN_ENC_KEY or tampered data)');
  }
}
