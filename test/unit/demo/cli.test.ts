import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_NEEDS_KEY, parseDemoArgs } from '../../../src/demo/args.js';
import { ROOT } from '../ops/files.js';

describe('demo flags', () => {
  it('a key in the environment alone never turns on the live model', () => {
    expect(parseDemoArgs([], { ANTHROPIC_API_KEY: 'placeholder' })).toEqual({ fast: false, live: null });
    expect(parseDemoArgs(['--fast'], { ANTHROPIC_API_KEY: 'placeholder' })).toEqual({ fast: true, live: null });
  });

  it('--live needs a key; with one it is used', () => {
    expect(parseDemoArgs(['--live'], {})).toEqual({ error: LIVE_NEEDS_KEY });
    expect(parseDemoArgs(['--live'], { ANTHROPIC_API_KEY: '  ' })).toEqual({ error: LIVE_NEEDS_KEY });
    expect(parseDemoArgs(['--live', '--fast'], { ANTHROPIC_API_KEY: 'placeholder' })).toEqual({ fast: true, live: { apiKey: 'placeholder' } });
  });

  it('unknown options are refused', () => {
    expect(parseDemoArgs(['--chat'], {})).toMatchObject({ error: expect.stringContaining('Unknown option: --chat') });
  });
});

describe('the demo command', () => {
  const run = (args: string[], env: Record<string, string>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'violet-demo-'));
    try {
      const res = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'src/cli/demo.ts'), ...args], {
        cwd,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
        timeout: 60_000,
      });
      return { ...res, left: readdirSync(cwd) };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  it('--fast exits 0, uses the scripted model even with a key set, and leaves no files behind', () => {
    const res = run(['--fast'], { ANTHROPIC_API_KEY: 'placeholder-not-a-key' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Model: scripted demo model');
    expect(res.stdout).toContain('Done.');
    expect(res.left).toEqual([]);
  }, 60_000);

  it('--live without a key exits with a clear message', () => {
    const res = run(['--live'], {});
    expect(res.status).toBe(2);
    expect(res.stderr.trim()).toBe(LIVE_NEEDS_KEY);
    expect(res.stdout).toBe('');
  }, 60_000);
});
