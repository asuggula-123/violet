import { z } from 'zod';
import type { LlmTool } from './types.js';

/**
 * A tool the model may call. `input` validates the call (and becomes the JSON Schema
 * the API sees). `taints`: the result carries third-party text. `sideEffect`: the call
 * changes something (callers memoize these so a retried turn does not repeat them).
 */
export interface ToolDef<C, I = any> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  taints?: boolean;
  sideEffect?: boolean;
  handler(input: I, ctx: C): Promise<string>;
}

/** Throw this (or any error with a string `ownerMessage`) to give the model a specific, safe reason. */
export class ToolError extends Error {
  constructor(readonly ownerMessage: string) {
    super(ownerMessage);
  }
}

export const GENERIC_TOOL_FAILURE = 'That tool failed. Try again later, or carry on without it.';

/** The text the model sees for a failed tool call. Never leaks internals. */
export function safeToolMessage(err: unknown): string {
  const m = typeof err === 'object' && err !== null ? (err as { ownerMessage?: unknown }).ownerMessage : undefined;
  return typeof m === 'string' && m.trim() !== '' ? m.slice(0, 300) : GENERIC_TOOL_FAILURE;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Ordered set of tools. Later milestones add theirs with register(). */
export class ToolRegistry<C> {
  private readonly defs = new Map<string, ToolDef<C>>();
  private schemas: LlmTool[] | null = null;

  register<I>(def: ToolDef<C, I>): this {
    if (!TOOL_NAME.test(def.name)) throw new Error(`invalid tool name: ${def.name}`);
    if (this.defs.has(def.name)) throw new Error(`tool already registered: ${def.name}`);
    this.defs.set(def.name, def as ToolDef<C>);
    this.schemas = null;
    return this;
  }

  get(name: string): ToolDef<C> | undefined {
    return this.defs.get(name);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  /** Definitions for the API, in registration order (stable, so the prompt cache holds). */
  llmTools(): LlmTool[] {
    this.schemas ??= [...this.defs.values()].map((d) => ({ name: d.name, description: d.description, input_schema: jsonSchema(d.input) }));
    return this.schemas;
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}
