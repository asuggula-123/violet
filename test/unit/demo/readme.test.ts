import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config.js';
import { read } from '../ops/files.js';

/** Every variable src/config.ts reads. */
function configVariables(): string[] {
  return [...read('src/config.ts').matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
}

/** Names in the first column of the README's keys table. */
function tableNames(readme: string): string[] {
  const section = readme.split('## Keys you need to create')[1]!.split('\n## ')[0]!;
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]!);
}

describe('README', () => {
  const readme = read('README.md');

  it('the keys table lists every config variable that has no default', () => {
    const defaults = parseConfig({}) as Record<string, unknown>;
    const noDefault = configVariables().filter((name) => defaults[name] === undefined);
    expect(noDefault).toContain('ANTHROPIC_API_KEY');
    expect(noDefault).toContain('TOKEN_ENC_KEY');
    const names = tableNames(readme);
    for (const name of noDefault) expect(names, name).toContain(name);
    // ...and names nothing config.ts does not read.
    for (const name of names) expect(configVariables(), name).toContain(name);
  });

  it('points to the docs it relies on and names no model', () => {
    for (const path of ['docs/ARCHITECTURE.md', 'docs/DEPLOY.md', 'docs/DEMO.md']) {
      expect(readme).toContain(path);
      expect(read(path).length).toBeGreaterThan(0);
    }
    expect(readme).not.toMatch(/claude-|opus|sonnet|haiku/i);
  });
});
