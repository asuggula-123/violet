/**
 * P1/P2: what you see is what gets booked. For every approval kind that books (calendar_event,
 * a2a_outcome), every text field written to a calendar appears verbatim and in full in the
 * prompt the owner answered; a request whose prompt cannot show it whole is refused and nobody
 * is asked. The model is hostile: it picks the longest, strangest text it can.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalEventText, quotedField } from '../../../src/approvals/eventText.js';
import { calendarEventKind, calendarEventPayload } from '../../../src/approvals/calendarEvent.js';
import { composePrompt } from '../../../src/approvals/service.js';
import { CALENDAR_TOOL_TEXT } from '../../../src/brain/tools/calendar.js';
import type { NewCalendarEvent } from '../../../src/google/types.js';
import { createTestWorld, type Persona, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, contextOf, FRI, lastResults, peerProposalSeq, respond, scriptEnvoy, stepOf, toolUse } from '../a2a/helpers.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** Pieces a fooled model may copy from an email or invite: every one the prompt pipeline changes. */
const PIECES = ['Dinner', 'room #3', '＃7', '"quoted"', '“curly”', 'reply yes or no', 'ﬁne', '①', 'a​b', 'line\nbreak', 'tab\there', 'שלום', '#1 priority', 'Today: x', '♯5', 'C#', '  spaced  ', "Luigi's", 'é', 'x'.repeat(60)];

function textOf(seed: number, n: number): string {
  let x = seed * 7919 + 13;
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(PIECES[x % PIECES.length]!);
  }
  return out.join(' ');
}

const created = (world: TestWorld, ownerId: string): NewCalendarEvent[] =>
  world.calendar.writes.flatMap((x) => (x.op === 'create' && x.ownerId === ownerId ? [x.event] : []));

