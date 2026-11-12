import { parseArgs } from 'node:util';
import pino from 'pino';
import { SystemClock } from '../clock.js';
import { loadDotEnv, parseConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { openDb } from '../db/open.js';
import { createGoogle, googleConfigured } from '../google/services.js';

loadDotEnv();

// With embedded PGlite (no DATABASE_URL), stop the server first: one process per data dir.
const USAGE = 'Usage: npm run google:link -- --owner <owner id>';

const { values } = parseArgs({ options: { owner: { type: 'string' } } });
if (!values.owner) {
  console.error(USAGE);
  process.exit(2);
}

const config = parseConfig(process.env);
if (!googleConfigured(config)) {
  console.error('Google is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and TOKEN_ENC_KEY.');
  process.exit(2);
}

const db = await openDb(config);
try {
  await migrate(db);
  const google = createGoogle({ config, db, clock: new SystemClock(), log: pino({ level: 'warn' }) });
  const link = await google.oauth.createConnectLink(values.owner);
  console.log('Open this link to connect Google (single use, valid 15 minutes):');
  console.log(`  ${link}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await db.close();
}
