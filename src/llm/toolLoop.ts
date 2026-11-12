import { storable } from '../core/outbound.js';
import { isLlmError } from './errors.js';
import { safeToolMessage, type ToolDef, type ToolRegistry } from './tools.js';
import type { LlmBlock, LlmClient, LlmMessage, LlmRequestMeta, LlmResponse, LlmUsage } from './types.js';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type DenyReason = 'unknown_tool' | 'invalid_input';

export interface ToolLoopOptions<C> {
  llm: LlmClient;
  system: string;
  systemDynamic?: string;
  messages: LlmMessage[];
  tools: ToolRegistry<C>;
  /** Runs one validated call (the caller adds context, memoization, logging). May throw. */
  execute(tool: ToolDef<C>, input: unknown, call: ToolCall): Promise<string>;
  /** A call the loop refused: a name that is not registered, or input that failed validation. */
  onDenied?(call: ToolCall, reason: DenyReason): Promise<void>;
  maxSteps: number;
  maxTokens: number;
  meta: LlmRequestMeta;
  /** Wall-clock bound for the whole loop: no call starts after `at`, and each call gets the time left as its timeout. */
  deadline?: { at: Date; now(): Date };
}

/** end_turn | max_tokens | refusal | max_steps | deadline | any other stop reason the API returned. */
export type LoopStop = 'end_turn' | 'max_tokens' | 'refusal' | 'max_steps' | 'deadline' | (string & {});

export interface ToolLoopResult {
  /** Text of the last response ('' on refusal). */
  finalText: string;
  /** The whole conversation, including every assistant turn and tool result. */
  messages: LlmMessage[];
  /** Model calls made. */
  steps: number;
  stopReason: LoopStop;
  usage: LlmUsage;
  /** Names of the tools the model called, in order (denied ones included). */
  toolNames: string[];
  /** True when the last response asked for tools that never ran (step limit, max_tokens). */
  unrunTools: boolean;
  /** The models that served the responses, as reported, in order of first use. */
  models: string[];
  /** True when any response came from the API's refusal fallback. */
  fallback: boolean;
}

/**
 * The generic tool loop (Brain and Envoy). One step = one model call. Every tool_use in a
 * response gets exactly one tool_result, all in one user message, in order. Assistant
 * content goes back verbatim (thinking blocks included).
 */
export async function runToolLoop<C>(o: ToolLoopOptions<C>): Promise<ToolLoopResult> {
  const messages = [...o.messages];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const toolNames: string[] = [];
  const models: string[] = [];
  let fallback = false;
  const tools = o.tools.llmTools();
  let steps = 0;
  const stopped = (stopReason: LoopStop, finalText = '', unrunTools = false): ToolLoopResult => ({
    finalText,
    messages,
    steps,
    stopReason,
    usage,
    toolNames,
    unrunTools,
    models,
    fallback,
  });

  while (true) {
    const left = o.deadline ? o.deadline.at.getTime() - o.deadline.now().getTime() : undefined;
    if (left !== undefined && left <= 0) return stopped('deadline');
    let res: LlmResponse;
    try {
      res = await o.llm.complete({
        system: o.system,
        ...(o.systemDynamic ? { systemDynamic: o.systemDynamic } : {}),
        messages,
        tools,
        maxTokens: o.maxTokens,
        meta: o.meta,
        ...(left !== undefined ? { timeoutMs: left } : {}),
      });
    } catch (err) {
      if (isLlmError(err) && err.code === 'deadline') return stopped('deadline');
      throw err;
    }
    steps += 1;
    addUsage(usage, res);
    if (res.model !== undefined && !models.includes(res.model)) models.push(res.model);
    if (res.fallback) fallback = true;
    messages.push({ role: 'assistant', content: res.content });
    const asked = res.content.some(isToolUse);
    const done = (stopReason: LoopStop, finalText = textOf(res.content)) => stopped(stopReason, finalText, asked);

    if (res.stopReason === 'refusal') return done('refusal', '');
    if (res.stopReason === 'pause_turn') {
      if (steps >= o.maxSteps) return done('max_steps');
      continue;
    }
    // A truncated (max_tokens) response may hold a cut-off tool call: never run it.
    if (res.stopReason !== 'tool_use') return done(res.stopReason);
    const calls = res.content.filter(isToolUse);
    if (calls.length === 0) return done(res.stopReason);
    if (steps >= o.maxSteps) return done('max_steps');

    const results: LlmBlock[] = [];
    for (const call of calls) {
      // One door: what the model wrote is made storable before anything sees it (the
      // assistant content above, echoed back to the API, stays as it came).
      const clean: ToolCall = { id: storable(call.id), name: storable(call.name), input: storableInput(call.input) as Record<string, unknown> };
      toolNames.push(clean.name);
      results.push(await runCall(o, clean, call.id));
    }
    messages.push({ role: 'user', content: results });
  }
}

async function runCall<C>(o: ToolLoopOptions<C>, call: ToolCall, toolUseId: string): Promise<LlmBlock> {
  const result = (content: string, isError = false): LlmBlock => ({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  const tool = o.tools.get(call.name);
  if (!tool) {
    await o.onDenied?.(call, 'unknown_tool');
    return result(`There is no tool named ${JSON.stringify(call.name.slice(0, 64))}.`, true);
  }
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    await o.onDenied?.(call, 'invalid_input');
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return result(`Invalid input: ${where}${issue?.message ?? 'does not match the schema'}`.slice(0, 300), true);
  }
  try {
    return result(await o.execute(tool, parsed.data, call));
  } catch (err) {
    return result(safeToolMessage(err), true);
  }
}

/**
 * Tool input from the model, made storable (Postgres rejects U+0000 and lone surrogates):
 * a deep copy in which every string and every object key goes through storable(). Real
 * surrogate pairs, numbers, booleans and null are unchanged; a second pass changes nothing.
 */
export function storableInput(value: unknown): unknown {
  if (typeof value === 'string') return storable(value);
  if (Array.isArray(value)) return value.map(storableInput);
  // fromEntries defines own properties, so a key named __proto__ stays a plain key.
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k), storableInput(v)]));
  return value;
}

function isToolUse(b: LlmBlock): b is ToolCall & LlmBlock {
  return b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string';
}

function textOf(content: LlmBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function addUsage(total: LlmUsage, res: LlmResponse): void {
  if (!res.usage) return;
  total.inputTokens += res.usage.inputTokens;
  total.outputTokens += res.usage.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (res.usage.cacheReadTokens ?? 0);
  total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (res.usage.cacheWriteTokens ?? 0);
}
