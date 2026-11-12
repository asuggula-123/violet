import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The Brain turn the current code runs in (set by the Brain around its tool loop). An
 * approval requested inside a turn is held and delivered by the turn after its reply, so the
 * genuine prompt is the last thing the turn shows the owner (I19, prompt-last).
 */
const store = new AsyncLocalStorage<{ messageId: string }>();

export function runInTurn<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ messageId }, fn);
}

/** The owner message id of the Brain turn in progress, or undefined outside one. */
export function currentTurn(): string | undefined {
  return store.getStore()?.messageId;
}
