/** Mirrors the Anthropic Messages API shape. */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** thinking etc. — pass back verbatim */
  | { type: string; [k: string]: unknown };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmBlock[];
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type Mind = 'brain' | 'envoy';

export interface LlmRequestMeta {
  agentId: string;
  mind: Mind;
  conversationId?: string;
}

export interface LlmRequest {
  /** Stable system text: cached (prompt caching), so keep it byte-identical across requests. */
  system: string;
  /** Volatile system text (current time, pending items), sent after the cache breakpoint. */
  systemDynamic?: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
  /** Not sent to the API. Used for logging and for scripting tests. */
  meta: LlmRequestMeta;
  /** Not sent to the API: the most wall time this call may take, retries included (the Brain's turn deadline). */
  timeoutMs?: number;
}

export interface LlmResponse {
  content: LlmBlock[];
  stopReason: string;
  usage?: LlmUsage;
  /** The model that served the response, as the API reports it (unknown for test doubles). */
  model?: string;
  /** True when the API's refusal fallback answered with a model it picked. */
  fallback?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
