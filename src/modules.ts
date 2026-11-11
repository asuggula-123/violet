import type { Module } from './app.js';
import { approvalsModule } from './approvals/module.js';
import { brainModule } from './brain/module.js';
import { googleModule } from './google/services.js';

/** One line per milestone, in install order. */
export const defaultModules: readonly Module[] = [
  googleModule,
  // M2: approvals first (the Brain's tools use them), then the Brain.
  approvalsModule,
  brainModule,
];
