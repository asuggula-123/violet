import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('server', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  it('GET /healthz', async () => {
    const server = buildServer(w.app);
    const res = await server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await server.close();
  });

  const TOKEN = 'test-admin-token';
  const auth = { authorization: `Bearer ${TOKEN}` };
  const withToken = (extra: Record<string, string> = {}) => ({
    ...w.app,
    deps: { ...w.app.deps, config: parseConfig({ NODE_ENV: 'test', TRANSPORT: 'fake', ADMIN_TOKEN: TOKEN, ...extra }) },
  });

  it('dev endpoints ingest, settle and show the outbox', async () => {
    const server = buildServer(withToken());
    const post = await server.inject({
      method: 'POST',
      url: '/dev/inbound',
      headers: auth,
      payload: { agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'hello' },
    });
    expect(post.statusCode).toBe(200);
    const out = await server.inject({ method: 'GET', url: '/dev/outbox', headers: auth });
    expect(out.json().sent).toEqual([expect.objectContaining({ toAddress: w.alex.address, text: "I'm not fully set up yet." })]);
    const bad = await server.inject({ method: 'POST', url: '/dev/inbound', headers: auth, payload: { text: 1 } });
    expect(bad.statusCode).toBe(400);
    await server.close();
  });

  it('dev endpoints reject a missing or wrong admin token (I1)', async () => {
    const server = buildServer(withToken());
    const payload = { agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' };
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }]) {
      expect((await server.inject({ method: 'POST', url: '/dev/inbound', headers, payload })).statusCode).toBe(401);
      expect((await server.inject({ method: 'GET', url: '/dev/outbox', headers })).statusCode).toBe(401);
    }
    await server.close();
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(false);
    expect(w.transport.sent).toEqual([]);
  });

  it('dev endpoints do not exist without an admin token', async () => {
    const server = buildServer(w.app);
    expect((await server.inject({ method: 'GET', url: '/dev/outbox', headers: auth })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/dev/inbound', headers: auth, payload: {} })).statusCode).toBe(404);
    await server.close();
  });

  it('dev endpoints do not exist in production', async () => {
    const server = buildServer(withToken({ NODE_ENV: 'production' }));
    expect((await server.inject({ method: 'GET', url: '/dev/outbox', headers: auth })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/dev/inbound', headers: auth, payload: {} })).statusCode).toBe(404);
    await server.close();
  });
});
