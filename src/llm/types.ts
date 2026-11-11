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
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
  /** Not sent to the API. Used for logging and for scripting tests. */
  meta: LlmRequestMeta;
}

export interface LlmResponse {
  content: LlmBlock[];
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
