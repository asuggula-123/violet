import { formatRange } from '../brain/time.js';
import { ZONE } from './seed.js';
import type { DemoWorld } from './world.js';

/** One printed line: where it was seen, and what was there. */
export interface Line {
  where: string;
  text: string;
}

interface LogRow {
  id: number;
  agent_id: string | null;
  action: string;
  detail: Record<string, unknown>;
}

const range = (from: unknown, to: unknown) => formatRange(new Date(String(from)), new Date(String(to)), ZONE);

/**
 * Reads what the system really did since the last call — the action log, in order, joined
 * to the stored texts (messages), the agents' channel (a2a_messages) and the calendars —
 * and turns it into labelled lines. Nothing here invents an outcome.
 */
export function createTimeline(w: DemoWorld, strangers: Record<string, string>) {
  const db = w.app.deps.db;
  const people = [w.alex, w.sam];
  const byAgent = (id: unknown) => people.find((p) => p.agentId === id);
  const owner = (id: unknown) => byAgent(id)?.name ?? 'Someone';
  const violetOf = (id: unknown) => (id ? `${owner(id)}'s Violet` : 'System');
  let cursor = 0;

  async function one<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return (await db.query<T>(sql, params)).rows[0];
  }

  async function message(id: unknown) {
    return one<{ body: string; address: string | null }>(
      'SELECT m.body, c.address FROM messages m LEFT JOIN contacts c ON c.id = m.contact_id WHERE m.id = $1',
      [id],
    );
  }

  async function agentsChannel(d: Record<string, unknown>): Promise<Line[]> {
    const m = await one<{ from_agent_id: string | null; private_to: string | null; kind: string; body: string; payload: Record<string, unknown>; topic: string }>(
      `SELECT m.from_agent_id, m.private_to, m.kind, m.body, m.payload, c.topic FROM a2a_messages m
       JOIN a2a_conversations c ON c.id = m.conversation_id WHERE m.conversation_id = $1 AND m.seq = $2`,
      [d.conversationId, d.seq],
    );
    if (!m || m.private_to) return [];
    const from = violetOf(m.from_agent_id);
    const to = m.from_agent_id ? ` → ${d.to === 'both' ? 'both' : violetOf(d.to)}` : '';
    const said = (s: string) => ({ where: "AGENTS' CHANNEL", text: `${from}${to}: ${s}` });
    switch (m.kind) {
      case 'open': {
        const window = m.payload.window_start ? ` (times: ${range(m.payload.window_start, m.payload.window_end)})` : '';
        return [said(`about “${m.topic}”${window}: “${m.body}”`)];
      }
      case 'proposal': {
        const events = (m.payload.events as Array<{ title: string; start: string; end: string; location?: string }>) ?? [];
        return [said(`proposes ${events.map((e) => `“${e.title}”, ${range(e.start, e.end)}${e.location ? ` at ${e.location}` : ''}`).join('; ') || `“${m.body}”`}`)];
      }
      case 'accept':
        return [said(`accepts proposal ${String(m.payload.proposal_seq)}`)];
      case 'decline':
        return [said(`declines${m.body ? `: “${m.body}”` : ''}`)];
      case 'close':
        return [said(`ends the conversation${m.body ? `: “${m.body}”` : ''}`)];
      case 'text':
        return [said(`“${m.body}”`)];
      default:
        return [said(m.body)];
    }
  }

  async function lines(row: LogRow): Promise<Line[]> {
    const d = row.detail;
    const who = owner(row.agent_id);
    const phone = (label: string) => `${label.toUpperCase()}'S PHONE`;
    switch (row.action) {
      case 'inbound.received': {
        const m = await message(d.messageId);
        if (!m) return [];
        if (d.from === 'owner') return [{ where: phone(who), text: `${who}: ${m.body}` }];
        const label = strangers[m.address ?? ''] ?? 'Unknown sender';
        return [{ where: phone(label), text: `${label} → ${who}'s Violet: ${m.body}` }];
      }
      case 'outbound.sent': {
        const m = await message(d.messageId);
        if (!m) return [];
        if (d.to === 'owner') {
          const [first, ...rest] = m.body.split('\n');
          return [{ where: phone(who), text: `Violet: ${first}` }, ...rest.map((t) => ({ where: phone(who), text: `        ${t}` }))];
        }
        const label = strangers[m.address ?? ''] ?? 'Unknown sender';
        return [{ where: phone(label), text: `${who}'s Violet → ${label}: ${m.body}` }];
      }
      case 'a2a.message':
        return agentsChannel(d);
      case 'a2a.availability':
        return [{ where: 'LOG', text: `${who}'s Violet read ${who}'s free/busy for ${range(d.from, d.to)}: ${String(d.intervals)} busy block(s), start and end times only.` }];
      case 'a2a.tool_denied':
      case 'a2a.limit':
        return [{ where: 'LOG', text: `Refused by code: ${who}'s Violet tried ${String(d.tool)} (${String(d.reason ?? d.limit)}).` }];
      case 'a2a.release_blocked':
        return [{ where: 'LOG', text: `Blocked by code: what ${who}'s Violet wanted to tell the other agent named a private calendar detail.` }];
      case 'a2a.release_held':
        return [{ where: 'LOG', text: `Held for ${who}'s yes: what ${who}'s Violet wanted to tell the other agent.` }];
      case 'inbound.held':
        return [{ where: 'LOG', text: `${who}'s Violet is paused: message stored, nothing sent back.` }];
      case 'outbound.suppressed':
        return [{ where: 'LOG', text: `Not sent: ${who}'s Violet is paused (${String(d.purpose)}).` }];
      case 'agent.paused':
      case 'agent.resumed':
        return [{ where: 'LOG', text: `${who}'s Violet ${row.action === 'agent.paused' ? 'paused' : 'resumed'}.` }];
      case 'approval.approved':
      case 'approval.denied':
        return [{ where: 'LOG', text: `${who} ${row.action === 'approval.approved' ? 'approved' : 'declined'} #${String(d.ref)}.` }];
      case 'calendar.event_created': {
        const p = byAgent(row.agent_id);
        const e = p ? w.calendar.eventsOf(p.ownerId).find((x) => x.id === d.eventId) : undefined;
        if (!e) return [];
        return [{ where: `${who.toUpperCase()}'S CALENDAR`, text: `+ “${e.title}”, ${formatRange(e.start, e.end, ZONE)}${e.location ? ` at ${e.location}` : ''}` }];
      }
      default:
        return [];
    }
  }

  return {
    /**
     * Lines for everything logged since the previous call, in log order, with two
     * reading-order fixes that change no content: the owner's own text is shown before
     * the pause/resume it caused (the router logs the flip before the inbound row), and
     * with `byOwner` the rows are grouped Alex first, then Sam — for beats where each
     * owner's jobs run independently at the same instant (the 6 pm digests), whose log
     * order otherwise follows random ids.
     */
    async next(opts: { byOwner?: boolean } = {}): Promise<Line[]> {
      const logged = (await db.query<LogRow>('SELECT id::int AS id, agent_id, action, detail FROM action_log WHERE id > $1 ORDER BY id', [cursor])).rows;
      const last = logged.at(-1)?.id;
      let rows = ownerTextFirst(logged);
      if (opts.byOwner) {
        const rank = (r: LogRow) => {
          const i = people.findIndex((p) => p.agentId === r.agent_id);
          return i === -1 ? people.length : i;
        };
        rows = rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
      }
      const out: Line[] = [];
      for (const row of rows) out.push(...(await lines(row)));
      if (last !== undefined) cursor = last;
      return out;
    },
  };
}

/** Moves an owner's inbound text ahead of the pause/resume flip that the same agent logged just before it. */
function ownerTextFirst(rows: LogRow[]): LogRow[] {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const row = out[i]!;
    if (row.action !== 'inbound.received' || row.detail.from !== 'owner') continue;
    let j = i;
    while (j > 0 && (out[j - 1]!.action === 'agent.paused' || out[j - 1]!.action === 'agent.resumed') && out[j - 1]!.agent_id === row.agent_id) j--;
    if (j < i) {
      out.splice(i, 1);
      out.splice(j, 0, row);
    }
  }
  return out;
}
