import { promptFits } from '../approvals/service.js';
import { quoteFolded } from '../brain/reply.js';
import { formatDay, formatRange } from '../brain/time.js';
import { quote, sanitize } from '../core/sanitize.js';
import type { A2AMessageRow, Parties } from './types.js';

/**
 * Everything an owner reads about an agent conversation is rendered here, by code (I13).
 * Agent-authored text is sanitized (one line, capped), its number signs before digits and
 * any "reply yes or no" are folded (so it can never look like a live approval prompt), and
 * it is quoted with curly quotes that it cannot close (`quoteFolded`).
 */
export function shown(text: string, max = 300): string {
  return quoteFolded(text, max);
}

export interface ShownEvent {
  title: string;
  start: string;
  end: string;
  location?: string | undefined;
}

export function eventText(e: ShownEvent, timezone: string): string {
  const at = e.location ? ` at ${shown(e.location, 60)}` : '';
  return `${shown(e.title, 60)} — ${formatRange(new Date(e.start), new Date(e.end), timezone)}${at}`;
}

export function eventsText(events: ShownEvent[], timezone: string): string {
  return events.map((e) => eventText(e, timezone)).join('; ');
}

/**
 * The part of an outcome both prompts and follow-up lines share. A zero-event agreement shows
 * its whole summary (I5/I13: the owner's OK is to exactly that text); propose and accept refuse
 * one whose prompt would not fit (outcomePromptFits), so it is never cut in a prompt.
 */
export function outcomeText(p: { summary: string; events: ShownEvent[] }, timezone: string): string {
  return p.events.length === 0 ? `agreed ${shown(p.summary, 500)}` : eventsText(p.events, timezone);
}

/**
 * `With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”. Book it?` (the service adds
 * `#ref` and the tail). I5/I13: the owner's yes books every event, so the prompt must show
 * every event. When the full form is longer than the prompt cap, compact forms are tried:
 * events grouped by day, no locations, titles cut to 24, 18, then 12 characters — every event's
 * date and time always stays. A proposal whose most compact form still does not fit is
 * refused by code (outcomePromptFits) before any owner is asked.
 */
export function outcomePrompt(p: { peer: string; summary: string; events: ShownEvent[] }, timezone: string): string {
  const ask = p.events.length === 0 ? 'OK?' : p.events.length === 1 ? 'Book it?' : 'Book them?';
  const withPeer = `With ${sanitize(p.peer, 60)}:`;
  const full = `${withPeer} ${outcomeText(p, timezone)}. ${ask}`;
  if (p.events.length === 0 || promptFits(full)) return full;
  const forms = [24, 18, 12].map((max) => `${withPeer} ${compactEvents(p.events, timezone, max)}. ${ask}`);
  return forms.find((f) => promptFits(f)) ?? forms[forms.length - 1]!;
}

/** `Fri Nov 13: “Lunch” 12:00–1:00 PM, “Call” 3:00–3:30 PM; Sat Nov 14: …` */
function compactEvents(events: ShownEvent[], timezone: string, titleMax: number): string {
  const groups: Array<{ day: string | null; items: string[] }> = [];
  for (const e of events) {
    const range = formatRange(new Date(e.start), new Date(e.end), timezone);
    const day = formatDay(new Date(e.start), timezone);
    const sameDay = range.startsWith(`${day}, `);
    const item = `${shown(e.title, titleMax)} ${sameDay ? range.slice(day.length + 2) : range}`;
    const last = groups[groups.length - 1];
    if (sameDay && last?.day === day) last.items.push(item);
    else groups.push({ day: sameDay ? day : null, items: [item] });
  }
  return groups.map((g) => (g.day ? `${g.day}: ${g.items.join(', ')}` : g.items.join(', '))).join('; ');
}

/** Whether the outcome prompt shows everything a yes would book (no cut at the prompt cap). */
export function outcomePromptFits(p: { peer: string; summary: string; events: ShownEvent[] }, timezone: string): boolean {
  return promptFits(outcomePrompt(p, timezone));
}

