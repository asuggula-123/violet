/**
 * Shared setup for the owner's three acceptance tests. The tests drive Violet only through
 * what the outside world touches — inbound texts, the fake calendars and mailboxes, the clock
 * and one scripted model per mind — and look only at what the outside world sees, plus the
 * stored transcript and action log as evidence.
 */
import type { LlmBlock, LlmRequest, LlmResponse } from '../../src/llm/types.js';
import { LINE_HEAD_LOOKALIKES } from '../../src/brain/lineHeadLookalikes.js';
import type { Persona, TestWorld } from '../helpers/world.js';
import { contextOf, envoyCalls, peerProposalSeq } from '../unit/a2a/helpers.js';
import { lastResults, respond, stepOf, toolUse } from '../unit/brain/script.js';

export { contextOf, envoyCalls, lastResults, peerProposalSeq, respond, stepOf, toolUse };

/** One step of a scripted turn: a final text, assistant content, or a function of the request. */
export type Step = string | LlmBlock[] | ((req: LlmRequest) => LlmBlock[] | string);

/**
 * Scripts one mind of `p`'s agent. `turn(req)` returns the steps of the turn this request
 * belongs to (stateless, so a retried turn replays the same script); step i answers it.
 */
export function script(w: TestWorld, p: Persona, mind: 'brain' | 'envoy', turn: (req: LlmRequest) => Step[]): void {
  w.llm.on({ agentId: p.agent.id, mind }, (req): LlmResponse => {
    const steps = turn(req);
    let s = steps[Math.min(stepOf(req), steps.length - 1)]!;
    if (typeof s === 'function') s = s(req);
    return typeof s === 'string' ? respond([{ type: 'text', text: s }]) : respond(s);
  });
}

export const callsOf = (w: TestWorld, p: Persona, mind?: 'brain' | 'envoy'): LlmRequest[] =>
  w.llm.calls.filter((c) => c.meta.agentId === p.agent.id && (!mind || c.meta.mind === mind));

/** The owner's message this Brain request answers (the last user turn that is not tool results). */
export function ownerTextOf(req: LlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (m.content.every((b) => b.type === 'tool_result')) continue;
    return m.content.map((b) => (b.type === 'text' ? String(b.text) : '')).join('\n');
  }
  return '';
}

/** Every string a request carries to the model: system, dynamic system, texts, tool inputs and results. */
export function textsOf(req: LlmRequest): string[] {
  const out = [req.system, req.systemDynamic ?? ''];
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      out.push(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') out.push(String(b.text));
      else if (b.type === 'tool_result') out.push(String(b.content));
      else if (b.type === 'tool_use') out.push(JSON.stringify(b.input));
    }
  }
  return out;
}

/** What is left of a model-facing text once every <untrusted …>…</untrusted> block is cut out. */
export function outsideUntrusted(text: string): string {
  return text.replace(/<untrusted source="[a-z]+">[\s\S]*?<\/untrusted>/g, '');
}

/** The last tool results of a request, by tool_use id. */
export function resultOf(req: LlmRequest, id: string): string {
  return lastResults(req).find((r) => r.tool_use_id === id)?.content ?? '';
}

/** A text with every quoted (“…”) part blanked: what code wrote around third-party text. */
export function skeleton(text: string): string {
  return text.replace(/“[^”\n]*”/g, '“…”');
}

/** Every line break a reader sees. */
export const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029\u0085\v\f]/;

/**
 * What a reader sees in a line, independently of the product's own folding: compatibility
 * forms folded, invisibles and combining marks dropped, and the Latin letters and colon that
 * Cyrillic, Greek and other look-alikes imitate.
 */
const LOOKS_LIKE: Record<string, string> = {
  'т': 't', 'τ': 't', 'ᴛ': 't', 'о': 'o', 'ο': 'o', 'օ': 'o', 'ᴏ': 'o', '0': 'o', 'ԁ': 'd', 'ᴅ': 'd', 'а': 'a', 'α': 'a', 'ᴀ': 'a',
  'у': 'y', 'γ': 'y', 'ү': 'y', 'υ': 'y', 'ʏ': 'y', 'ѕ': 's', 'ꜱ': 's', 'е': 'e', 'ε': 'e', 'ᴇ': 'e', 'м': 'm', 'μ': 'm', 'ᴍ': 'm',
  '∶': ':', '꞉': ':', '։': ':', '˸': ':', '׃': ':', '᛬': ':', 'ː': ':', '⁚': ':', '᠄': ':', 'ꓽ': ':',
  '⌗': '#', '⋕': '#', '♯': '#', 'р': 'p', 'ρ': 'p', 'і': 'i', 'ӏ': 'l',
  // Seen in the wild by the round-2 verifier: Coptic o and mi, Indic zeros, colon-like signs.
  'ⲟ': 'o', '०': 'o', '౦': 'o', 'ⲙ': 'm', 'Տ': 's', '⦂': ':', '፡': ':', 'ः': ':',
};
// Unicode's own confusables data (UTS #39) for the head letters and the colon.
for (const [letter, cps] of Object.entries(LINE_HEAD_LOOKALIKES)) for (const cp of cps) LOOKS_LIKE[String.fromCodePoint(cp)] ??= letter;
export function asSeen(line: string): string {
  // Each character as written, then in its other case (`Տ` reads as S; its lowercase `տ` does not look like s).
  const one = (c: string) => LOOKS_LIKE[c] ?? LOOKS_LIKE[c.toUpperCase()] ?? LOOKS_LIKE[c.toLowerCase()];
  const folded = [...line.normalize('NFKC')].map((c) => one(c) ?? c).join('');
  return [...folded.toLowerCase().normalize('NFKD').replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '')].map((c) => one(c) ?? c).join('');
}

