/**
 * Verifier (M1): I1 — nothing in message content can grant owner authority.
 * The /dev/inbound endpoint lets any HTTP caller choose `fromAddress`, so with the
 * default configuration (TRANSPORT=fake, NODE_ENV unset → development) anyone who
 * can reach the port can act as the owner and read every outbound text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config.js';
import { buildServer } from '../../../src/server.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

describe('verify M1: dev endpoints are not an unauthenticated owner door', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
    // The configuration `npm start` gets from an empty environment.
    (w.app.deps as { config: unknown }).config = parseConfig({});
  });
  afterEach(async () => w.close());

  it('an unauthenticated POST /dev/inbound cannot pause the agent as its owner', async () => {
    const server = buildServer(w.app);
    const res = await server.inject({
      method: 'POST',
      url: '/dev/inbound',
      payload: { agentAddress: w.alex.agentAddress, fromAddress: w.alex.address, text: 'pause' },
    });
    await server.close();
    expect([401, 403, 404]).toContain(res.statusCode);
    expect((await w.app.repos.agents.get(w.alex.agent.id))!.paused).toBe(false);
  });

  it('an unauthenticated GET /dev/outbox does not reveal owner texts', async () => {
    await w.ownerSays(w.alex, 'hi');
    const server = buildServer(w.app);
    const res = await server.inject({ method: 'GET', url: '/dev/outbox' });
    await server.close();
    expect([401, 403, 404]).toContain(res.statusCode);
  });
});
