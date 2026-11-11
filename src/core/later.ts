/**
 * Interfaces of services that later milestones install on the App.
 * Each milestone replaces its interface here (M4: A2AService; M5: DigestService).
 * M1 code never calls them.
 */

export type { ApprovalService } from '../approvals/types.js';

export type { Brain } from '../brain/types.js';

export interface A2AService {}

export type { DigestService } from '../flags/types.js';
