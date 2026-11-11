import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAIN_TEXT } from '../../../src/brain/brain.js';
import { read, ROOT } from '../ops/files.js';

const configKeys = [...read('src/config.ts').matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);

describe('operator docs match the merged code', () => {
  it('.env.example lists every variable src/config.ts reads, each with a placeholder and a comment line above it', () => {
    const lines = read('.env.example').split('\n');
    expect(configKeys.length).toBeGreaterThan(10);
    for (const key of configKeys) {
      const i = lines.findIndex((l) => l.startsWith(`${key}=`));
      expect(i, key).toBeGreaterThan(0);
      expect(lines[i - 1], key).toMatch(/^# \S/);
    }
  });

  it('docs/DEPLOY.md lists exactly the migrations that exist', () => {
    const files = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => f.endsWith('.sql'));
    const doc = read('docs/DEPLOY.md');
    const listed = new Set([...doc.matchAll(/`(\d{3}_[a-z0-9_]+\.sql)`/g)].map((m) => m[1]!));
    expect([...listed].sort()).toEqual(files.sort());
  });

  it('docs/DEPLOY.md no longer says the Brain is unbuilt', () => {
    const doc = read('docs/DEPLOY.md');
    expect(doc).not.toMatch(/Read by the Brain milestone|offline stand-in|not fully set up yet/);
    expect(doc).toContain(BRAIN_TEXT.notConnected.split(',')[0]!);
  });
});
