import type { LlmClient, LlmResponse } from './types.js';

export type LlmErrorCode = 'unconfigured' | 'rate_limited' | 'overloaded' | 'server' | 'network' | 'auth' | 'bad_request' | 'unknown';

/**
 * A model call failed. `retryable` errors may succeed later (the job retries);
 * the others will not. The message never contains prompts, keys or headers.
 */
export class LlmError extends Error {
  override readonly name = 'LlmError';

  constructor(
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError;
}

/** Stands in when ANTHROPIC_API_KEY is unset: every call fails with a typed, non-retryable error. */
export class UnconfiguredLlm implements LlmClient {
  async complete(): Promise<LlmResponse> {
    throw new LlmError('unconfigured', false, 'no model is configured (ANTHROPIC_API_KEY is unset)');
  }
}
