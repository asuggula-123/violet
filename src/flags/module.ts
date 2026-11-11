import type { Module } from '../app.js';
import { createConflictCheck } from './conflicts.js';
import { createDigestService } from './digest.js';
import { createNowPolicy } from './policy.js';

/** Every scheduler tick: held flags go out as soon as quiet hours end (one indexed query). */
export const FLAG_RELEASE_EVERY_MS = 0;
/** Every tick too: a digest goes out at digest_hour:00 sharp (two small queries per agent). */
export const DIGEST_EVERY_MS = 0;
export const CONFLICT_CHECK_EVERY_MS = 3_600_000;

/**
 * M5: the I17 policy for 'now' flags (installed into app.flags, so callers that captured
 * it keep working), the daily digest on app.digest, and the hourly conflict check.
 */
export const flagsModule: Module = {
  name: 'flags',
  install(app) {
    const { db, clock, calendar, log } = app.deps;
    const { gateway, actionLog, repos } = app;
    const policy = createNowPolicy({ db, clock, gateway, actionLog, log });
    app.flags.setNowDelivery(policy.deliver);
    const digest = createDigestService({ db, clock, gateway, actionLog, log });
    app.digest = digest;
    app.scheduler.register('flags.release', FLAG_RELEASE_EVERY_MS, (now) => policy.releaseDue(now));
    app.scheduler.register('digest.run', DIGEST_EVERY_MS, (now) => digest.runDue(now));
    app.scheduler.registerPerAgent('flags.conflicts', CONFLICT_CHECK_EVERY_MS, createConflictCheck({ repos, calendar, flags: app.flags, log }));
  },
};
