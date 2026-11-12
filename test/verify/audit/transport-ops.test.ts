/**
 * Independent audit (transport / ops slice): Telegram wiring, env and secrets, model env var,
 * README / DEPLOY claims. Failing tests are evidence of findings; do not weaken them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, parseConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/db.js';
import { createDeps } from '../../../src/deps.js';
import { TelegramTransport } from '../../../src/transport/telegram/transport.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function srcFiles(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// A syntactically valid placeholder, not a real token.
const FAKE_TOKEN = '123456789:placeholder_placeholder_placeholder_x';

describe('audit: README "Without the four Google settings ... nothing is booked"', () => {
  it('a real Telegram bot run locally (README "Run it on your computer", polling, no Google) must not book on a stand-in calendar', async () => {
    // Exactly the README's local real-bot recipe: TRANSPORT=telegram, TELEGRAM_MODE=polling,
    // TELEGRAM_BOT_TOKENS; NODE_ENV left at its default (development); no Google settings.
    const config = parseConfig({ TRANSPORT: 'telegram', TELEGRAM_MODE: 'polling', TELEGRAM_BOT_TOKENS: FAKE_TOKEN });
    const deps = createDeps(config, {} as Db);
    expect(deps.transport).toBeInstanceOf(TelegramTransport); // real people on the other end
    // README.md: "*Without the four Google settings, calendar and email are off and nothing is booked."
    // Actual: an in-memory FakeCalendar accepts the write, so an approved event reports "Booked"
    // to a real owner on Telegram while no real calendar has it.
    await expect(
      deps.calendar.createEvent(
        'owner-x',
        { title: 'Dinner', start: new Date('2026-11-13T19:00:00Z'), end: new Date('2026-11-13T20:30:00Z') },
        'audit-key',
      ),
    ).rejects.toThrow();
  });
});

describe('audit: .env.example "Copy to .env and fill in."', () => {
  it('something actually reads .env (else the documented setup silently runs with defaults)', () => {
    expect(read('.env.example')).toMatch(/Copy to \.env/);
    const scripts = JSON.stringify(JSON.parse(read('package.json')).scripts);
    const loaders = srcFiles().some((f) => /dotenv|loadEnvFile|env-file/.test(readFileSync(f, 'utf8')));
    expect(loaders || /--env-file/.test(scripts)).toBe(true);
  });
});

describe('audit: env vars and model id (holds)', () => {
  const configKeys = [...read('src/config.ts').matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
  const exampleKeys = [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!] as const);

  it('.env.example has exactly the keys src/config.ts reads, every secret empty', () => {
    expect(new Set(exampleKeys.map(([k]) => k))).toEqual(new Set(configKeys));
    for (const [k, v] of exampleKeys) if (/KEY|TOKEN|SECRET|CLIENT|URL|URI/.test(k)) expect(v, k).toBe('');
  });

  it('no src file reads process.env except through parseConfig (or the demo flag parser)', () => {
    for (const f of srcFiles()) {
      for (const m of readFileSync(f, 'utf8').matchAll(/process\.env(\.[A-Z_]+)?/g)) {
        if (m[1] === undefined) continue; // parseConfig(process.env) / parseDemoArgs(..., process.env)
        expect(['.VIOLET_MODEL', '.VIOLET_ENVOY_MODEL'], `${f}: ${m[0]}`).toContain(m[1]);
      }
    }
  });

  it('the model comes from VIOLET_MODEL, default DEFAULT_MODEL in src/config.ts, and no other model id is in src/', () => {
    expect(DEFAULT_MODEL).toMatch(/^claude-[a-z0-9.-]+$/);
    expect(parseConfig({}).VIOLET_MODEL).toBe(DEFAULT_MODEL);
    expect(parseConfig({ VIOLET_MODEL: '' }).VIOLET_MODEL).toBe(DEFAULT_MODEL);
    expect(parseConfig({ VIOLET_MODEL: 'm-x' }).VIOLET_ENVOY_MODEL).toBe('m-x');
    const hits = srcFiles().flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/claude-[a-z0-9.-]+/g)].map((m) => `${f}:${m[0]}`));
    expect(hits.every((h) => h.endsWith(`src/config.ts:${DEFAULT_MODEL}`))).toBe(true);
  });
});
