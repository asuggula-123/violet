import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, parseEncKey, TokenDecryptError, TokenKeyError } from '../../../src/google/crypto.js';

const key = randomBytes(32);

describe('refresh-token encryption (I16)', () => {
  it('round-trips, with a fresh IV every time', () => {
    const a = encryptToken(key, 'refresh-1', 'owner-a');
    const b = encryptToken(key, 'refresh-1', 'owner-a');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('refresh-1');
    expect(decryptToken(key, a, 'owner-a')).toBe('refresh-1');
    expect(decryptToken(key, b, 'owner-a')).toBe('refresh-1');
    const ivs = new Set(Array.from({ length: 50 }, () => encryptToken(key, 'x', 'o').split('.')[1]));
    expect(ivs.size).toBe(50);
    expect(Buffer.from(a.split('.')[1]!, 'base64url')).toHaveLength(12);
  });

  it('detects tampering with any part', () => {
    const sealed = encryptToken(key, 'refresh-1', 'owner-a');
    const parts = sealed.split('.');
    for (const i of [1, 2, 3]) {
      const bytes = Buffer.from(parts[i]!, 'base64url');
      bytes[0] = bytes[0]! ^ 1;
      const forged = parts.map((p, j) => (j === i ? bytes.toString('base64url') : p)).join('.');
      expect(() => decryptToken(key, forged, 'owner-a')).toThrow(TokenDecryptError);
    }
  });

  it('refuses a ciphertext moved to another owner (associated data)', () => {
    const sealed = encryptToken(key, 'refresh-1', 'owner-a');
    expect(() => decryptToken(key, sealed, 'owner-b')).toThrow(TokenDecryptError);
  });

  it('refuses the wrong key with a clear message', () => {
    const sealed = encryptToken(key, 'refresh-1', 'owner-a');
    expect(() => decryptToken(randomBytes(32), sealed, 'owner-a')).toThrow(/wrong TOKEN_ENC_KEY or tampered/);
  });

  it('refuses unknown versions and malformed strings', () => {
    const sealed = encryptToken(key, 'refresh-1', 'owner-a');
    expect(() => decryptToken(key, sealed.replace(/^v1/, 'v2'), 'owner-a')).toThrow(/unsupported/);
    expect(() => decryptToken(key, 'garbage', 'owner-a')).toThrow(TokenDecryptError);
    expect(() => decryptToken(key, 'v1.AA.AA.AA', 'owner-a')).toThrow(/malformed/);
  });

  it('parses TOKEN_ENC_KEY strictly', () => {
    const good = randomBytes(32).toString('base64');
    expect(parseEncKey(good)).toHaveLength(32);
    expect(() => parseEncKey(undefined)).toThrow(TokenKeyError);
    expect(() => parseEncKey(undefined)).toThrow(/TOKEN_ENC_KEY is missing/);
    expect(() => parseEncKey('   ')).toThrow(/missing/);
    expect(() => parseEncKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes \(got 16\)/);
    expect(() => parseEncKey(randomBytes(33).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseEncKey('not base64!!')).toThrow(/not valid base64/);
    expect(() => parseEncKey(randomBytes(32).toString('base64url').replace(/=+$/, '') + '-')).toThrow(TokenKeyError);
  });
});
