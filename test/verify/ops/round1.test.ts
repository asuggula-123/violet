// Ops verification, round 1: adversarial checks on the Dockerfile, fly.toml, compose file,
// deploy guide and the production boot path. No network: the process test runs with
// placeholder Telegram tokens and no PUBLIC_BASE_URL, so no Telegram call is ever made.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { devEndpointsEnabled, parseConfig } from '../../../src/config.js';
import { flyToml, lines, read, ROOT } from '../../unit/ops/files.js';

const doc = read('docs/DEPLOY.md');
const fly = flyToml(read('fly.toml'));
const compose = read('docker-compose.yml');
const configKeys = new Set([...read('src/config.ts').matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));
const SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKENS',
  'TELEGRAM_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'TOKEN_ENC_KEY',
  'ADMIN_TOKEN',
  'DATABASE_URL',
];

/** The YAML block of one compose service (top-level two-space indent). */
function serviceBlock(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]|^[a-z]|$(?![\\s\\S]))`, 'm').exec(compose);
  return m?.[1] ?? '';
}

describe('fly.toml (adversarial)', () => {
  it('kill_timeout is within Fly limits (<= 300 s) and long enough for one Brain turn (>= 30 s)', () => {
    const raw = fly.get('kill_timeout') ?? '';
    const secs = /^(\d+)s?$/.exec(raw)?.[1];
    expect(secs, raw).toBeDefined();
    expect(Number(secs)).toBeGreaterThanOrEqual(30);
    expect(Number(secs)).toBeLessThanOrEqual(300);
  });

  it('[env] holds only non-secret keys the config parses, with values the config accepts', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of fly) if (k.startsWith('env.')) env[k.slice(4)] = v;
    expect(Object.keys(env).sort()).toEqual(['NODE_ENV', 'PORT', 'TELEGRAM_MODE', 'TRANSPORT']);
    for (const k of Object.keys(env)) expect(configKeys, k).toContain(k);
    for (const s of SECRET_NAMES) expect(env, s).not.toHaveProperty(s);
    const cfg = parseConfig(env);
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.PORT).toBe(Number(fly.get('http_service.internal_port')));
    expect(devEndpointsEnabled({ ...cfg, ADMIN_TOKEN: 'x' })).toBe(false);
  });

  it('never runs two machines: no bluegreen/canary, no auto-stop, min one machine', () => {
    expect(['rolling', 'immediate']).toContain(fly.get('deploy.strategy'));
    expect(fly.get('http_service.auto_stop_machines')).toMatch(/^("?off"?|false)$/);
    expect(fly.get('http_service.min_machines_running')).toBe('1');
    expect(fly.get('http_service.force_https')).toBe('true');
    expect(read('fly.toml')).not.toMatch(/^\s*\[\[?services\]?\]?/m);
  });

  it('the health check targets a GET route the server registers and answers without auth', () => {
    expect(fly.get('http_service.checks.method')).toBe('GET');
    expect(fly.get('http_service.checks.path')).toBe('/healthz');
    expect(read('src/server.ts')).toMatch(/server\.get\('\/healthz'/);
  });

  it('the comment about two machines names the real scheduler weakness (no claim/lock in scheduler.ts)', () => {
    const scheduler = read('src/core/scheduler.ts');
    // The truth the comment relies on: no lock, claim or SKIP LOCKED in the scheduler.
    expect(scheduler).not.toMatch(/FOR UPDATE|SKIP LOCKED|advisory/i);
    expect(read('src/core/jobs.ts')).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(read('src/db/migrations/001_core.sql')).toMatch(/jobs_one_running_per_lane/);
    expect(read('fly.toml')).toMatch(/Two machines are NOT safe/);
  });
});

describe('Dockerfile (adversarial)', () => {
  const docker = lines(read('Dockerfile'));
  const runtimeStart = docker.findIndex((l) => /^FROM .* AS runtime$/i.test(l));
  const runtime = docker.slice(runtimeStart);

  it('the runtime stage never copies the source tree, tests or the build context wholesale', () => {
    for (const l of runtime.filter((x) => /^(COPY|ADD) /.test(x))) {
      expect(l).not.toMatch(/^(COPY|ADD) (\.|\.\/) /);
      expect(l).not.toMatch(/\bsrc\b|\btest\b|\.env/);
    }
    expect(docker.some((l) => /^ADD /.test(l))).toBe(false);
  });

  it('USER comes before CMD and after every RUN in the runtime stage', () => {
    const userAt = runtime.findIndex((l) => /^USER /.test(l));
    const lastRun = runtime.map((l, i) => (/^RUN /.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const cmdAt = runtime.findIndex((l) => /^CMD /.test(l));
    expect(userAt).toBeGreaterThan(lastRun);
    expect(cmdAt).toBeGreaterThan(userAt);
  });

  it('the build stage copies every file tsconfig.build.json needs (it extends tsconfig.json)', () => {
    const build = docker.slice(0, runtimeStart).join('\n');
    const tsb = JSON.parse(read('tsconfig.build.json')) as { extends?: string };
    if (tsb.extends) expect(build).toContain(tsb.extends.replace(/^\.\//, ''));
    expect(build).toContain('tsconfig.build.json');
  });
});

describe('docker-compose.yml (adversarial)', () => {
  const app = serviceBlock('app');

  it('the app service is opt-in (profile app) and uses the fake transport', () => {
    expect(app).toMatch(/profiles:\s*\["app"\]/);
    expect(app).toMatch(/TRANSPORT:\s*fake/);
    expect(app).not.toMatch(/NODE_ENV:\s*production/);
    expect(app).not.toMatch(/TELEGRAM_BOT_TOKENS|ANTHROPIC_API_KEY|GOOGLE_CLIENT_SECRET|TOKEN_ENC_KEY/);
  });

  it('ADMIN_TOKEN is read from the environment with a clearly fake default', () => {
    const m = /ADMIN_TOKEN:\s*\$\{ADMIN_TOKEN:-([^}]+)\}/.exec(app);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/not-a-secret|fake|placeholder/);
  });

  // The app service exposes /dev/inbound (can speak as any owner) with a publicly known
  // default bearer token. Publishing it on all interfaces makes it reachable from the LAN.
  it('the app port with the dev endpoints is bound to loopback only', () => {
    const ports = [...app.matchAll(/^\s+-\s*"([^"]+)"/gm)].map((m) => m[1]!);
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:/);
  });
});

describe('docs/DEPLOY.md (adversarial)', () => {
  it('every src/cli/*.ts has a :prod script running the compiled file, and the guide uses only :prod in the image', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    const clis = readdirSync(join(ROOT, 'src/cli')).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, ''));
    const prod = Object.values(scripts).filter((s) => s.startsWith('node dist/cli/'));
    for (const c of clis) expect(prod, c).toContain(`node dist/cli/${c}.js`);
    // Inside `fly ssh console` blocks only the :prod scripts can work (no tsx in the image).
    for (const block of doc.matchAll(/```sh\n([\s\S]*?)```/g)) {
      if (!/fly ssh console|cd \/app/.test(block[1]!)) continue;
      for (const m of block[1]!.matchAll(/npm run ([a-z:]+)/g)) expect(m[1]!, m[1]).toMatch(/:prod$/);
    }
  });

  it('the redirect URI documented is the callback path the routes register', () => {
    const routes = read('src/google/routes.ts');
    for (const m of doc.matchAll(/https:\/\/<app>\.fly\.dev(\/[a-z/]+)/g)) {
      if (m[1] === '/healthz') continue;
      expect(routes, m[1]).toContain(`'${m[1]}'`);
    }
  });

  it('the token placeholder in the guide matches the format the transport accepts', () => {
    // A real bot token satisfies parseBotTokens; the guide's described shape must too.
    expect(doc).toMatch(/<bot id>:<secret>/);
    expect(read('src/transport/telegram/transport.ts')).toMatch(/TOKEN_FORMAT = \/\^\(\\d\{1,20\}\):/);
  });

  // The guide tells the operator "If a call says the database is missing, check printenv
  // DATABASE_URL". No CLI prints such a message: without DATABASE_URL, openDb silently falls
  // back to PGlite in ./.data/pglite (writable for root in `fly ssh console`), so the owner
  // would be written to a throwaway embedded database and the call would look successful.
  it('the "database is missing" message the guide promises exists in the CLI path', () => {
    expect(doc).toMatch(/says the database is\s+missing/);
    const cliPath = ['src/cli/ownerAdd.ts', 'src/cli/googleLink.ts', 'src/db/open.ts'].map(read).join('\n');
    expect(cliPath).toMatch(/DATABASE_URL[^\n]*(missing|required|not set)/i);
  });
});

describe('devEndpointsEnabled', () => {
  it.each([
    [{ NODE_ENV: 'production', TRANSPORT: 'fake', ADMIN_TOKEN: 'local-dev-admin-token-not-a-secret' }, false],
    [{ NODE_ENV: 'development', TRANSPORT: 'telegram', ADMIN_TOKEN: 'x', TELEGRAM_BOT_TOKENS: '1:x' }, false],
    [{ NODE_ENV: 'development', TRANSPORT: 'fake', ADMIN_TOKEN: '   ' }, false],
    [{ NODE_ENV: 'development', TRANSPORT: 'fake', ADMIN_TOKEN: 'x' }, true],
  ])('%j → %s', (env, expected) => {
    expect(devEndpointsEnabled(parseConfig(env))).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------
// Production boot as a real process (tsx loader, not the build: dist is not kept around).

const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'violet-ops-verify-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function startMain(env: Record<string, string>): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const tsx = pathToFileURL(require.resolve('tsx')).href;
  const child = spawn(process.execPath, ['--import', tsx, resolve(ROOT, 'src/main.ts')], {
    cwd: tmp,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += String(d)));
  child.stderr!.on('data', (d) => (out += String(d)));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, output: () => out, exited };
}

async function waitHealthy(port: number, exited: Promise<number | null>): Promise<Response> {
  let done = false;
  void exited.then(() => (done = true));
  for (let i = 0; i < 400 && !done; i += 1) {
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server never answered /healthz');
}

// Production refuses the embedded PGlite fallback (src/db/open.ts), so the full boot needs a
// real Postgres: it runs under `npm run test:pg`, in a fresh schema it creates and drops.
// (Originally this test booted production on PGlite; corrected after finding 2 was fixed.)
const TEST_DB = process.env.TEST_DATABASE_URL;

describe('production boot (real process, no network)', () => {
  it('without DATABASE_URL it refuses to start and writes no embedded database', async () => {
    const p = startMain({ NODE_ENV: 'production', PORT: '18089', TRANSPORT: 'fake' });
    expect(await p.exited).not.toBe(0);
    expect(p.output()).toMatch(/DATABASE_URL is missing/);
    expect(readdirSync(tmp)).not.toContain('.data');
  }, 60_000);

  it.skipIf(!TEST_DB)(
    'NODE_ENV=production, Telegram webhook mode with placeholders: healthz 200, no dev endpoints, SIGTERM exits 0',
    async () => {
      const schema = `ops_boot_${process.pid}_${Date.now()}`;
      const admin = new pg.Client({ connectionString: TEST_DB });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(TEST_DB!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const env: Record<string, string> = {
        DATABASE_URL: url.toString(),
        NODE_ENV: 'production',
        PORT: String(port),
        TRANSPORT: 'telegram',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_BOT_TOKENS: `123456:${'p'.repeat(35)}`,
        TELEGRAM_WEBHOOK_SECRET: 'placeholder_secret_0123456789',
        ADMIN_TOKEN: 'fake-admin-token',
      };
      const p = startMain(env);
      try {
        const health = await waitHealthy(port, p.exited);
        expect(health.status, p.output()).toBe(200);
        expect(await health.json()).toEqual({ ok: true });
        const auth = { authorization: 'Bearer fake-admin-token', 'content-type': 'application/json' };
        const inbound = await fetch(`http://127.0.0.1:${port}/dev/inbound`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ agentAddress: '123456', fromAddress: '1', text: 'hi' }),
        });
        expect(inbound.status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/dev/outbox`, { headers: auth })).status).toBe(404);
        // Webhook without the secret header is refused.
        const hook = await fetch(`http://127.0.0.1:${port}/webhooks/telegram/123456`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(hook.status).toBe(401);
        p.child.kill('SIGTERM');
        expect(await p.exited, p.output()).toBe(0);
        expect(p.output()).toMatch(/"shutting down"/);
        expect(p.output()).toMatch(/webhooks not registered/);
        expect(p.output()).not.toMatch(/telegram webhook registered|setWebhook failed/);
        expect(p.output()).toMatch(/migrations applied/);
      } finally {
        if (p.child.exitCode === null) p.child.kill('SIGKILL');
        await p.exited;
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    90_000,
  );
});

describe('no real identifiers in the ops files', () => {
  it.each(['docs/DEPLOY.md', 'fly.toml', 'docker-compose.yml', 'Dockerfile', '.dockerignore'])('%s', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    // Emails and phone numbers.
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@(?!violet\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
    // Persona names only.
    for (const m of text.matchAll(/--name ([A-Z][a-z]+)/g)) expect(['Alex', 'Sam']).toContain(m[1]);
  });
});
