import type { Module } from '../app.js';
import { calendarEventKind } from './calendarEvent.js';
import { createResolver } from './resolver.js';
import { createApprovalService } from './service.js';

export const APPROVAL_SWEEP_MS = 60_000;

/** M2: approval service + `calendar_event` kind, the resolver interceptor, resume delivery, expiry sweep. */
export const approvalsModule: Module = {
  name: 'approvals',
  install(app) {
    const service = createApprovalService(app);
    service.registerKind('calendar_event', calendarEventKind);
    app.approvals = service;
    app.router.hooks.ownerInterceptors.push(createResolver(app, service));
    app.router.hooks.onResume.push((agentId) => service.sendUnsent(agentId));
    // Paused agents are skipped by the scheduler (I14): nothing expires or is sent while paused.
    app.scheduler.registerPerAgent('approvals.sweep', APPROVAL_SWEEP_MS, async (agentId) => {
      await service.expireDue(agentId);
      await service.sendUnsent(agentId);
    });
  },
};