// ---------------------------------------------------------------------------------------
// Time. The world clock starts Mon Nov 9 2026, 4:00 AM in New York (EST, UTC-5).

const EST_MS = 5 * 3_600_000;

/** `2026-11-13T19:00:00-05:00` for an instant (New York in November). */
export function est(ms: number | Date): string {
  const t = typeof ms === 'number' ? ms : ms.getTime();
  return `${new Date(t - EST_MS).toISOString().slice(0, 19)}-05:00`;
}

export const at = (local: string): Date => new Date(`${local}-05:00`);

export const FRIDAY = {
  start: '2026-11-13T00:00:00-05:00',
  end: '2026-11-14T00:00:00-05:00',
  eveningStart: '2026-11-13T17:00:00-05:00',
  eveningEnd: '2026-11-13T23:00:00-05:00',
};

export interface Interval {
  start: number;
  end: number;
}

/** Busy intervals from a check_availability result (`- <iso> → <iso>` lines). */
export function busyFrom(result: string): Interval[] {
  return [...result.matchAll(/^- (\S+) → (\S+)$/gm)].map((m) => ({ start: Date.parse(m[1]!), end: Date.parse(m[2]!) }));
}

/** Free gaps inside [from, to) around the busy intervals. */
export function gaps(busy: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  let cursor = from;
  for (const b of [...busy].sort((x, y) => x.start - y.start)) {
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, to) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < to) out.push({ start: cursor, end: to });
  return out.filter((g) => g.end > g.start);
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x.start, y.start);
    const e = Math.min(x.end, y.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** `start/end` pairs, the way the scripted Envoys tell each other free time. */
export const slotText = (xs: Interval[]): string => xs.map((x) => `${est(x.start)}/${est(x.end)}`).join(', ');
export const slotsFrom = (text: string): Interval[] =>
  [...text.matchAll(/(\d{4}-\d\d-\d\dT[\d:]+-05:00)\/(\d{4}-\d\d-\d\dT[\d:]+-05:00)/g)].map((m) => ({ start: Date.parse(m[1]!), end: Date.parse(m[2]!) }));

// ---------------------------------------------------------------------------------------
// Evidence.

/** Conversations in the order they were opened (the FakeClock gives many the same created_at). */
const OPEN_ORDER = `(SELECT min(l.id) FROM action_log l WHERE l.action = 'a2a.opened' AND l.detail->>'conversationId' = c.id)`;

export async function conversations(w: TestWorld): Promise<Array<{ id: string; status: string; close_reason: string | null }>> {
  return (await w.db.query<never>(`SELECT c.id, c.status, c.close_reason FROM a2a_conversations c ORDER BY ${OPEN_ORDER}`)).rows;
}

/** Every stored agent-to-agent message, conversations in the order they were opened. */
export async function a2aRows(w: TestWorld): Promise<Array<{ conversation_id: string; seq: number; kind: string; body: string; from_agent_id: string | null; private_to: string | null; payload: Record<string, unknown> }>> {
  return (
    await w.db.query<never>(
      `SELECT m.conversation_id, m.seq, m.kind, m.body, m.from_agent_id, m.private_to, m.payload
       FROM a2a_messages m JOIN a2a_conversations c ON c.id = m.conversation_id ORDER BY ${OPEN_ORDER}, m.seq`,
    )
  ).rows;
}

export async function approvalsOf(w: TestWorld, p: Persona): Promise<Array<{ id: string; ref: number; kind: string; status: string; prompt: string }>> {
  return (await w.db.query<never>('SELECT id, ref, kind, status, prompt FROM approvals WHERE agent_id = $1 ORDER BY ref', [p.agent.id])).rows;
}

/** Texts sent to an address, with their purpose. */
export const sentTo = (w: TestWorld, address: string) => w.transport.sent.filter((m) => m.toAddress === address);

/** A persona's name for an agent id ('?' for none), so two worlds can be compared. */
export function nameOf(w: TestWorld, agentId: string | null): string {
  if (agentId === w.alex.agent.id) return 'Alex';
  if (agentId === w.sam.agent.id) return 'Sam';
  return agentId === null ? '-' : '?';
}
