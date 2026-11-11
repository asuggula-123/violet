import { parseArgs } from 'node:util';
import { SystemClock } from '../clock.js';
import { parseConfig } from '../config.js';
import { createActionLog } from '../core/actionLog.js';
import { createRepos } from '../core/repos/index.js';
import { createHousehold, createOwnerWithAgent, type SetupCtx } from '../core/setup.js';
import { migrate } from '../db/migrate.js';
import { openDb } from '../db/open.js';
import type { TransportName } from '../transport/types.js';

// With embedded PGlite (no DATABASE_URL), stop the server first: one process per data dir.
const USAGE =
  'Usage: npm run owner:add -- --household <name or id> --name <owner name> --tz <IANA zone> ' +
  '--transport <fake|telegram> --agent-address <address> [--owner-address <address>]';

const { values } = parseArgs({
  options: {
    household: { type: 'string' },
    name: { type: 'string' },
    tz: { type: 'string' },
    transport: { type: 'string' },
    'agent-address': { type: 'string' },
    'owner-address': { type: 'string' },
  },
});

const { household, name, tz, transport } = values;
const agentAddress = values['agent-address'];
if (!household || !name || !tz || !transport || !agentAddress) {
  console.error(USAGE);
  process.exit(2);
}
if (transport !== 'fake' && transport !== 'telegram') {
  console.error(`--transport must be fake or telegram\n${USAGE}`);
  process.exit(2);
}

const db = await openDb(parseConfig(process.env));
try {
  await migrate(db);
  const clock = new SystemClock();
  const ctx: SetupCtx = { repos: createRepos(db, clock), actionLog: createActionLog(db, clock), clock };
  const existing = (await ctx.repos.households.get(household)) ?? (await ctx.repos.households.findByName(household));
  const home = existing ?? (await createHousehold(ctx, household, 'cli'));
  const created = await createOwnerWithAgent(
    ctx,
    {
      householdId: home.id,
      name,
      timezone: tz,
      transport: transport as TransportName,
      agentAddress,
      ...(values['owner-address'] ? { ownerAddress: values['owner-address'] } : {}),
    },
    'cli',
  );
  console.log(`Household: ${home.name} (${home.id})`);
  console.log(`Owner:     ${created.owner.name} (${created.owner.id})`);
  console.log(`Agent:     ${created.agent.id} at ${created.agent.agent_address}`);
  if (created.pairingCode) {
    console.log(`\nPairing code (shown once, expires ${created.agent.pairing_expires_at?.toISOString()}):`);
    console.log(`  /start ${created.pairingCode}`);
  } else {
    console.log('Owner address preset; no pairing needed.');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await db.close();
}
