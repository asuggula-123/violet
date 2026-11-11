import { mkdirSync } from 'node:fs';
import type { Config } from '../config.js';
import { PgDb, PgliteDb, type Db } from './db.js';

export const DEFAULT_PGLITE_DIR = './.data/pglite';

export const MISSING_DATABASE_URL_MESSAGE =
  'DATABASE_URL is missing: production has no embedded-database fallback (set DATABASE_URL to the Postgres URL)';

export async function openDb(config: Config): Promise<Db> {
  if (config.DATABASE_URL) return new PgDb({ connectionString: config.DATABASE_URL });
  // Never write production data to a throwaway embedded database (server or CLI).
  if (config.NODE_ENV === 'production') throw new Error(MISSING_DATABASE_URL_MESSAGE);
  mkdirSync(DEFAULT_PGLITE_DIR, { recursive: true });
  return PgliteDb.open(DEFAULT_PGLITE_DIR);
}