export function bookedLine(p: { summary: string; events: ShownEvent[] }, timezone: string): string {
  if (p.events.length === 0) return `Agreed: ${shown(p.summary, 200)}.`;
  return `Booked: ${p.events.map((e) => `${shown(e.title, 60)} — ${formatRange(new Date(e.start), new Date(e.end), timezone)}`).join('; ')}.`;
}

export function saidNoLine(who: string, p: { summary: string; events: ShownEvent[] }, timezone: string): string {
  return sanitize(`${sanitize(who, 60)} said no to: ${outcomeText(p, timezone)}. Nothing was booked.`, 600);
}

export function noAnswerLine(who: string, p: { summary: string; events: ShownEvent[] }, timezone: string): string {
  return sanitize(`No answer from ${sanitize(who, 60)}, so nothing was booked: ${outcomeText(p, timezone)}.`, 600);
}

/** `why`: a code-written, owner-safe reason (outcome.ts `failureWhy`). */
export function bookingFailedLine(p: { summary: string; events: ShownEvent[] }, timezone: string, why: string): string {
  return sanitize(`Couldn't book ${outcomeText(p, timezone)}: ${why}. Nothing was booked.`, 600);
}

/** I7: one side failed and undoing the other has not worked yet (the sweep keeps trying). `where`: "your", "Sam's" or both. */
export function undoPendingLine(p: { summary: string; events: ShownEvent[] }, timezone: string, where: string): string {
  return sanitize(`Couldn't book ${outcomeText(p, timezone)}: a calendar didn't accept it. It is still on ${where} calendar for now; I'm removing it and will tell you when it's gone.`, 600);
}

/** D4: `Violet ↔ Sam's Violet (“Dinner Friday”) asks: “…”` */
export function questionLine(parties: Parties, topic: string, question: string): string {
  return `${sanitize(parties.me.agent.name, 40)} ↔ ${parties.peerLabel} (${shown(topic, 80)}) asks: ${shown(question, 500)}`;
}

/** D3: what was released, exactly. Release texts are canonical (no quotes, no number signs): shown as stored. */
export function talkingLine(peerLabel: string, topic: string, brief: string): string {
  return `Talking to ${peerLabel} about ${quote(topic, 100)}: ${quote(brief, 700)}`;
}

export function toldLine(peerLabel: string, guidance: string): string {
  return `Told ${peerLabel}: ${quote(guidance, 700)}`;
}

/** The a2a_release prompt body (the service adds `#ref` and ` Reply yes or no.`). */
export function releasePrompt(peerLabel: string, text: string, topic?: string): string {
  const about = topic === undefined ? '' : ` about ${quote(topic, 100)}`;
  return `Tell ${peerLabel}${about}: ${quote(text, 700)} Send?`;
}

/** One transcript line per stored message, for `parties.me`'s owner. Never a model paraphrase. */
export function transcriptLine(m: A2AMessageRow, parties: Parties, timezone: string): string {
  const me = sanitize(parties.me.agent.name, 40);
  const who = m.from_agent_id === null ? 'System' : m.from_agent_id === parties.me.agent.id ? me : parties.peerLabel;
  const p = m.payload as { topic?: string; summary?: string; events?: ShownEvent[]; proposal_seq?: number; reason?: string };
  switch (m.kind) {
    case 'open':
      return `${who} opened ${shown(p.topic ?? '', 80)}: ${shown(m.body, 700)}`;
    case 'proposal':
      return `${who} proposed ${outcomeText({ summary: p.summary ?? '', events: p.events ?? [] }, timezone)} (summary: ${shown(p.summary ?? '', 300)})`;
    case 'accept':
      return `${who} accepted the proposal (both owners are asked).`;
    case 'decline':
      return `${who} declined the proposal${m.body ? `: ${shown(m.body, 300)}` : '.'}`;
    case 'question':
      return `${me} asked ${parties.me.first}: ${shown(m.body, 500)}`;
    case 'guidance':
      return `${parties.me.first} told ${me}: ${shown(m.body, 700)}`;
    case 'close':
      return `${who} ended the conversation${m.body ? `: ${shown(m.body, 300)}` : '.'}`;
    case 'system':
      return `System: ${shown(m.body, 300)}`;
    default:
      return `${who}: ${shown(m.body, 1000)}`;
  }
}
