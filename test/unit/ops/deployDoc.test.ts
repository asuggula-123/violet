import { describe, expect, it } from 'vitest';
import { read } from './files.js';

const doc = read('docs/DEPLOY.md');
const configKeys = new Set([...read('src/config.ts').matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));

const SECRETS = [
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKENS',
  'TELEGRAM_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'TOKEN_ENC_KEY',
  'ADMIN_TOKEN',
  'DATABASE_URL',
  'PUBLIC_BASE_URL',
];

/** Files this milestone ships that an operator copies from. */
const OPS_FILES = ['docs/DEPLOY.md', 'Dockerfile', 'fly.toml', 'docker-compose.yml', '.dockerignore', '.env.example'];

describe('docs/DEPLOY.md matches the code', () => {
  it('documents every secret, and every documented variable is read by src/config.ts', () => {
    const tableNames = [...doc.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]!);
    expect(tableNames.sort()).toEqual([...SECRETS].sort());
    const block = /```sh\nfly secrets set[\s\S]*?```/.exec(doc)?.[0] ?? '';
    const setNames = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    expect(setNames.length).toBeGreaterThan(0);
    const mentioned = [...doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]!);
    for (const name of [...tableNames, ...setNames, ...mentioned]) expect(configKeys, name).toContain(name);
  });

  it('mentions only npm scripts that exist', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    const used = [...doc.matchAll(/npm (?:run|start)(?: ([a-z:]+))?/g)].map((m) => m[1] ?? 'start');
    expect(used).toContain('owner:add:prod');
    expect(used).toContain('google:link:prod');
    for (const s of used) expect(scripts, s).toHaveProperty([s]);
  });

  it('mentions only CLI flags the CLIs parse (besides flyctl/docker flags)', () => {
    const cliSource = ['ownerAdd', 'googleLink', 'migrate', 'pairingReissue'].map((c) => read(`src/cli/${c}.ts`)).join('\n');
    const tooling = new Set(['app', 'ha', 'image', 'profile', 'build', 'help']);
    const flags = new Set([...doc.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((m) => m[1]!));
    expect(flags).toContain('agent-address');
    for (const f of flags) if (!tooling.has(f)) expect(cliSource, `--${f}`).toMatch(new RegExp(`'?${f}'?: \\{ type:`));
  });

  it('mentions only routes the server registers', () => {
    const src = ['src/server.ts', 'src/google/routes.ts'].map(read).join('\n');
    const routes = new Set([...doc.matchAll(/(\/(?:healthz|dev\/[a-z]+|oauth\/google\/[a-z]+))/g)].map((m) => m[1]!));
    expect(routes).toContain('/oauth/google/callback');
    for (const r of routes) expect(src, r).toContain(`'${r}'`);
  });

  it('names the default Google scopes from src/google/scopes.ts', () => {
    const scopes = [...read('src/google/scopes.ts').matchAll(/\$\{AUTH\}([a-z.]+)`/g)].map((m) => m[1]!).slice(0, 4);
    expect(scopes).toHaveLength(4);
    for (const s of scopes) expect(doc).toContain(`\`${s}\``);
  });
});

describe('no secret value is committed', () => {
  const LEAKS: [string, RegExp][] = [
    ['Telegram bot token', /\b\d{5,}:[A-Za-z0-9_-]{30,}/],
    ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{8,}/],
    ['Google client secret', /GOCSPX-[A-Za-z0-9_-]{8,}/],
    ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  it.each(OPS_FILES)('%s holds no credential-shaped strings', (file) => {
    const text = read(file);
    for (const [what, re] of LEAKS) expect(re.test(text), `${what} in ${file}`).toBe(false);
    const urls = [...text.matchAll(/postgres(?:ql)?:\/\/([^:\s/]+):([^@\s]+)@/g)].map((m) => `${m[1]}:${m[2]}`);
    for (const creds of urls) expect(creds, `database password in ${file}`).toBe('violet:violet');
  });

  it('every secret assignment in the guide is a placeholder, generated on the spot or a fake local value', () => {
    for (const name of SECRETS) {
      for (const m of doc.matchAll(new RegExp(`\\b${name}=(\\S+)`, 'g'))) {
        expect(m[1], name).toMatch(/^['"]?(<|\$\(openssl|https:\/\/<app>|local-dev-|postgres:\/\/violet:violet@127\.0\.0\.1)/);
      }
    }
  });

  it('.env.example leaves every secret empty', () => {
    for (const name of SECRETS) expect(read('.env.example')).toMatch(new RegExp(`^${name}=$`, 'm'));
  });
});
