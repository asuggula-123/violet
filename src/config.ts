import { existsSync } from 'node:fs';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

/** The Brain's model when VIOLET_MODEL is unset: the one model id in src/. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Unset → embedded PGlite at ./.data/pglite. */
    DATABASE_URL: optionalString,
    PUBLIC_BASE_URL: optionalString,
    ADMIN_TOKEN: optionalString,
    ANTHROPIC_API_KEY: optionalString,
    VIOLET_MODEL: optionalString,
    VIOLET_ENVOY_MODEL: optionalString,
    /** on (default): a refused request may be answered by a fallback model the API picks; off: never. */
    VIOLET_MODEL_FALLBACK: optionalString.pipe(z.enum(['on', 'off']).optional()),
    TRANSPORT: z.enum(['fake', 'telegram']).default('fake'),
    /** Comma-separated, one bot token per agent. */
    TELEGRAM_BOT_TOKENS: optionalString,
    TELEGRAM_WEBHOOK_SECRET: optionalString,
    TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('webhook'),
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REDIRECT_URI: optionalString,
    /** 32 bytes, base64. Encrypts Google refresh tokens at rest (I16). */
    TOKEN_ENC_KEY: optionalString,
    /** Space-separated OAuth scopes to request; unset → src/google/scopes.ts defaults. */
    GOOGLE_SCOPES: optionalString,
  })
  .transform((c) => {
    const model = c.VIOLET_MODEL ?? DEFAULT_MODEL;
    return { ...c, VIOLET_MODEL: model, VIOLET_ENVOY_MODEL: c.VIOLET_ENVOY_MODEL ?? model, VIOLET_MODEL_FALLBACK: c.VIOLET_MODEL_FALLBACK ?? 'on' };
  });

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}

/**
 * Dev endpoints exist only with the fake transport outside production, and only
 * when ADMIN_TOKEN is set: every call must carry it as a bearer token.
 */
export function devEndpointsEnabled(config: Config): boolean {
  return config.TRANSPORT === 'fake' && config.NODE_ENV !== 'production' && config.ADMIN_TOKEN !== undefined;
}

/**
 * Local setup (`cp .env.example .env`): the server and every CLI read `./.env` when it
 * exists, before parseConfig. A variable already set in the real environment wins.
 */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
