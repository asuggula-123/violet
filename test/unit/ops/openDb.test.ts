import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config.js';
import { MISSING_DATABASE_URL_MESSAGE, openDb } from '../../../src/db/open.js';

describe('openDb in production', () => {
  // `fly ssh console` is root, so a PGlite fallback would succeed silently and the CLI
  // would write the household to a throwaway database. It must refuse instead.
  it('refuses the embedded PGlite fallback without DATABASE_URL', async () => {
    await expect(openDb(parseConfig({ NODE_ENV: 'production' }))).rejects.toThrow(MISSING_DATABASE_URL_MESSAGE);
    await expect(openDb(parseConfig({ NODE_ENV: 'production', DATABASE_URL: '  ' }))).rejects.toThrow(/DATABASE_URL is missing/);
  });
});
