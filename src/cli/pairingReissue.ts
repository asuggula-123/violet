import { parseArgs } from 'node:util';
import { SystemClock } from '../clock.js';
import { parseConfig } from '../config.js';
import { createActionLog } from '../core/actionLog.js';
import { reissuePairingCode, UnknownAgentError } from '../core/pairingReissue.js';
import { pairingCodeLines } from '../core/pairingText.js';
import { createRepos } from '../core/repos/index.js';
import { migrate } from '../db/migrate.js';
import { openDb } from '../db/open.js';
import { checkTelegramCliArgs } from '../transport/telegram/pairing.js';

// With embedded PGlite (no DATABASE_URL), stop the server first: one process per data dir.
const USAGE = 'Usage: npm run pairing:reissue -- --agent <agent id> [--reset] [--bot-username <telegram bot username>]';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    reset: { type: 'boolean' },
    'bot-username': { type: 'string' },
  },
});
if (!values.agent) {
  console.error(USAGE);
  process.exit(2);
}

const db = await openDb(parseConfig(process.env));
try {
  await migrate(db);
  const clock = new SystemClock();
  // Usage errors first, so a code is never issued and then not shown.
  const before = await createRepos(db, clock).agents.get(values.agent);
  if (!before) throw new UnknownAgentError(values.agent);
  const botUsername = before.transport === 'telegram' ? checkTelegramCliArgs(before.agent_address, values['bot-username']).botUsername : undefined;
  const { agent, code, unpaired } = await reissuePairingCode({ db, clock, actionLog: createActionLog(db, clock) }, before.id, {
    reset: values.reset === true,
  });
  console.log(`Agent:     ${agent.id} at ${agent.agent_address}`);
  if (unpaired) console.log('Unpaired:  the previous owner chat is no longer the owner.');
  console.log('Any earlier pairing code no longer works.');
  console.log(`\n${pairingCodeLines(code, agent.pairing_expires_at, agent.transport, botUsername).join('\n')}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await db.close();
}
