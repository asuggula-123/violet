import { describe, expect, it } from 'vitest';
import { flyToml, read } from './files.js';

describe('fly.toml', () => {
  const fly = flyToml(read('fly.toml'));

  it('has a placeholder app name and only non-secret [env] settings', () => {
    expect(fly.get('app')).toBe('violet-app');
    expect(fly.has('primary_region')).toBe(true);
    const env = [...fly].filter(([k]) => k.startsWith('env.'));
    expect(Object.fromEntries(env)).toEqual({
      'env.NODE_ENV': 'production',
      'env.PORT': '8080',
      'env.TRANSPORT': 'telegram',
      'env.TELEGRAM_MODE': 'webhook',
    });
  });

  it('serves https on the app port', () => {
    expect(fly.get('http_service.internal_port')).toBe('8080');
    expect(fly.get('http_service.force_https')).toBe('true');
  });

  it('keeps one machine always running (scheduler, digest and jobs are in-process)', () => {
    expect(['"off"', 'off', 'false']).toContain(fly.get('http_service.auto_stop_machines'));
    expect(fly.get('http_service.min_machines_running')).toBe('1');
    expect(fly.get('deploy.strategy')).toBe('rolling');
  });

  it('health-checks GET /healthz', () => {
    expect(fly.get('http_service.checks.method')).toBe('GET');
    expect(fly.get('http_service.checks.path')).toBe('/healthz');
    expect(read('src/server.ts')).toContain("server.get('/healthz'");
  });

  it('stops with SIGTERM and a timeout long enough for the job in flight', () => {
    expect(fly.get('kill_signal')).toBe('SIGTERM');
    const timeout = /^(\d+)s$/.exec(fly.get('kill_timeout') ?? '');
    expect(Number(timeout?.[1])).toBeGreaterThanOrEqual(60);
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(300);
    expect(read('src/main.ts')).toContain("process.on('SIGTERM'");
  });
});

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');
  it('keeps postgres and adds an opt-in app service on the fake transport', () => {
    expect(compose).toMatch(/^ {2}postgres:$/m);
    expect(compose).toMatch(/^ {2}app:\n {4}profiles: \["app"\]$/m);
    expect(compose).toContain('TRANSPORT: fake');
    expect(compose).toContain('ADMIN_TOKEN: ${ADMIN_TOKEN:-local-dev-admin-token-not-a-secret}');
  });
});
