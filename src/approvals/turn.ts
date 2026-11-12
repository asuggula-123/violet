import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The Brain turn the current code runs in (set by the Brain around its tool loop). An
 * approval requested inside a turn is held and delivered by the turn after its reply, so the
 * genuine prompt is the last thing the turn shows the owner (I19, prompt-last).
 */
/**
 * Wall-clock bound of one Brain turn's model loop (R16), below the job stale time (10 min): no
 * model call starts after it and a call in flight is cut off at it. Here, not in brain.ts, so the
 * approvals service can derive its turn hold from it without an import cycle.
 */
export const BRAIN_TURN_MS = 8 * 60_000;

const store = new AsyncLocalStorage<{ messageId: string; tainted: () => boolean }>();

/** `tainted`: whether the turn has seen third-party text so far (P4: stored on approvals it requests). */
export function runInTurn<T>(messageId: string, fn: () => Promise<T>, tainted: () => boolean = () => false): Promise<T> {
  return store.run({ messageId, tainted }, fn);
}

/** The owner message id of the Brain turn in progress, or undefined outside one. */
export function currentTurn(): string | undefined {
  return store.getStore()?.messageId;
}

/** Whether the Brain turn in progress is tainted at this moment (false outside a turn). */
export function currentTurnTainted(): boolean {
  return store.getStore()?.tainted() === true;
}
