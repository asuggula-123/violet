/** Verifier (M1): migration runner safety. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../../src/db/migrate.js';
import { PgDb, type Db } from '../../../src/db/db.js';
import { openTestDb } from '../../helpers/world.js';

describe('verify M1: migrations', () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ db, cleanup } = await openTestDb());
  });
  afterEach(async () => cleanup());

  it('two processes migrating the same fresh database at once both succeed (boot-time migrate on several machines)', async () => {
    const url = process.env.TEST_DATABASE_URL;
    let second: Db = db;
    let closeSecond = async () => undefined as void;
    if (url) {
      const schema = (await db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
      const other = new PgDb({ connectionString: url, schema, max: 2 });
      second = other;
      closeSecond = () => other.close();
    }
    try {
      const results = await Promise.allSettled([migrate(db), migrate(second)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const versions = await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
      expect(versions.rows).toEqual(loadMigrations().map((m) => ({ version: m.version })));
    } finally {
      await closeSecond();
    }
  });

  it('a migrated schema does not see or touch another schema (search_path isolation)', async () => {
    await migrate(db);
    const other = await openTestDb();
    try {
      expect(await migrate(other.db)).toEqual(loadMigrations().map((m) => m.name));
      await other.db.query(`INSERT INTO households (id, name, created_at) VALUES ('h1', 'x', now())`);
      const mine = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM households');
      expect(mine.rows[0]!.n).toBe(0);
    } finally {
      await other.cleanup();
    }
  });
});
