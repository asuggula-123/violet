import type { App } from '../app.js';
import { addMs } from '../clock.js';
import { BRAIN_TURN_MS, runInTurn } from '../approvals/turn.js';
import { storable } from '../core/outbound.js';
import type { OwnerMessageCtx } from '../core/router.js';
import { sanitize } from '../core/sanitize.js';
import { isLlmError } from '../llm/errors.js';
import { runToolLoop, type ToolCall, type ToolLoopResult } from '../llm/toolLoop.js';
import { ToolRegistry, type ToolDef } from '../llm/tools.js';
import { historyTainted, loadOwnerThread, toTurns, unrecordedTaint } from './history.js';
import { canonicalJson, sha256, turnMemo } from './memo.js';
import { dynamicPrompt, stablePrompt } from './prompt.js';
import { foldReservedLineHeads } from './lineHeads.js';
import { neutralizeReply } from './reply.js';
import { calendarTools } from './tools/calendar.js';
import { emailTools } from './tools/email.js';
import { memoryTools } from './tools/memory.js';
import type { Brain, BrainContextProvider, BrainToolCtx, TurnState } from './types.js';

export const BRAIN_MAX_STEPS = 10;
export const BRAIN_MAX_TOKENS = 16_000;
/** R16: the turn's wall-clock bound (approvals/turn.ts, where the turn hold is derived from it). */
export { BRAIN_TURN_MS } from '../approvals/turn.js';

/** Fixed texts the Brain sends when the model cannot give an answer. */
export const BRAIN_TEXT = Object.freeze({
  notConnected: "My AI model isn't connected yet, so I can't answer that. Yes/no answers to my questions, pause and resume still work.",
  modelFailed: "Sorry, something went wrong on my side and I couldn't answer that. Please try again in a bit.",
  refusal: "Sorry, I can't help with that one.",
  maxSteps: 'That needed more steps than I can take in one go. Could you split it into smaller asks?',
  tooLong: 'My answer got too long. Could you narrow the question down?',
  tooMuch: 'That needed more reading than I can hold at once. Could you narrow the question down?',
  tookTooLong: 'That took longer than I can spend on one message, so I stopped. Could you split it into smaller asks?',
  stopped: "I had to stop before I finished that. Could you ask again, maybe in smaller steps?",
});

/** The fixed notice for each way a loop can stop early (any other stop reason gets `stopped`). */
const STOP_TEXT: Record<string, string> = {
  max_steps: BRAIN_TEXT.maxSteps,
  max_tokens: BRAIN_TEXT.tooLong,
  model_context_window_exceeded: BRAIN_TEXT.tooMuch,
  deadline: BRAIN_TEXT.tookTooLong,
};

/**
 * The text that goes to the owner for a finished loop ('' = send nothing). A loop that stopped
 * early always ends with a fixed notice, so the owner knows; model text written next to tool
 * calls that never ran ("Booking it now.") is dropped, as nothing it promises happened.
 */
function replyText(r: ToolLoopResult): string {
  if (r.stopReason === 'refusal') return BRAIN_TEXT.refusal;
  if (r.stopReason === 'end_turn' || r.stopReason === 'stop_sequence') return r.finalText;
  const notice = STOP_TEXT[r.stopReason] ?? BRAIN_TEXT.stopped;
  const said = r.unrunTools ? '' : r.finalText;
  return said ? `${said}\n\n${notice}` : notice;
}