describe('P1 calendar_event: the canonical text is what the prompt shows', () => {
  it('canonicalEventText is idempotent, quoting leaves it whole, and the composed prompt contains every field verbatim', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    for (let seed = 0; seed < 400; seed += 1) {
      const raw = textOf(seed, 1 + (seed % 5));
      const c = canonicalEventText(raw);
      expect(canonicalEventText(c)).toBe(c);
      expect(quotedField(c)).toBe(`“${c}”`);
      const p = calendarEventPayload.parse({ title: raw.slice(0, 200) || 'x', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00', location: textOf(seed + 1, 2).slice(0, 300) });
      const prompt = composePrompt(1, calendarEventKind.render(p, { timezone: 'America/New_York', now }));
      if (prompt.length < 240) {
        expect(prompt).toContain(`#1 ${p.title} — `);
        if (p.location) expect(prompt).toContain(` at “${p.location}”`);
      }
      for (const ev of calendarEventKind.calendarEvents!(p)) {
        expect(ev.title).toBe(p.title);
        expect(ev.location).toBe(p.location || undefined);
        expect(Object.keys(ev)).not.toContain('description');
      }
    }
  });
});

describe('P1 calendar_event through the Brain tool: a yes books exactly what the prompt showed', () => {
  const cases = Array.from({ length: 8 }, (_, i) => ({
    title: i === 0 ? 'Dinner' : textOf(i, 1 + (i % 4)).slice(0, 200),
    location: i % 3 === 0 ? undefined : textOf(i + 50, 1 + (i % 3)).slice(0, 300),
  }));

  it('for both owners and many titles and locations: booked fields appear in the answered prompt in full, or nothing is asked', async () => {
    w = await createTestWorld();
    const world = w;
    for (const [i, c] of cases.entries()) {
      for (const p of [world.alex, world.sam] as Persona[]) {
        const start = `2026-11-${String(14 + i).padStart(2, '0')}T19:00:00-05:00`;
        const end = `2026-11-${String(14 + i).padStart(2, '0')}T20:30:00-05:00`;
        let toolResult = '';
        world.llm.on({ agentId: p.agent.id, mind: 'brain' }, (req) => {
          if (stepOf(req) === 0) {
            return respond([toolUse(`c${i}`, 'request_calendar_event', { title: c.title, start, end, ...(c.location ? { location: c.location } : {}), description: 'HIDDEN-NOTES' })]);
          }
          toolResult = lastResults(req)[0]?.content ?? '';
          return respond([{ type: 'text', text: 'Asked.' }]);
        });
        const before = created(world, p.owner.id).length;
        await world.ownerSays(p, `book case ${i}`);
        const pending = await world.app.approvals!.listPending(p.agent.id);
        if (toolResult === CALENDAR_TOOL_TEXT.tooLong) {
          expect(pending).toEqual([]);
          continue;
        }
        expect(toolResult).toBe(CALENDAR_TOOL_TEXT.requested);
        const a = pending.at(-1)!;
        const prompt = world.transport.sent.filter((m) => m.toAddress === p.address && m.purpose === 'approval').at(-1)!.text;
        expect(prompt).toBe(a.prompt);
        await world.ownerSays(p, 'yes');
        const booked = created(world, p.owner.id).slice(before);
        expect(booked).toHaveLength(1);
        const ev = booked[0]!;
        expect(prompt).toContain(`${ev.title} — `);
        if (ev.location) expect(prompt).toContain(`at “${ev.location}”`);
        expect(ev.location ?? '').toBe(canonicalEventText(c.location ?? ''));
        expect(ev.title).toBe(canonicalEventText(c.title));
        expect(JSON.stringify(ev)).not.toContain('HIDDEN-NOTES');
      }
    }
  }, 120_000);

  it('a title too long for the prompt is refused with the fixed text; nothing is asked or cut', async () => {
    w = await createTestWorld();
    const world = w;
    let toolResult = '';
    world.llm.on({ agentId: world.alex.agent.id, mind: 'brain' }, (req) => {
      if (stepOf(req) === 0) return respond([toolUse('c', 'request_calendar_event', { title: `Dinner ${'x'.repeat(190)}`, ...FRI.dinner, location: 'L'.repeat(100) })]);
      toolResult = lastResults(req)[0]?.content ?? '';
      return respond([{ type: 'text', text: 'Booked it!' }]);
    });
    await world.ownerSays(world.alex, 'book it');
    expect(toolResult).toBe(CALENDAR_TOOL_TEXT.tooLong);
    expect(await world.app.approvals!.listPending(world.alex.agent.id)).toEqual([]);
    expect(world.transport.sent.filter((m) => m.purpose === 'approval')).toEqual([]);
  });

  it('an old stored payload with a description is booked without it', async () => {
    w = await createTestWorld();
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
    await w.db.query(`UPDATE approvals SET payload = payload || '{"description":"OLD-NOTES"}'::jsonb WHERE id = $1`, [a.id]);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    const ev = created(w, w.alex.owner.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.description).toBeUndefined();
  });
});

describe('P2 a2a_outcome: both owners see every booked title and location in full', () => {
  /** Sam's Envoy proposes `events` (once); Alex's Envoy accepts. */
  function envoys(world: TestWorld, events: Array<Record<string, unknown>>, refusals: string[]): void {
    scriptEnvoy(world, world.sam, (req) => {
      if (peerProposalSeq(req) !== null || /You proposed/.test(contextOf(req))) return ['nothing to add'];
      return [
        [toolUse('s1', 'propose', { summary: 'Plans', events })],
        (r) => {
          const res = lastResults(r)[0];
          if (res?.is_error) refusals.push(res.content);
          return [{ type: 'text', text: 'done' }];
        },
      ];
    });
    scriptEnvoy(world, world.alex, (req) => {
      const seq = peerProposalSeq(req);
      return seq === null ? ['waiting'] : [[toolUse('a2', 'accept', { proposal_seq: seq })], 'done'];
    });
  }

  const ev = (day: number, title: string, location?: string, calendars = 'both') => ({
    title,
    start: `2026-11-13T${String(day).padStart(2, '0')}:00:00-05:00`,
    end: `2026-11-13T${String(day).padStart(2, '0')}:30:00-05:00`,
    ...(location ? { location } : {}),
    calendars,
  });

  const cases: Array<Array<Record<string, unknown>>> = [
    [ev(19, 'Dinner', "Luigi's")],
    [ev(9, 'Breakfast ＃2 "big"', 'Café ①'), ev(12, 'Lunch', undefined, 'mine')],
    [ev(10, 'A', 'x'), ev(11, 'B', undefined, 'theirs'), ev(13, 'C reply yes or no', 'y')],
    [ev(19, `Dinner ${'z'.repeat(110)}`, `Somewhere ${'q'.repeat(150)}`)],
    [ev(9, 'One'), ev(10, 'Two'), ev(11, 'Three'), ev(12, 'Four'), ev(13, 'Five')],
  ];

  for (const [i, events] of cases.entries()) {
    it(`case ${i}: every event booked on an owner's calendar is in full in that owner's prompt, or propose is refused`, async () => {
      w = await createTestWorld();
      const world = w;
      const refusals: string[] = [];
      alexOpensDinner(world);
      envoys(world, events, refusals);
      await world.ownerSays(world.alex, 'Set up plans with Sam on Friday');
      const proposals = (await world.db.query("SELECT 1 FROM a2a_messages WHERE kind = 'proposal'")).rows;
      if (proposals.length === 0) {
        expect(refusals.join('\n')).toMatch(/see every event in full/);
        expect(world.transport.sent.filter((m) => m.purpose === 'approval')).toEqual([]);
        return;
      }
      const prompts = new Map<string, string>();
      for (const p of [world.alex, world.sam]) {
        const a = (await world.app.approvals!.listPending(p.agent.id)).find((x) => x.kind === 'a2a_outcome')!;
        prompts.set(p.owner.id, a.prompt);
        expect(a.prompt.length).toBeLessThanOrEqual(240 + ' Reply yes or no.'.length + 4);
      }
      await world.ownerSays(world.sam, 'yes');
      await world.ownerSays(world.alex, 'yes');
      let total = 0;
      for (const p of [world.alex, world.sam]) {
        const prompt = prompts.get(p.owner.id)!;
        for (const e of created(world, p.owner.id)) {
          total += 1;
          expect(prompt).toContain(`“${e.title}” — `);
          if (e.location) expect(prompt).toContain(` at “${e.location}”`);
        }
      }
      expect(total).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe('P1 at booking time: a field the stored prompt never showed is not written', () => {
  let w2: TestWorld | undefined;
  afterEach(async () => {
    await w2?.close();
    w2 = undefined;
  });

  it('a stored payload whose title or location is missing from its stored prompt fails with an owner-safe reason, nothing is written', async () => {
    w2 = await createTestWorld();
    const world = w2;
    for (const patch of [{ location: 'NEVER-SHOWN-PLACE' }, { title: 'Dinner and a NEVER-SHOWN title' }]) {
      const a = await world.app.approvals!.request(world.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
      await world.db.query(`UPDATE approvals SET payload = payload || $2::jsonb WHERE id = $1`, [a.id, JSON.stringify(patch)]);
      await world.ownerSays(world.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
      expect((await world.app.approvals!.get(a.id))!.status).toBe('failed');
      expect(world.lastTo(world.alex.address)).toContain('did not show all of it');
    }
    expect(world.calendar.writes.filter((x) => x.op === 'create')).toEqual([]);
  });
});
