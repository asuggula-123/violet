import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { loadMigrations, migrate, migrationsDir } from '../../src/db/migrate.js';
import { openTestDb } from '../helpers/world.js';

const CORE_TABLES = [
  'action_log',
  'agents',
  'contact_notes',
  'contacts',
  'flags',
  'households',
  'inbound_events',
  'jobs',
  'messages',
  'owners',
  'scheduler_state',
  'schema_migrations',
];

describe('migrations', () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await openTestDb());
  });
  afterEach(async () => cleanup());

  it('apply on a fresh database and are idempotent', async () => {
    // Later milestones add their own files (002_…, 003_…): all apply, in order.
    const all = loadMigrations().map((m) => m.name);
    expect(all[0]).toBe('001_core.sql');
    expect(await migrate(db)).toEqual(all);
    expect(await migrate(db)).toEqual([]);
    const res = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    expect(res.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(CORE_TABLES));
    const versions = await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(versions.rows).toEqual(loadMigrations().map((m) => ({ version: m.version })));
  });

  it('finds the migrations directory and orders files by version', () => {
    expect(migrationsDir()).toMatch(/migrations$/);
    const versions = loadMigrations().map((m) => m.version);
    expect(versions[0]).toBe('001');
    expect(versions).toEqual([...versions].sort());
  });

  it('rolls back a failing migration completely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-mig-'));
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE t_ok (id int);');
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE t_half (id int);\nSELECT no_such_function();');
    await expect(migrate(db, dir)).rejects.toThrow();
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['schema_migrations', 't_ok']);
    const versions = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(versions.rows).toEqual([{ version: '001' }]);
  });

  describe('action_log is append-only (I15)', () => {
    beforeEach(async () => {
      await migrate(db);
      await db.query(`INSERT INTO action_log (at, actor, action) VALUES ($1, 'system', 'test.row')`, [new Date('2026-01-01T00:00:00Z')]);
    });

    it('blocks UPDATE', async () => {
      await expect(db.query(`UPDATE action_log SET action = 'changed'`)).rejects.toThrow(/append-only/);
    });

    it('blocks DELETE', async () => {
      await expect(db.query('DELETE FROM action_log')).rejects.toThrow(/append-only/);
    });

    it('blocks TRUNCATE', async () => {
      await expect(db.query('TRUNCATE action_log')).rejects.toThrow(/append-only/);
    });

    it('keeps the row', async () => {
      await db.query('DELETE FROM action_log').catch(() => undefined);
      const res = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM action_log');
      expect(res.rows[0]?.n).toBe(1);
    });
  });
});
