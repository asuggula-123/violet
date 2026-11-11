import type { LlmBlock, LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import type { Persona, TestWorld } from '../../helpers/world.js';

export function toolUse(id: string, name: string, input: Record<string, unknown>): LlmBlock {
  return { type: 'tool_use', id, name, input };
}

export function respond(content: LlmBlock[], stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'): LlmResponse {
  return { content, stopReason, usage: { inputTokens: 100, outputTokens: 10 } };
}

/** Index of the step within the current turn: how many tool-result turns follow the last plain user turn. */
export function stepOf(req: LlmRequest): number {
  let step = 0;
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    const isResults = Array.isArray(m.content) && m.content.every((b) => b.type === 'tool_result');
    if (!isResults) break;
    step += 1;
  }
  return step;
}

/** The last tool results the model was given. */
export function lastResults(req: LlmRequest): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  const m = req.messages.at(-1);
  return Array.isArray(m?.content) ? (m.content.filter((b) => b.type === 'tool_result') as never) : [];
}

/**
 * Scripts the Brain of `p` per turn: `steps[i]` answers step i of every turn (stateless, so a
 * retried turn replays the same script). A string is a final text; an array is assistant content.
 */
export function scriptBrain(w: TestWorld, p: Persona, steps: Array<string | LlmBlock[] | ((req: LlmRequest) => LlmResponse)>): void {
  w.llm.on({ agentId: p.agent.id, mind: 'brain' }, (req) => {
    const s = steps[Math.min(stepOf(req), steps.length - 1)]!;
    if (typeof s === 'function') return s(req);
    return typeof s === 'string' ? respond([{ type: 'text', text: s }]) : respond(s);
  });
}

export function brainCalls(w: TestWorld, p: Persona): LlmRequest[] {
  return w.llm.calls.filter((c) => c.meta.agentId === p.agent.id && c.meta.mind === 'brain');
}
