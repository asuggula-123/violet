import type { Module } from '../app.js';
import { a2aBrainTools } from './brainTools.js';
import { AFTER_JOB } from './conversations.js';
import type { A2ADeps } from './deps.js';
import { createEnvoy } from './envoy.js';
import { createOutcomes, OUTCOME_KIND } from './outcome.js';
import { createReleases, RELEASE_KIND } from './release.js';
import { NOTICE_JOB, OUTCOME_JOB, TURN_JOB } from './repo.js';
import { createA2AService } from './service.js';
import { createViews } from './views.js';

export const A2A_SWEEP_MS = 10 * 60_000;

/** M4: agent-to-agent conversations. Install after approvalsModule and brainModule. */
export const a2aModule: Module = {
  name: 'a2a',
  install(app) {
    const { approvals, brain } = app;
    if (!approvals || !brain) throw new Error('a2aModule needs approvalsModule and brainModule installed first');
    const { db, clock, llm, calendar, log } = app.deps;
    const d: A2ADeps = { db, clock, jobs: app.jobs, actionLog: app.actionLog, flags: app.flags, repos: app.repos, gateway: app.gateway, approvals, calendar, log };

    // The Envoy gets the narrow set only: a2a tables (through db), jobs, log, flags and free/busy.
    const envoy = createEnvoy({ db, clock, jobs: app.jobs, actionLog: app.actionLog, calendar: { freeBusy: (o, f, t) => calendar.freeBusy(o, f, t) }, llm, flags: app.flags, log });
    const outcomes = createOutcomes(d);
    const releases = createReleases(d);
    const views = createViews(db);
    const { service, sendNotice, flushNotices, after, resume, transcriptCommand } = createA2AService(d, views, outcomes);

    approvals.registerKind(OUTCOME_KIND, outcomes.kind);
    approvals.registerKind(RELEASE_KIND, releases.kind);
    app.jobs.register(TURN_JOB, (p) => envoy.runTurn(p));
    app.jobs.register(OUTCOME_JOB, (p) => outcomes.request(p));
    app.jobs.register(NOTICE_JOB, (p) => sendNotice(p));
    app.jobs.register(AFTER_JOB, (p) => after(p));
    for (const tool of a2aBrainTools(d, releases, views)) brain.tools.register(tool);
    brain.contextProviders.push(views.brainContext);
    brain.beforePrompts.push((agentId) => flushNotices(agentId)); // I19: a turn's notices land before its prompts
    // Q5: after the approvals resolver (installed first), before the Brain.
    app.router.hooks.ownerInterceptors.push(transcriptCommand);
    // I14: releases approved just before a pause go out now, then waiting notices and turns.
    // I14: bookings both owners said yes to while one was paused are booked now, too.
    // S3: these run before the approvals hook (installed first), so the prompts go out last.
    app.router.hooks.onResume.unshift(releases.resumeApproved, outcomes.resumeHeld, resume);
    app.scheduler.register('a2a.sweep', A2A_SWEEP_MS, async () => {
      await service.sweep();
    });
    app.a2a = service;
  },
};
