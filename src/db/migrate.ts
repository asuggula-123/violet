import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgErrorCode, type Db } from './db.js';

const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * Finds the migrations directory both from src/ (tsx) and from dist/ (built),
 * where the build copies the .sql files next to the compiled runner.
 */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'migrations'), resolve(here, '../../src/db/migrations')];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`Migrations directory not found (looked in ${candidates.join(', ')})`);
  return found;
}

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => FILE_NAME.test(f))
    .sort()
    .map((name) => ({ version: name.slice(0, 3), name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * Serializes every migration script against other processes migrating the same
 * schema: a transaction-level advisory lock keyed on the schema name. A multi-statement
 * script runs as one implicit transaction, so the lock is held until it commits.
 */
const LOCK = `SELECT pg_advisory_xact_lock(hashtext('violet.migrate:' || current_schema()));`;

/** Same-process callers sharing one Db (PGlite has a single session) take turns. */
const inProcess = new WeakMap<Db, Promise<unknown>>();

/**
 * Applies pending migrations in order. Each file plus its schema_migrations row
 * runs as one multi-statement script, which Postgres executes atomically.
 * Unqualified names resolve via search_path, so this works inside any schema.
 *
 * Safe to run from several processes at once (every instance migrates at boot):
 * the schema_migrations row is inserted first, under the advisory lock, so a
 * process that lost the race gets a unique violation, rolls back the whole script
 * and skips that version.
 */
export function migrate(db: Db, dir?: string): Promise<string[]> {
  const prev = inProcess.get(db) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => migrateLocked(db, dir));
  inProcess.set(db, run);
  return run;
}

async function migrateLocked(db: Db, dir?: string): Promise<string[]> {
  await db.exec(
    `${LOCK}\nCREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`,
  );
  const applied = await appliedVersions(db);
  const ran: string[] = [];
  for (const m of loadMigrations(dir)) {
    if (applied.has(m.version)) continue;
    try {
      await db.exec(`${LOCK}\nINSERT INTO schema_migrations (version) VALUES ('${m.version}');\n${m.sql}\n;`);
    } catch (err) {
      // Another process applied this version since we looked.
      if (pgErrorCode(err) === '23505' && (await appliedVersions(db)).has(m.version)) continue;
      throw err;
    }
    ran.push(m.name);
  }
  return ran;
}

async function appliedVersions(db: Db): Promise<Set<string>> {
  const done = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(done.rows.map((r) => r.version));
}
