import type { Module } from './app.js';
import { approvalsModule } from './approvals/module.js';
import { brainModule } from './brain/module.js';
import { flagsModule } from './flags/module.js';
import { googleModule } from './google/services.js';

/** One line per milestone, in install order. */
export const defaultModules: readonly Module[] = [
  googleModule,
  // M5: flag policy and digest first, so later modules can register digest kinds and sections.
  flagsModule,
  // M2: approvals first (the Brain's tools use them), then the Brain.
  approvalsModule,
  brainModule,
];
