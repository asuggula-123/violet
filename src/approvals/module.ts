import type { Module } from '../app.js';
import { DEFAULT_SECTIONS } from '../flags/digest.js';
import type { DigestSection } from '../flags/types.js';
import { calendarEventKind } from './calendarEvent.js';
import { promptSummary } from './repo.js';
import { createResolver } from './resolver.js';
import { createApprovalService } from './service.js';
import type { ApprovalService } from './types.js';

export const APPROVAL_SWEEP_MS = 60_000;

const WAITING = DEFAULT_SECTIONS.find((s) => s.key === 'waiting')!;

/**
 * The digest's live 'Waiting for you' section (8.5): one line per approval still pending,
 * the stored code-rendered prompt without its fixed tail, `#ref` kept so the owner can
 * answer `yes #7`. The digest re-sanitizes each line and applies its caps (I13).
 */
export function waitingSection(service: ApprovalService): DigestSection {
  return { ...WAITING, lines: async (agentId) => (await service.listPending(agentId)).map(promptSummary) };
}

/**
 * M2: approval service + `calendar_event` kind, the resolver interceptor, resume delivery,
 * expiry sweep, and the digest's 'Waiting for you' section (flagsModule installs first).
 */
export const approvalsModule: Module = {
  name: 'approvals',
  install(app) {
    const service = createApprovalService(app);
    service.registerKind('calendar_event', calendarEventKind);
    app.approvals = service;
    app.router.hooks.ownerInterceptors.push(createResolver(app, service));
    app.router.hooks.onResume.push((agentId) => service.sendUnsent(agentId));
    app.digest?.addSection(waitingSection(service));
    // Paused agents are skipped by the scheduler (I14): nothing expires or is sent while paused.
    app.scheduler.registerPerAgent('approvals.sweep', APPROVAL_SWEEP_MS, async (agentId) => {
      await service.expireDue(agentId);
      await service.sendUnsent(agentId);
    });
  },
};
