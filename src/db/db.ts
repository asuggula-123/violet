import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Runs a multi-statement SQL script (simple protocol, no parameters). Used by migrations. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface PgDbOptions {
  connectionString: string;
  /** Sets search_path for every connection (test worlds use one schema each). */
  schema?: string;
  max?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(opts: PgDbOptions) {
    if (opts.schema !== undefined && !SCHEMA_NAME.test(opts.schema)) {
      throw new Error(`Invalid schema name: ${opts.schema}`);
    }
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: Queryable = {
      async query<R>(sql: string, params: unknown[] = []) {
        const res = await client.query(sql, params);
        return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
      },
    };
    try {
      await client.query('BEGIN');
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** In-process Postgres (WASM). `dataDir` unset → in-memory. */
export class PgliteDb implements Db {
  constructor(private readonly pg: PGlite) {}

  static async open(dataDir?: string): Promise<PgliteDb> {
    const db = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
    return new PgliteDb(db);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return toResult<T>(await this.pg.query<T>(sql, params));
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) =>
      fn({
        async query<R>(sql: string, params: unknown[] = []) {
          return toResult<R>(await t.query<R>(sql, params));
        },
      }),
    );
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

function toResult<T>(res: { rows: T[]; affectedRows?: number }): QueryResult<T> {
  return { rows: res.rows, rowCount: res.affectedRows || res.rows.length };
}

/** Error code helper (works for both drivers). */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
