import type { Module } from './app.js';
import { googleModule } from './google/services.js';

/** One line per milestone, in install order. */
export const defaultModules: readonly Module[] = [
  googleModule,
];
