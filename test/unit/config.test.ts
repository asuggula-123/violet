import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, devEndpointsEnabled, parseConfig } from '../../src/config.js';

describe('config', () => {
  it('has safe defaults with an empty environment', () => {
    const c = parseConfig({});
    expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 8080, TRANSPORT: 'fake', TELEGRAM_MODE: 'webhook' });
    expect(c.DATABASE_URL).toBeUndefined();
    expect(c.VIOLET_MODEL).toBe(DEFAULT_MODEL);
    expect(c.VIOLET_ENVOY_MODEL).toBe(c.VIOLET_MODEL);
  });

  it('treats empty strings as unset and lets the envoy model follow VIOLET_MODEL', () => {
    const c = parseConfig({ DATABASE_URL: '', VIOLET_MODEL: 'model-x', PORT: '9000' });
    expect(c.DATABASE_URL).toBeUndefined();
    expect(c.VIOLET_ENVOY_MODEL).toBe('model-x');
    expect(c.PORT).toBe(9000);
  });

  it('rejects invalid values', () => {
    expect(() => parseConfig({ TRANSPORT: 'whatsapp' })).toThrow(/TRANSPORT/);
    expect(() => parseConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('enables dev endpoints only for the fake transport outside production, with an admin token', () => {
    const token = { ADMIN_TOKEN: 'test-admin-token' };
    expect(devEndpointsEnabled(parseConfig(token))).toBe(true);
    expect(devEndpointsEnabled(parseConfig({}))).toBe(false);
    expect(devEndpointsEnabled(parseConfig({ ADMIN_TOKEN: '  ' }))).toBe(false);
    expect(devEndpointsEnabled(parseConfig({ ...token, NODE_ENV: 'production' }))).toBe(false);
    expect(devEndpointsEnabled(parseConfig({ ...token, TRANSPORT: 'telegram' }))).toBe(false);
  });
});
