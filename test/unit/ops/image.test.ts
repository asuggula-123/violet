import { describe, expect, it } from 'vitest';
import { lines, read } from './files.js';

describe('Dockerfile', () => {
  const docker = lines(read('Dockerfile'));
  const stages = docker.filter((l) => /^FROM /i.test(l));
  const runtime = docker.slice(docker.lastIndexOf(stages.at(-1)!));

  it('is multi-stage on Node 22 slim, pinned by major version', () => {
    expect(stages).toEqual(['FROM node:22-slim AS build', 'FROM node:22-slim AS runtime']);
  });

  it('builds with dev dependencies and ships production dependencies only', () => {
    expect(docker).toContain('RUN npm ci');
    expect(docker).toContain('RUN npm run build');
    expect(runtime.some((l) => /^RUN npm ci --omit=dev\b/.test(l))).toBe(true);
    expect(runtime).toContain('COPY --from=build /app/dist ./dist');
    expect(runtime.filter((l) => /^COPY /.test(l) && !l.includes('--from=build'))).toEqual(['COPY package.json package-lock.json ./']);
  });

  it('runs as a non-root user in production, exec-form CMD on dist/main.js', () => {
    const users = runtime.filter((l) => /^USER /.test(l));
    expect(users).toHaveLength(1);
    expect(users[0]).not.toMatch(/^USER (root|0)(:|$)/);
    expect(runtime).toContain('ENV NODE_ENV=production');
    expect(runtime).toContain('EXPOSE 8080');
    expect(runtime.at(-1)).toBe('CMD ["node", "dist/main.js"]');
    expect(docker.some((l) => /^ENTRYPOINT/.test(l))).toBe(false);
  });

  it('bakes in no secrets or env files', () => {
    expect(docker.some((l) => /\.env|ARG .*(TOKEN|KEY|SECRET)|ENV .*(TOKEN|KEY|SECRET)/i.test(l))).toBe(false);
  });
});

describe('.dockerignore', () => {
  const ignored = lines(read('.dockerignore'));
  it.each(['node_modules', 'dist', '.git', '.env*', 'test', 'docs', '.worktrees', '.data'])('excludes %s', (entry) => {
    expect(ignored).toContain(entry);
  });
  it('does not re-include any env file', () => {
    expect(ignored.some((l) => l.startsWith('!'))).toBe(false);
  });
});

describe('build output for operators', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  it.each([
    ['migrate:prod', 'migrate'],
    ['owner:add:prod', 'ownerAdd'],
    ['google:link:prod', 'googleLink'],
    ['pairing:reissue:prod', 'pairingReissue'],
  ])('%s runs the compiled CLI with node (no dev dependency)', (script, cli) => {
    expect(scripts[script]).toBe(`node dist/cli/${cli}.js`);
    expect(read(`src/cli/${cli}.ts`).length).toBeGreaterThan(0);
  });
  it('keeps the tsx scripts and copies migrations into dist', () => {
    expect(scripts['owner:add']).toBe('tsx src/cli/ownerAdd.ts');
    expect(scripts.start).toBe('node dist/main.js');
    expect(scripts.build).toContain("cpSync('src/db/migrations','dist/db/migrations'");
  });
});
