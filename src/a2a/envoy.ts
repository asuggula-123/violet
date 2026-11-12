import type { Logger } from 'pino';
import type { FlagService } from '../core/flags.js';
import { sanitize } from '../core/sanitize.js';
import { addMs } from '../clock.js';
import { isLlmError } from '../llm/errors.js';
import { runToolLoop, type ToolLoopResult } from '../llm/toolLoop.js';
import { ToolRegistry } from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import { isRefusal } from './deps.js';
import { envoyDynamic, envoyMessages, envoySystem } from './envoyPrompt.js';
import { envoyTools, type EnvoyCtx, type EnvoyDeps } from './envoyTools.js';
import { shown } from './render.js';
import { a2aRepo } from './repo.js';

export const ENVOY_MAX_STEPS = 6;
export const ENVOY_MAX_TOKENS = 8_000;
/**
 * E1: wall-clock bound of one Envoy turn, below the job stale time (10 min), as the Brain's
 * (R16): no model call starts after it and a call in flight is cut off at it, so the tools of a
 * cut-off call never run (nothing is said, proposed or accepted by it). A turn that ends with
 * no act is handled as any no-act turn: the side is marked stalled and its owner told (digest).
 */
export const ENVOY_TURN_MS = 5 * 60_000;
export const ENVOY_TOOL_NAMES = ['check_availability', 'say', 'propose', 'accept', 'decline', 'ask_owner', 'end_conversation'] as const;

export interface TurnJob {
  conversationId: string;
  agentId: string;
  seq: number;
}

/**
 * The Envoy (principle 2): the low-privilege mind that talks to the other agent. One turn
 * per delivery, idempotent per (conversation, agent, seq) like a Brain turn: a finished
 * turn never re-runs, and its outward act is the message carrying its turn key, written at
 * most once (a2a_messages.turn_key is unique), so a retry can never act twice.
 */
