/**
 * Seam (I19 x I20) helpers: a tainted Brain turn that asks for releases, and small shorthands.
 */
import type { LlmBlock, LlmRequest } from '../../../src/llm/types.js';
import type { Persona, TestWorld } from '../../helpers/world.js';
import { FRI, respond, stepOf, toolUse } from '../a2a/helpers.js';

export const REPLY = "I'll check with you first.";
export const SECRET = "Don't tell Sam, but I'm planning a surprise party Saturday";
export const DINNER = { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' };
export const DINNER_PROMPT = (ref: number) => `#${ref} Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.`;
export const OPEN_PROMPT = (ref: number, topic: string, text: string) => `#${ref} Tell Sam's Violet about “${topic}”: “${text}” Send? Reply yes or no.`;
export const GUIDE_PROMPT = (ref: number, text: string) => `#${ref} Tell Sam's Violet: “${text}” Send? Reply yes or no.`;

export const talk = (id: string, topic: string, brief: string): LlmBlock => toolUse(id, 'talk_to_agent', { with: 'Sam', topic, brief });
export const tell = (id: string, conversation: string, guidance: string): LlmBlock => toolUse(id, 'tell_envoy', { conversation, guidance });
export const book = (id: string): LlmBlock => toolUse(id, 'request_calendar_event', DINNER);

/**
 * Scripts a tainted turn for every message of `p`: step 0 reads the calendar (third-party
 * text: the turn is tainted, I11), step 1 makes `calls`, step 2 replies `reply`.
 * `calls` may read the request (e.g. a conversation id from an earlier result).
 */
export function taintedTurn(w: TestWorld, p: Persona, calls: LlmBlock[] | ((req: LlmRequest) => LlmBlock[]), reply = REPLY): void {
  w.llm.on({ agentId: p.agent.id, mind: 'brain' }, (req) => {
    const step = stepOf(req);
    if (step === 0) return respond([toolUse('r', 'get_schedule', { from: FRI.windowStart, to: FRI.windowEnd })]);
    if (step === 1) return respond(typeof calls === 'function' ? calls(req) : calls);
    return respond([{ type: 'text', text: reply }]);
  });
}

/** Everything Sam's side could see or receive: his agent's model calls and his phone. */
export function samSide(w: TestWorld): string {
  return JSON.stringify([w.llm.calls.filter((c) => c.meta.agentId === w.sam.agent.id), w.textsTo(w.sam.address)]);
}

/** Every a2a message row (both directions), in order. */
export async function a2aBodies(w: TestWorld): Promise<Array<{ kind: string; body: string }>> {
  return (await w.db.query<{ kind: string; body: string }>('SELECT kind, body FROM a2a_messages ORDER BY conversation_id, seq')).rows;
}

/** The owners' typed messages, in order: [who, text]. */
export async function ownerMessages(w: TestWorld): Promise<Array<[string, string]>> {
  const rows = (
    await w.db.query<{ agent_id: string; body: string }>("SELECT agent_id, body FROM messages WHERE thread = 'owner' AND direction = 'in' ORDER BY seq")
  ).rows;
  return rows.map((m) => [m.agent_id === w.alex.agent.id ? 'Alex' : 'Sam', m.body]);
}

export async function statusByRef(w: TestWorld, p: Persona, ref: number): Promise<string | undefined> {
  return (await w.db.query<{ status: string }>('SELECT status FROM approvals WHERE agent_id = $1 AND ref = $2', [p.agent.id, ref])).rows[0]?.status;
}

/** Opens Alex's "Lunch" conversation from a clean (untainted) turn; returns its id. */
export async function cleanOpen(w: TestWorld): Promise<string> {
  w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, (req) => (stepOf(req) === 0 ? respond([talk('o', 'Lunch', 'Lunch with Sam this week?')]) : respond([{ type: 'text', text: 'Asked.' }])));
  await w.ownerSays(w.alex, 'Ask Sam about lunch this week');
  return (await w.db.query<{ id: string }>('SELECT id FROM a2a_conversations ORDER BY created_at LIMIT 1')).rows[0]!.id;
}
