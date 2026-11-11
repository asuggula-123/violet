import { mkdirSync } from 'node:fs';
import type { Config } from '../config.js';
import { PgDb, PgliteDb, type Db } from './db.js';

export const DEFAULT_PGLITE_DIR = './.data/pglite';

export async function openDb(config: Config): Promise<Db> {
  if (config.DATABASE_URL) return new PgDb({ connectionString: config.DATABASE_URL });
  mkdirSync(DEFAULT_PGLITE_DIR, { recursive: true });
  return PgliteDb.open(DEFAULT_PGLITE_DIR);
}
