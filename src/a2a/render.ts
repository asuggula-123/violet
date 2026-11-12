import { canonicalEventText } from '../approvals/eventText.js';
import { promptFits } from '../approvals/service.js';
import { quoteFolded } from '../brain/reply.js';
import { ambiguousLocalTime, exactRange, formatRange } from '../brain/time.js';
import { quote, sanitize } from '../core/sanitize.js';
import { PROPOSE_MAX } from './envoyTools.js';
import type { A2AMessageRow, Parties, ProposalEvent } from './types.js';

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
  /** (P7) Whether it goes on this owner's calendar (the outcome payload); absent = not said. */
  mine?: boolean | undefined;
}

/** An outcome as an owner reads it; `peer` (the other owner's first name) names whose calendar an event is on. */
export interface ShownOutcome {
  summary: string;
  events: ShownEvent[];
  peer?: string | undefined;
}

/** Never cut: what does not fit is refused before any owner is asked (outcomePromptFits). */
const NO_CAP = Number.MAX_SAFE_INTEGER;

/**
 * `“Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”[ (only on Sam's calendar)]`: the whole title
 * and location, the exact time (`exactRange`, from `now`; without `now`, the plain range) and,
 * in code-written words, an event that does not go on this owner's calendar (P7).
 */
export function eventText(e: ShownEvent, timezone: string, o: { now?: Date | undefined; peer?: string | undefined; location?: boolean } = {}): string {
  const at = e.location && o.location !== false ? ` at ${shown(e.location, NO_CAP)}` : '';
  const where = e.mine === false && o.peer ? ` (only on ${sanitize(o.peer, 60)}'s calendar)` : '';
  const start = new Date(e.start);
  const end = new Date(e.end);
  const when = o.now ? exactRange(start, end, timezone, o.now) : formatRange(start, end, timezone);
  return `${shown(e.title, NO_CAP)} — ${when}${at}${where}`;
}

export function eventsText(events: ShownEvent[], timezone: string, o: { now?: Date | undefined; peer?: string | undefined; location?: boolean } = {}): string {
  return events.map((e) => eventText(e, timezone, o)).join('; ');
}

/**
 * The part of an outcome both prompts and follow-up lines share. A zero-event agreement shows
 * its whole summary (I5/I13: the owner's OK is to exactly that text); propose and accept refuse
 * one whose prompt would not fit (outcomePromptFits), so it is never cut in a prompt.
 */
export function outcomeText(p: ShownOutcome, timezone: string, now?: Date): string {
  return p.events.length === 0 ? `agreed ${shown(p.summary, 500)}` : eventsText(p.events, timezone, { now, peer: p.peer });
}

/**
 * `With Sam: “Dinner” — Fri Nov 13, 7:00–8:30 PM at “Luigi's”. Book it?` (the service adds
 * `#ref` and the tail). What you see is what gets booked (I5/I13): the owner's yes books every
 * event with its title and location, so the prompt shows every one of them whole. There is no
 * shorter form: a proposal whose prompt does not fit is refused by code (outcomePromptFits)
 * before any owner is asked.
 */
export function outcomePrompt(p: ShownOutcome & { peer: string }, timezone: string, now: Date): string {
  const ask = p.events.length === 0 ? 'OK?' : p.events.length === 1 ? 'Book it?' : 'Book them?';
  return `With ${sanitize(p.peer, 60)}: ${outcomeText(p, timezone, now)}. ${ask}`;
}

/**
 * Whether the outcome prompt shows everything a yes would book: it fits the prompt cap, and
 * every title and location is in its canonical form (canonicalEventText, which propose stores),
 * so the quoted text is the booked text, character for character.
 */
export function outcomePromptFits(p: ShownOutcome & { peer: string }, timezone: string, now: Date): boolean {
  const verbatim = (t: string | undefined) => t === undefined || canonicalEventText(t) === t;
  return p.events.every((e) => verbatim(e.title) && verbatim(e.location)) && promptFits(outcomePrompt(p, timezone, now));
}

export function bookedLine(p: ShownOutcome, timezone: string, now: Date): string {
  if (p.events.length === 0) return `Agreed: ${shown(p.summary, 200)}.`;
  return `Booked: ${eventsText(p.events, timezone, { now, peer: p.peer, location: false })}.`;
}

export function saidNoLine(who: string, p: ShownOutcome, timezone: string, now: Date): string {
  return sanitize(`${sanitize(who, 60)} said no to: ${outcomeText(p, timezone, now)}. Nothing was booked.`, 600);
}

export function noAnswerLine(who: string, p: ShownOutcome, timezone: string, now: Date): string {
  return sanitize(`No answer from ${sanitize(who, 60)}, so nothing was booked: ${outcomeText(p, timezone, now)}.`, 600);
}

/** `why`: a code-written, owner-safe reason (outcome.ts `failureWhy`). */
export function bookingFailedLine(p: ShownOutcome, timezone: string, now: Date, why: string): string {
  return sanitize(`Couldn't book ${outcomeText(p, timezone, now)}: ${why}. Nothing was booked.`, 600);
}

