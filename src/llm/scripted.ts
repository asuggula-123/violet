import type { LlmClient, LlmRequest, LlmRequestMeta, LlmResponse } from './types.js';

export type LlmMatcher = Partial<LlmRequestMeta>;
/** `n` is how many earlier requests this responder has answered (0 for the first). */
export type LlmResponder = (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>;

interface Rule {
  matcher: LlmMatcher;
  responder: LlmResponder;
  count: number;
}

export function textResponse(text: string): LlmResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

export function toolUseResponse(id: string, name: string, input: Record<string, unknown>): LlmResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' };
}

/** Test double. Records every request; the most recently registered matching rule answers. */
export class ScriptedLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  private readonly rules: Rule[] = [];

  on(matcher: LlmMatcher, responder: LlmResponder): this {
    this.rules.unshift({ matcher, responder, count: 0 });
    return this;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(structuredClone(req));
    const rule = this.rules.find((r) => matches(r.matcher, req.meta));
    if (!rule) return textResponse('OK.');
    const n = rule.count;
    rule.count += 1;
    return rule.responder(req, n);
  }
}

function matches(m: LlmMatcher, meta: LlmRequestMeta): boolean {
  return (
    (m.agentId === undefined || m.agentId === meta.agentId) &&
    (m.mind === undefined || m.mind === meta.mind) &&
    (m.conversationId === undefined || m.conversationId === meta.conversationId)
  );
}
