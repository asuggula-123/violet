import { loadDotEnv, parseConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { openDb } from '../db/open.js';

loadDotEnv();

const db = await openDb(parseConfig(process.env));
try {
  const ran = await migrate(db);
  console.log(ran.length > 0 ? `Applied: ${ran.join(', ')}` : 'Up to date.');
} finally {
  await db.close();
}
