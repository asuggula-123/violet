import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('no Gmail send endpoint anywhere in src/ (I8)', () => {
  const sources = files(join(import.meta.dirname, '../../../src')).filter((f) => /\.(ts|js|sql|json)$/.test(f));

  it('scans a non-trivial source tree', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((f) => f.endsWith('gmail.ts'))).toBe(true);
  });

  it.each([
    /messages\s*\/\s*send/i,
    /drafts\s*\/\s*send/i,
    /messages:send/i,
    /drafts:send/i,
    /upload\/gmail/i,
  ])('no source file matches %s', (pattern) => {
    const hits = sources.filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no Google source spells a bare "send" path segment', () => {
    const google = sources.filter((f) => f.includes(join('src', 'google')));
    expect(google.length).toBeGreaterThan(5);
    expect(google.filter((f) => /['"`/]send['"`/?]/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
