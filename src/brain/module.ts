import type { Module } from '../app.js';
import { createBrain } from './brain.js';

/** M2: the Brain answers every owner message the interceptors did not handle. Install after approvalsModule. */
export const brainModule: Module = {
  name: 'brain',
  install(app) {
    const brain = createBrain(app);
    app.brain = brain;
    app.router.hooks.onOwnerMessage = (ctx) => brain.handle(ctx);
  },
};
