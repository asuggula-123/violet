import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../../app.js';
import { followUp, ingestUpdate } from './inbound.js';
import { telegramUpdate } from './normalize.js';
import { TelegramTransport } from './transport.js';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
export const webhookPath = (botId: string) => `/webhooks/telegram/${botId}`;

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time compare (I18); hashing first makes the lengths equal. */
export function secretMatches(header: unknown, secret: string): boolean {
  return typeof header === 'string' && timingSafeEqual(digest(header), digest(secret));
}

type BotRequest = FastifyRequest<{ Params: { botId: string } }>;

/**
 * POST /webhooks/telegram/:botId. The secret header is checked in onRequest, before
 * the body is read or parsed. Responses never echo request content. Processing is
 * asynchronous (job queue), so a 200 comes back as soon as the update is stored.
 */
export function registerTelegramRoutes(server: FastifyInstance, app: App): void {
  const transport = app.deps.transport;
  const secret = app.deps.config.TELEGRAM_WEBHOOK_SECRET;
  if (!(transport instanceof TelegramTransport) || !secret) return;

  void server.register(async (scope) => {
    // Parse the body ourselves: a malformed one gets a plain 400, never a parser message.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.setErrorHandler(async (err: { statusCode?: number }, _req, reply) => {
      const code = err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      if (code === 500) app.deps.log.error({ err: err instanceof Error ? err.message : 'error' }, 'telegram webhook failed');
      return reply.code(code).send({ ok: false });
    });

    const authenticate = async (req: BotRequest, reply: FastifyReply) => {
      if (!secretMatches(req.headers[SECRET_HEADER], secret)) return reply.code(401).send({ ok: false });
      if (!transport.api(req.params.botId)) return reply.code(404).send({ ok: false });
    };

    scope.post<{ Params: { botId: string } }>('/webhooks/telegram/:botId', { onRequest: authenticate }, async (req, reply) => {
      let json: unknown;
      try {
        json = JSON.parse(typeof req.body === 'string' ? req.body : '');
      } catch {
        return reply.code(400).send({ ok: false });
      }
      const update = telegramUpdate.safeParse(json);
      if (!update.success) return reply.code(400).send({ ok: false });
      const botId = req.params.botId;
      const n = await ingestUpdate(app, botId, update.data);
      void followUp(app, transport.api(botId)!, botId, n);
      return { ok: true };
    });
  });
}
