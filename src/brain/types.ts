import type { OwnerMessageCtx } from '../core/router.js';
import type { AgentRow, OwnerRow } from '../core/types.js';
import type { ToolDef, ToolRegistry } from '../llm/tools.js';

/** State of the Brain turn in progress, visible to every tool. */
export interface TurnState {
  /** Id of the owner's inbound message (`messages.id`) this turn answers. */
  messageId: string;
  /** What the owner wrote. */
  ownerText: string;
  /**
   * True once a tool returned third-party text in this turn. A later milestone holds
   * releases to other agents for an owner yes/no while the turn is tainted (I11).
   */
  tainted: boolean;
}

export interface BrainToolCtx {
  agent: AgentRow;
  owner: OwnerRow;
  turn: TurnState;
  now: Date;
  /** Stable per (message, tool, canonical input, occurrence): an idempotency key for side effects. */
  callKey: string;
}

export type BrainTool<I = any> = ToolDef<BrainToolCtx, I>;

export interface Brain {
  /** The Brain's tools. Later milestones add theirs: `app.brain.tools.register(def)`. */
  readonly tools: ToolRegistry<BrainToolCtx>;
  /** One owner turn (installed as router.hooks.onOwnerMessage). Idempotent per ctx.messageId. */
  handle(ctx: OwnerMessageCtx): Promise<void>;
}
