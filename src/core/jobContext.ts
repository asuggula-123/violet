import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which job the current code runs in (set by the job queue around each handler call).
 * Lets a transport tell a job's retry (same job id) from a new, separate request.
 */
const store = new AsyncLocalStorage<{ jobId: string }>();

export function runInJob<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ jobId }, fn);
}

/** The id of the job whose handler is running, or undefined outside a job. */
export function currentJobId(): string | undefined {
  return store.getStore()?.jobId;
}
