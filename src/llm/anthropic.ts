import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from './errors.js';
import type { LlmBlock, LlmClient, LlmRequest, LlmResponse, Mind } from './types.js';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type ApiMessage = Anthropic.Beta.Messages.BetaMessage;

/** The one SDK call this client makes. Tests inject a fake; production uses the real SDK. */
export type CreateMessage = (params: CreateParams, options?: { signal?: AbortSignal }) => Promise<ApiMessage>;

export interface AnthropicLlmOptions {
  apiKey: string;
  /** Model per mind: VIOLET_MODEL for the Brain, VIOLET_ENVOY_MODEL for the Envoy. */
  models: Record<Mind, string>;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** The API's server-side refusal fallback (VIOLET_MODEL_FALLBACK). Default true; false sends no fallback beta or parameter. */
  fallback?: boolean;
  /** Test seam: replaces the SDK call. */
  create?: CreateMessage;
  /** Test seam: the SDK's fetch (to check the request on the wire). */
  fetch?: typeof fetch;
  maxRetries?: number;
}

const EPHEMERAL = { type: 'ephemeral' } as const;
/** Refusal fallback: on a policy decline the API re-runs the request on a fallback model it picks. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * LlmClient on the official SDK (Messages API, beta endpoint for server-side fallbacks).
 * - Prompt caching: breakpoints on the last tool and on the stable system block; the
 *   volatile system text comes after them; automatic caching covers the message prefix.
 * - Thinking: left to the model's default (adaptive on current models); thinking blocks
 *   come back in `content` and the caller passes them back verbatim.
 * - `meta` is never sent. Nothing here logs prompts, keys or headers.
 */
export class AnthropicLlm implements LlmClient {
  private readonly create: CreateMessage;

  constructor(private readonly opts: AnthropicLlmOptions) {
    if (opts.create) {
      this.create = opts.create;
    } else {
      const client = new Anthropic({
        apiKey: opts.apiKey,
        maxRetries: opts.maxRetries ?? 2,
        timeout: 5 * 60_000,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      this.create = (params, options) => client.beta.messages.create(params, options);
    }
  }

  /** The request body for `req` (exported for tests; `meta` is not part of it). */
  params(req: LlmRequest): CreateParams {
    const tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      ...(i === req.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [{ type: 'text', text: req.system, cache_control: EPHEMERAL }];
    if (req.systemDynamic) system.push({ type: 'text', text: req.systemDynamic });
    return {
      model: this.opts.models[req.meta.mind],
      max_tokens: req.maxTokens,
      system,
      messages: req.messages as Anthropic.Beta.Messages.BetaMessageParam[],
      ...(tools.length > 0 ? { tools } : {}),
      cache_control: EPHEMERAL,
      output_config: { effort: this.opts.effort ?? 'medium' },
      ...(this.opts.fallback === false ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const }),
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let res: ApiMessage;
    // The caller's bound covers the SDK's own retries too.
    const signal = req.timeoutMs !== undefined ? AbortSignal.timeout(Math.max(1, Math.floor(req.timeoutMs))) : undefined;
    try {
      res = await this.create(this.params(req), signal ? { signal } : undefined);
    } catch (err) {
      throw toLlmError(err);
    }
    const u = res.usage;
    return {
      content: res.content as unknown as LlmBlock[],
      stopReason: res.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
      ...(typeof res.model === 'string' ? { model: res.model } : {}),
      fallback: servedByFallback(res),
    };
  }
}

/** A `fallback` content block, or a `fallback_message` entry in usage.iterations, marks a fallback hop. */
function servedByFallback(res: ApiMessage): boolean {
  const blocks = (res.content ?? []) as Array<{ type?: unknown }>;
  const iterations = (res.usage?.iterations ?? []) as Array<{ type?: unknown }>;
  return blocks.some((b) => b.type === 'fallback') || iterations.some((i) => i.type === 'fallback_message');
}

/** Maps SDK errors to LlmError. Messages are fixed strings: no prompt, key or header text. */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new LlmError('deadline', false, 'model call ran past the turn deadline');
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('network', true, 'could not reach the model API');
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) return new LlmError('rate_limited', true, 'model API rate limit', status);
    if (status === 529) return new LlmError('overloaded', true, 'model API overloaded', status);
    if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
      return new LlmError('server', true, `model API error ${status}`, status);
    }
    if (status === 401 || status === 403) return new LlmError('auth', false, `model API rejected the credentials (${status})`, status);
    if (status !== undefined && status >= 400) return new LlmError('bad_request', false, `model API rejected the request (${status})`, status);
  }
  return new LlmError('unknown', false, 'model call failed');
}
