import type { LlmBlock, LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import type { Persona, TestWorld } from '../../helpers/world.js';
import { lastResults, respond, stepOf, toolUse } from '../brain/script.js';

export { lastResults, respond, stepOf, toolUse };

/** Friday Nov 13 2026 in America/New_York (the world clock starts Mon Nov 9, 4:00 AM there). */
export const FRI = {
  windowStart: '2026-11-13T00:00:00-05:00',
  windowEnd: '2026-11-14T00:00:00-05:00',
  dinner: { start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' },
};

export const dinnerEvent = (extra: Record<string, unknown> = {}) => ({ title: 'Dinner', ...FRI.dinner, location: "Luigi's", calendars: 'both', ...extra });

/** The Envoy's context text (its one user message). */
export function contextOf(req: LlmRequest): string {
  const first = req.messages[0];
  return typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? '');
}

/** proposal_seq of the latest proposal made by the other side, as the Envoy sees it. */
export function peerProposalSeq(req: LlmRequest): number | null {
  const all = [...contextOf(req).matchAll(/\] (?!You )[^\n]*? proposed \(proposal_seq (\d+)\)/g)];
  return all.length ? Number(all.at(-1)![1]) : null;
}

export type EnvoyStep = string | LlmBlock[] | ((req: LlmRequest) => LlmResponse | LlmBlock[]);

/**
 * Scripts the Envoy of `p`: `decide(req)` returns the steps of the turn this request belongs
 * to (stateless, so a retried turn replays the same script); step i of the turn answers it.
 */
export function scriptEnvoy(w: TestWorld, p: Persona, decide: (req: LlmRequest) => EnvoyStep[]): void {
  w.llm.on({ agentId: p.agent.id, mind: 'envoy' }, (req) => {
    const steps = decide(req);
    const s = steps[Math.min(stepOf(req), steps.length - 1)]!;
    if (typeof s === 'function') {
      const r = s(req);
      return Array.isArray(r) ? respond(r) : r;
    }
    return typeof s === 'string' ? respond([{ type: 'text', text: s }]) : respond(s);
  });
}

export function envoyCalls(w: TestWorld, p?: Persona): LlmRequest[] {
  return w.llm.calls.filter((c) => c.meta.mind === 'envoy' && (!p || c.meta.agentId === p.agent.id));
}

export async function a2aMessages(w: TestWorld): Promise<Array<{ seq: number; kind: string; body: string; from_agent_id: string | null; payload: Record<string, unknown> }>> {
  return (await w.db.query<{ seq: number; kind: string; body: string; from_agent_id: string | null; payload: Record<string, unknown> }>(
    'SELECT seq, kind, body, from_agent_id, payload FROM a2a_messages ORDER BY conversation_id, seq',
  )).rows;
}

export async function onlyConversation(w: TestWorld) {
  const res = await w.db.query<{ id: string; status: string; close_reason: string | null }>('SELECT id, status, close_reason FROM a2a_conversations');
  if (res.rows.length !== 1) throw new Error(`expected one conversation, got ${res.rows.length}`);
  return res.rows[0]!;
}

/** Alex's Brain opens "Dinner Friday" with Sam (step 0), then replies. */
export function alexOpensDinner(w: TestWorld, brief = 'Alex would like dinner with Sam on Friday evening.'): void {
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) =>
    stepOf(req) === 0
      ? respond([toolUse('b1', 'talk_to_agent', { with: 'Sam', topic: 'Dinner Friday', brief, window_start: FRI.windowStart, window_end: FRI.windowEnd })])
      : respond([{ type: 'text', text: "I've asked Sam's Violet." }]),
  );
}

/** Sam's Envoy checks availability then proposes dinner; Alex's Envoy checks then accepts. */
export function honestDinnerEnvoys(w: TestWorld, event = dinnerEvent()): void {
  scriptEnvoy(w, w.sam, (req) =>
    peerProposalSeq(req) === null && !/You proposed/.test(contextOf(req))
      ? [[toolUse('s1', 'check_availability', { start: FRI.windowStart, end: FRI.windowEnd })], [toolUse('s2', 'propose', { summary: 'Dinner on Friday at 7', events: [event] })], 'done']
      : ['nothing to add'],
  );
  scriptEnvoy(w, w.alex, (req) => {
    const seq = peerProposalSeq(req);
    return seq === null ? ['waiting'] : [[toolUse('a1', 'check_availability', { start: FRI.windowStart, end: FRI.windowEnd })], [toolUse('a2', 'accept', { proposal_seq: seq })], 'done'];
  });
}
