import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from './app.js';
import { devEndpointsEnabled } from './config.js';
import { FakeTransport } from './transport/fake.js';
import { registerGoogleRoutes } from './google/routes.js';
import { registerTelegramRoutes } from './transport/telegram/routes.js';

const devInbound = z.object({
  agentAddress: z.string().min(1),
  fromAddress: z.string().min(1),
  fromName: z.string().optional(),
  text: z.string(),
  transportMessageId: z.string().min(1).optional(),
});

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** `Authorization: Bearer <ADMIN_TOKEN>`, compared in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m !== null && timingSafeEqual(digest(m[1]!), digest(token));
}

export function buildServer(app: App): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  server.get('/healthz', async (_req, reply) => {
    try {
      await app.deps.db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  registerGoogleRoutes(server, app);
  registerTelegramRoutes(server, app);

  const transport = app.deps.transport;
  const adminToken = app.deps.config.ADMIN_TOKEN;
  if (devEndpointsEnabled(app.deps.config) && adminToken && transport instanceof FakeTransport) {
    // /dev/inbound can speak as any sender, owners included (I1), and /dev/outbox
    // shows every outbound text: both need the admin token.
    const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!bearerMatches(req.headers.authorization, adminToken)) await reply.code(401).send({ ok: false, error: 'unauthorized' });
    };

    server.post('/dev/inbound', { onRequest: requireAdmin }, async (req, reply) => {
      const parsed = devInbound.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });
      const b = parsed.data;
      await app.ingest({
        transport: 'fake',
        agentAddress: b.agentAddress,
        fromAddress: b.fromAddress,
        ...(b.fromName !== undefined ? { fromName: b.fromName } : {}),
        kind: 'text',
        text: b.text,
        transportMessageId: b.transportMessageId ?? `dev-${randomUUID()}`,
        receivedAt: app.deps.clock.now(),
      });
      await app.settle();
      return { ok: true };
    });

    server.get('/dev/outbox', { onRequest: requireAdmin }, async () => ({ sent: transport.sent }));
  }

  return server;
}
