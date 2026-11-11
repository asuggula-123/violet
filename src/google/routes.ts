import type { FastifyInstance, FastifyReply } from 'fastify';
import type { App } from '../app.js';
import { googleOf } from './services.js';

const PAGE_TEXT: Record<string, string> = {
  connected: 'Connected. You can close this tab.',
  access_denied: 'Google connection was cancelled. Ask Violet for a new link to try again.',
  bad_state: 'This link has expired or was already used. Ask Violet for a new link.',
  failed: "Couldn't connect Google. Ask Violet for a new link to try again.",
};

/** A tiny fixed page: no internals, no tokens or codes, not cached, no referrer. */
function page(reply: FastifyReply, status: number, key: keyof typeof PAGE_TEXT) {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>Violet</title></head><body><p>${PAGE_TEXT[key]}</p></body></html>`);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** GET /oauth/google/start and /oauth/google/callback. Not registered while Google is not configured. */
export function registerGoogleRoutes(server: FastifyInstance, app: App): void {
  const google = googleOf(app.deps);
  if (!google) return;

  server.get('/oauth/google/start', async (req, reply) => {
    const state = str((req.query as Record<string, unknown>).state) ?? '';
    const target = await google.oauth.consentUrl(state);
    if (!target) return page(reply, 400, 'bad_state');
    return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(target, 302);
  });

  server.get('/oauth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const state = str(q.state);
    const code = str(q.code);
    const error = str(q.error);
    try {
      const result = await google.oauth.callback({
        ...(state !== undefined ? { state } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(error !== undefined ? { error } : {}),
      });
      if (result.ok) return page(reply, 200, 'connected');
      if (result.reason === 'bad_state') return page(reply, 400, 'bad_state');
      return page(reply, 400, result.reason === 'access_denied' ? 'access_denied' : 'failed');
    } catch {
      app.deps.log.warn('google oauth callback failed');
      return page(reply, 500, 'failed');
    }
  });
}