/** I7: one side failed and undoing the other has not worked yet (the sweep keeps trying). `where`: "your", "Sam's" or both. */
export function undoPendingLine(p: ShownOutcome, timezone: string, now: Date, where: string): string {
  return sanitize(`Couldn't book ${outcomeText(p, timezone, now)}: a calendar didn't accept it. It is still on ${where} calendar for now; I'm removing it and will tell you when it's gone.`, 600);
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

/**
 * The a2a_release prompt body (the service adds `#ref` and ` Reply yes or no.`). I20: it shows
 * every value that crosses: the topic, the window the agents may check (code-rendered by
 * `releaseWindowText`, which determines the stored window exactly) and the exact text.
 * `Tell Sam's Violet about “Dinner Friday” (Fri Nov 13, 6:00 PM – Sat Nov 14, 12:00 AM): “…” Send?`
 */
export function releasePrompt(
  peerLabel: string,
  text: string,
  topic?: string,
  window?: { start: Date; end: Date; timezone: string; requestedAt?: Date | undefined },
): string {
  const range = window ? ` (${releaseWindowText(window.start, window.end, window.timezone, window.requestedAt)})` : '';
  const about = topic === undefined ? '' : ` about ${quote(topic, 100)}${range}`;
  return `Tell ${peerLabel}${about}: ${quote(text, 700)} Send?`;
}

export { ambiguousLocalTime };

/**
 * I20: the window as the release prompt shows it, so that the text determines the stored window
 * (kept to the minute) exactly: nothing crosses that the owner's yes did not see. The shared
 * `exactRange` text (year when not in the year of the request `requestedAt`, unknown → always;
 * UTC offset for a repeated local time).
 */
export function releaseWindowText(start: Date, end: Date, tz: string, requestedAt?: Date): string {
  return exactRange(start, end, tz, requestedAt);
}

/**
 * The transcript shows stored text whole (8.4). Folding can lengthen a character (an NFKC
 * form is at most 18 code points), so the cap is the stored limit with that much room:
 * folding never cuts what was said.
 */
const NFKC_MAX_GROWTH = 18;
export const whole = (text: string, storedMax: number) => shown(text, storedMax * NFKC_MAX_GROWTH);

/** Whose calendars a proposed event goes on, for the owner reading (stored as agent ids). */
function calendarsFor(agents: readonly string[] | undefined, parties: Parties): string {
  const mine = agents?.includes(parties.me.agent.id) ?? false;
  const theirs = agents?.includes(parties.peer.agent.id) ?? false;
  if (mine && theirs) return 'on both calendars';
  if (mine) return 'on your calendar only';
  return theirs ? `on ${parties.peer.first}'s calendar only` : 'on no calendar';
}

function transcriptEvent(e: ProposalEvent, parties: Parties, timezone: string): string {
  const at = e.location ? ` at ${whole(e.location, PROPOSE_MAX.location)}` : '';
  return `${whole(e.title, PROPOSE_MAX.title)} — ${formatRange(new Date(e.start), new Date(e.end), timezone)}${at}, ${calendarsFor(e.agents, parties)}`;
}

/** The window the agents may check, as the owner's yes saw it (releaseWindowText), or that there is none. */
function windowPart(p: { window_start?: string; window_end?: string }, timezone: string, openedAt: Date): string {
  if (!p.window_start || !p.window_end) return 'no time window';
  return `time window ${releaseWindowText(new Date(p.window_start), new Date(p.window_end), timezone, openedAt)}`;
}

/**
 * One transcript line per stored message, for `parties.me`'s owner. Never a model paraphrase,
 * never cut (Q3): every field is shown whole, the window of the open, which proposal an accept
 * or decline answers, and whose calendars each proposed event is on, for the reader.
 */
export function transcriptLine(m: A2AMessageRow, parties: Parties, timezone: string): string {
  const me = sanitize(parties.me.agent.name, 40);
  const who = m.from_agent_id === null ? 'System' : m.from_agent_id === parties.me.agent.id ? me : parties.peerLabel;
  const p = m.payload as { topic?: string; summary?: string; events?: ProposalEvent[]; proposal_seq?: number; window_start?: string; window_end?: string };
  switch (m.kind) {
    case 'open':
      return `${who} opened ${whole(p.topic ?? '', 100)} (${windowPart(p, timezone, m.created_at)}): ${whole(m.body, 700)}`;
    case 'proposal': {
      const events = p.events ?? [];
      const what = events.length === 0 ? 'nothing to book' : events.map((e) => transcriptEvent(e, parties, timezone)).join('; ');
      return `${who} proposed (proposal ${m.seq}): ${what}. Summary: ${whole(p.summary ?? '', PROPOSE_MAX.summary)}`;
    }
    case 'accept':
      return `${who} accepted proposal ${p.proposal_seq ?? '?'} (both owners are asked).`;
    case 'decline':
      return `${who} declined proposal ${p.proposal_seq ?? '?'}${m.body ? `: ${whole(m.body, 300)}` : '.'}`;
    case 'question':
      return `${me} asked ${parties.me.first}: ${whole(m.body, 500)}`;
    case 'guidance':
      return `${parties.me.first} told ${me}: ${whole(m.body, 700)}`;
    case 'close':
      return `${who} ended the conversation${m.body ? `: ${whole(m.body, 300)}` : '.'}`;
    case 'system':
      return `System: ${whole(m.body, 300)}`;
    default:
      return `${who}: ${whole(m.body, 1000)}`;
  }
}
