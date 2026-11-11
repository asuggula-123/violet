import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from '../ops/files.js';

// The CLIs as real processes, on an embedded PGlite in a scratch directory (no network).
const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve('tsx')).href;
const tmp = mkdtempSync(join(tmpdir(), 'violet-gfix-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(cli: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, ['--import', tsx, resolve(ROOT, `src/cli/${cli}.ts`), ...args], {
    cwd: tmp,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (err += String(d)));
  return new Promise((r) => child.on('exit', (code) => r({ code, out, err })));
}

const codeOf = (out: string) => /\/start ([A-Z2-9]{10})/.exec(out)?.[1];

describe('pairing:reissue CLI', () => {
  it('re-issues for an unpaired agent, refuses a paired one without --reset, rejects an unknown agent', async () => {
    const added = await run('ownerAdd', ['--household', 'Home', '--name', 'Alex', '--tz', 'Europe/London', '--transport', 'fake', '--agent-address', 'violet-cli']);
    expect(added.code).toBe(0);
    const agentId = /Agent: +(\S+) at violet-cli/.exec(added.out)![1]!;
    const first = codeOf(added.out)!;

    const re = await run('pairingReissue', ['--agent', agentId]);
    expect(re.code).toBe(0);
    const code = codeOf(re.out)!;
    expect(code).not.toBe(first);
    expect(re.out).toContain('Pairing code (shown once, expires ');
    expect(re.out).toContain('Any earlier pairing code no longer works.');
    expect(re.out).not.toMatch(/[0-9a-f]{64}/); // never a hash
    expect(re.out.split(code)).toHaveLength(2); // the code is printed exactly once

    const preset = await run('ownerAdd', ['--household', 'Home', '--name', 'Sam', '--tz', 'Europe/London', '--transport', 'fake', '--agent-address', 'violet-sam', '--owner-address', 'sam']);
    const samAgent = /Agent: +(\S+) at violet-sam/.exec(preset.out)![1]!;
    const refused = await run('pairingReissue', ['--agent', samAgent]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/already paired\. Pass --reset/);
    expect(codeOf(refused.out)).toBeUndefined();
    const reset = await run('pairingReissue', ['--agent', samAgent, '--reset']);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain('Unpaired:  the previous owner chat is no longer the owner.');
    expect(codeOf(reset.out)).toBeDefined();

    const unknown = await run('pairingReissue', ['--agent', 'no-such-agent']);
    expect(unknown.code).toBe(1);
    expect(unknown.err.trim()).toBe('Unknown agent no-such-agent');

    const usage = await run('pairingReissue', []);
    expect(usage.code).toBe(2);
    expect(usage.err).toContain('Usage: npm run pairing:reissue');
  }, 120_000);

  it('google:link without Google settings still refuses with its usual message', async () => {
    const res = await run('googleLink', ['--owner', 'x'], { NODE_ENV: 'production' });
    expect(res.code).toBe(2);
    expect(res.err).toContain('Google is not configured');
  }, 60_000);
});
