/**
 * R5: the documented local setup works. `cp .env.example .env`, fill in, and the server entry
 * point (npm run dev / npm start) and the CLIs read ./.env. A variable set in the real
 * environment wins over the file. .env stays git-ignored.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Runs a src entry point in `cwd` with only PATH and `env` set; resolves with its exit code and output. */
function run(entry: string, cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', tsx, join(ROOT, entry)], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('exit', (code) => done({ code, out }));
  });
}

function withDotEnv(text: string): string {
  dir = mkdtempSync(join(tmpdir(), 'violet-dotenv-'));
  writeFileSync(join(dir, '.env'), text);
  return dir;
}

describe('R5: ./.env is read by the server and the CLIs', () => {
  it('the server entry point reads it (a bad value there stops the boot with that key named)', async () => {
    const r = await run('src/main.ts', withDotEnv('TRANSPORT=not-a-transport\n'));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Invalid configuration: TRANSPORT/);
  }, 120_000);

  it('a CLI reads it, and a real environment variable wins over it', async () => {
    const cwd = withDotEnv('NODE_ENV=production\n');
    const fromFile = await run('src/cli/migrate.ts', cwd);
    expect(fromFile.code).not.toBe(0);
    expect(fromFile.out).toMatch(/DATABASE_URL is missing/);
    const realWins = await run('src/cli/migrate.ts', cwd, { NODE_ENV: 'development' });
    expect(realWins.out).toMatch(/Applied: /);
    expect(realWins.code).toBe(0);
  }, 120_000);

  it('.env is git-ignored and kept out of the image; .env.example is not', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['.env*', '!.env.example']));
    expect(readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n')).toContain('.env*');
  });
});