export function createEnvoy(d: EnvoyDeps & { llm: LlmClient; flags: FlagService; log: Logger }) {
  const tools = new ToolRegistry<EnvoyCtx>();
  for (const t of envoyTools(d)) tools.register(t);
  const repo = a2aRepo(d.db);

  const log = (agentId: string, action: string, detail: Record<string, unknown>) => d.actionLog.write({ agentId, actor: 'envoy', action, detail });

  async function setStatus(key: string, status: 'waiting' | 'done', outcome: string | null): Promise<void> {
    await d.db.query(`UPDATE a2a_turns SET status = $2, outcome = $3, finished_at = $4 WHERE turn_key = $1 AND status <> 'done'`, [
      key,
      status,
      outcome,
      status === 'done' ? d.clock.now() : null,
    ]);
  }

  /** Records the turn; returns false if it already finished. */
  async function begin(key: string, job: TurnJob): Promise<boolean> {
    await d.db.query(
      `INSERT INTO a2a_turns (turn_key, conversation_id, agent_id, trigger_seq, status, created_at) VALUES ($1, $2, $3, $4, 'running', $5)
       ON CONFLICT (turn_key) DO UPDATE SET status = 'running' WHERE a2a_turns.status <> 'done'`,
      [key, job.conversationId, job.agentId, job.seq, d.clock.now()],
    );
    const res = await d.db.query<{ status: string }>('SELECT status FROM a2a_turns WHERE turn_key = $1', [key]);
    return res.rows[0]?.status !== 'done';
  }

  async function waiting(key: string, job: TurnJob): Promise<void> {
    await d.db.query(
      `INSERT INTO a2a_turns (turn_key, conversation_id, agent_id, trigger_seq, status, created_at) VALUES ($1, $2, $3, $4, 'waiting', $5)
       ON CONFLICT (turn_key) DO UPDATE SET status = 'waiting' WHERE a2a_turns.status <> 'done'`,
      [key, job.conversationId, job.agentId, job.seq, d.clock.now()],
    );
  }

  /** No outward act: nothing goes to the peer; the side is marked stalled and its owner told once (digest). */
  async function stall(ctx: EnvoyCtx): Promise<void> {
    await d.db.query('UPDATE a2a_sides SET stalled = true WHERE conversation_id = $1 AND agent_id = $2', [ctx.conv.id, ctx.side.agent_id]);
    await d.flags.raise(ctx.side.agent_id, {
      kind: 'a2a_stalled',
      urgency: 'digest',
      text: `${sanitize(ctx.parties.me.agent.name, 40)} ↔ ${ctx.parties.peerLabel} (${shown(ctx.conv.topic, 80)}) is stuck and needs your guidance.`,
      dedupeKey: `a2a-stalled:${ctx.conv.id}:${ctx.side.agent_id}`,
    });
  }

  async function runTurn(job: TurnJob): Promise<void> {
    const key = `${job.conversationId}:${job.agentId}:${job.seq}`;
    const agent = await (await d.db.query<{ paused: boolean }>('SELECT paused FROM agents WHERE id = $1', [job.agentId])).rows[0];
    if (!agent) return;
    // I14: a paused agent's Envoy does not run; the delivery waits for onResume.
    if (agent.paused) return waiting(key, job);
    if (!(await begin(key, job))) return;
    if (await repo.byTurnKey(key)) return setStatus(key, 'done', 'acted');
    const conv = await repo.conversation(job.conversationId);
    const side = conv ? await repo.side(conv.id, job.agentId) : null;
    if (!conv || !side || conv.status !== 'open') return setStatus(key, 'done', 'not_open');

    const parties = await repo.parties(conv, job.agentId);
    const ctx: EnvoyCtx = { conv, side, parties, now: d.clock.now(), turnKey: key, acted: null, paused: false };
    const rows = await repo.visible(conv.id, job.agentId);
    let result: ToolLoopResult | null = null;
    let outcome: string;
    try {
      result = await runToolLoop({
        llm: d.llm,
        system: envoySystem(parties),
        systemDynamic: envoyDynamic(conv, side, parties, ctx.now),
        messages: envoyMessages(side, parties, rows),
        tools,
        execute: async (tool, input) => {
          try {
            return await tool.handler(input, ctx);
          } catch (err) {
            if (isRefusal(err)) {
              await log(job.agentId, err.limit ? 'a2a.limit' : 'a2a.tool_denied', { conversationId: conv.id, tool: tool.name, [err.limit ? 'limit' : 'reason']: err.reason });
            }
            throw err;
          }
        },
        onDenied: (call, reason) => log(job.agentId, 'a2a.tool_denied', { conversationId: conv.id, tool: sanitize(String(call.name), 64), reason }),
        maxSteps: ENVOY_MAX_STEPS,
        maxTokens: ENVOY_MAX_TOKENS,
        meta: { agentId: job.agentId, mind: 'envoy', conversationId: conv.id },
        deadline: { at: addMs(ctx.now, ENVOY_TURN_MS), now: () => d.clock.now() },
      });
      outcome = ctx.acted ? 'acted' : 'no_act';
    } catch (err) {
      if (!isLlmError(err) || err.retryable) throw err; // the job retries the turn
      outcome = 'model_error';
    }
    await log(job.agentId, 'a2a.envoy_turn', {
      conversationId: conv.id,
      seq: job.seq,
      outcome: ctx.paused ? 'paused' : outcome,
      act: ctx.acted,
      stopReason: result?.stopReason ?? null,
      tools: (result?.toolNames ?? []).map((n) => sanitize(n, 64)),
      usage: result?.usage ?? null,
      models: (result?.models ?? []).map((m) => sanitize(m, 64)),
      fallback: result?.fallback ?? false,
    });
    if (ctx.paused && !ctx.acted) return waiting(key, job);
    if (!ctx.acted) await stall(ctx);
    await setStatus(key, 'done', ctx.acted ? 'acted' : outcome);
  }

  return { tools, runTurn };
}