export function createBrain(app: App): Brain {
  const { approvals } = app;
  if (!approvals) throw new Error('the Brain needs the approvals module (install approvalsModule first)');
  const { db, clock, llm, calendar, gmail, log } = app.deps;
  const { repos, actionLog, flags, gateway } = app;
  const memo = turnMemo(db, clock);
  const approvalKinds = approvals;

  const tools = new ToolRegistry<BrainToolCtx>();
  const contextProviders: BrainContextProvider[] = [];
  const beforePrompts: Brain['beforePrompts'] = [];
  const pending = (agentId: string) => approvals.listPending(agentId);
  const deps = { db, clock, repos, calendar, gmail, approvals, flags, actionLog };
  for (const def of [...calendarTools(deps), ...emailTools(deps), ...memoryTools(deps)]) tools.register(def);

  async function handle(ctx: OwnerMessageCtx): Promise<void> {
    const { agent, owner, messageId } = ctx;
    if (await memo.begin(messageId, agent.id)) return; // finished before: never re-run, never reply twice

    const turn: TurnState = { messageId, ownerText: ctx.msg.text, tainted: false };
    const seen = new Map<string, number>();
    const logEntry = (action: string, detail: Record<string, unknown>) => actionLog.write({ agentId: agent.id, actor: 'brain', action, detail: { messageId, ...detail } });

    async function execute(tool: ToolDef<BrainToolCtx>, input: unknown, call: ToolCall): Promise<string> {
      const inputHash = sha256(canonicalJson(input));
      const occurrence = (seen.get(`${tool.name}:${inputHash}`) ?? 0) + 1;
      seen.set(`${tool.name}:${inputHash}`, occurrence);
      const toolCtx: BrainToolCtx = { agent, owner, turn, now: clock.now(), callKey: `brain:${messageId}:${tool.name}:${inputHash}:${occurrence}` };
      let memoized = false;
      let out: string;
      try {
        const prior = tool.sideEffect ? await memo.recall(messageId, tool.name, inputHash, occurrence) : null;
        if (prior !== null) {
          memoized = true;
          out = prior;
        } else {
          out = await tool.handler(input, toolCtx);
          if (tool.sideEffect) await memo.store(messageId, tool.name, inputHash, occurrence, out);
        }
      } catch (err) {
        log.warn({ agentId: agent.id, tool: tool.name, err: err instanceof Error ? err.message : String(err) }, 'brain tool failed');
        await logEntry('tool.call', { tool: tool.name, toolUseId: call.id, ok: false, error: err instanceof Error ? err.name : 'error' });
        throw err;
      }
      if (tool.taints) turn.tainted = true;
      await logEntry('tool.call', { tool: tool.name, toolUseId: call.id, ok: true, memoized });
      return out;
    }

    // I11: third-party text in the context (tainted history rows, prompts quoting other
    // agents, open Envoy questions) taints the turn before any tool runs.
    const rows = await loadOwnerThread(db, agent.id, messageId);
    const history = toTurns(rows, ctx.msg.text);
    const waiting = await pending(agent.id);
    // P4: an approval a tainted turn requested may carry third-party words: untrusted as well.
    const thirdParty = (a: { kind: string; tainted: boolean }) => approvalKinds.untrusted(a);
    const extra: string[] = [];
    for (const provide of contextProviders) {
      const section = await provide(agent, owner);
      if (!section) continue;
      extra.push(section.text);
      if (section.tainted) turn.tainted = true;
    }
    if (historyTainted(rows) || waiting.some(thirdParty) || (await unrecordedTaint(db, agent.id))) turn.tainted = true;

    /**
     * I19 prompt-last: approvals requested in this turn were held (turn.ts); they go out after
     * the reply and the turn's notices, so the genuine prompt is directly above the owner's
     * answer. Before finish: a retried turn delivers what an earlier attempt left (once: claimSend).
     * The closing mark is written first: an attempt that runs after it sends no model text.
     */
    async function close(outcome: string): Promise<void> {
      await memo.markClosing(messageId, outcome);
      for (const hook of beforePrompts) await hook(agent.id, messageId);
      await approvalKinds.deliverTurn(agent.id, messageId);
      await memo.finish(messageId, outcome);
    }

    // An earlier attempt (or a duplicate run) already replied and began closing: finish the
    // close only. Re-running the model here would put its text after the turn's prompts.
    const closedBefore = await memo.closing(messageId);
    if (closedBefore !== null) return close(closedBefore);
    // S2: a new attempt of the turn (a job retry, a stale requeue) holds what an earlier attempt left for its full run.
    await approvalKinds.holdTurn(agent.id, messageId);

    let result: ToolLoopResult;
    try {
      result = await runInTurn(messageId, () => runToolLoop({
        llm,
        system: stablePrompt(agent, owner),
        systemDynamic: dynamicPrompt(owner, clock.now(), waiting, thirdParty, extra),
        messages: history,
        tools,
        execute,
        onDenied: (call, reason) => logEntry('tool.denied', { tool: sanitize(String(call.name), 64), toolUseId: String(call.id).slice(0, 100), reason }),
        maxSteps: BRAIN_MAX_STEPS,
        maxTokens: BRAIN_MAX_TOKENS,
        meta: { agentId: agent.id, mind: 'brain' },
        deadline: { at: addMs(clock.now(), BRAIN_TURN_MS), now: () => clock.now() },
      }), () => turn.tainted);
    } catch (err) {
      // Retryable model errors (and anything unexpected) fail the job, which retries.
      if (!isLlmError(err) || err.retryable) throw err;
      await logEntry('brain.turn', { outcome: 'model_error', code: err.code });
      if ((await memo.closing(messageId)) !== null) return close('model_error'); // a duplicate run got there first
      await gateway.sendToOwner(agent.id, err.code === 'unconfigured' ? BRAIN_TEXT.notConnected : BRAIN_TEXT.modelFailed, { purpose: 'reply', meta: { from: 'brain' } });
      await close('model_error');
      return;
    }

    // storable() first: a reply of only NULs is empty once stored, so it is not sent as ''.
    const shaped = storable(foldReservedLineHeads(neutralizeReply(replyText(result))));
    const text = shaped.trim() === '' ? '' : shaped;
    await logEntry('brain.turn', {
      outcome: 'answered',
      stopReason: result.stopReason,
      steps: result.steps,
      tools: result.toolNames.map((n) => sanitize(n, 64)),
      tainted: turn.tainted,
      usage: result.usage,
      models: result.models.map((m) => sanitize(m, 64)),
      fallback: result.fallback,
      replied: text !== '',
    });
    // A reply written in a tainted turn may quote third parties: stored tainted (K1).
    // A duplicate run (stale requeue) that already closed this turn: say nothing more.
    if ((await memo.closing(messageId)) !== null) return close(result.stopReason);
    if (text) await gateway.sendToOwner(agent.id, text, { purpose: 'reply', meta: { from: 'brain', ...(turn.tainted ? { tainted: true } : {}) } });
    await close(result.stopReason);
  }

  return { tools, contextProviders, beforePrompts, handle };
}
