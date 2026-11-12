import { buildApp } from './app.js';
import { loadDotEnv, parseConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { openDb } from './db/open.js';
import { createDeps } from './deps.js';
import { defaultModules } from './modules.js';
import { buildServer } from './server.js';
import { startTelegram } from './transport/telegram/start.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const db = await openDb(config);
  const deps = createDeps(config, db);
  const ran = await migrate(db);
  if (ran.length > 0) deps.log.info({ migrations: ran }, 'migrations applied');
  const app = await buildApp(deps, defaultModules);
  const server = buildServer(app);
  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  await app.start();
  const stopTelegram = await startTelegram(app);
  deps.log.info({ port: config.PORT, transport: config.TRANSPORT }, 'violet started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    deps.log.info({ signal }, 'shutting down');
    try {
      await stopTelegram();
      await server.close();
      await app.stop();
      await db.close();
      process.exit(0);
    } catch (err) {
      deps.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
