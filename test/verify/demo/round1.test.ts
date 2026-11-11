/**
 * M7 verifier, round 1: adversarial checks on `npm run demo`, README.md and docs/DEMO.md.
 * These tests change the world under the demo (seeded calendars, the scripted model) and
 * check that the screen follows what the system really did, never a fixed narration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDemoArgs } from '../../../src/demo/args.js';
import { DemoModel } from '../../../src/demo/model.js';
import { runDemo } from '../../../src/demo/story.js';
import { FakeCalendar } from '../../../src/google/fake.js';
import type { LlmRequest, LlmResponse } from '../../../src/llm/types.js';
import { read } from '../../unit/ops/files.js';

const quiet = { fast: true, out: () => {} };
const at = (local: string) => new Date(`${local}:00-05:00`);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Adds `extra` to whichever owner gets the seeded event titled `anchor`. */
function addSeedEvent(anchor: string, extra: { title: string; start: Date; end: Date }) {
  const orig = FakeCalendar.prototype.seed;
  vi.spyOn(FakeCalendar.prototype, 'seed').mockImplementation(function (this: FakeCalendar, ownerId, ev) {
    const out = orig.call(this, ownerId, ev);
    if (ev.title === anchor) orig.call(this, ownerId, extra);
    return out;
  });
}

/** Rewrites what the scripted model answers. */
function rewriteModel(edit: (req: LlmRequest, res: LlmResponse) => LlmResponse) {
  const orig = DemoModel.prototype.complete;
  vi.spyOn(DemoModel.prototype, 'complete').mockImplementation(async function (this: DemoModel, req) {
    return edit(req, await orig.call(this, req));
  });
}

const dinners = (cal: { title: string }[]) => cal.filter((e) => e.title === 'Dinner');

describe('the screen follows the seeded calendars', () => {
  it('Sam busy 7-8 PM Friday: the proposal, both prompts and both calendars move to 8:00 PM', async () => {
    addSeedEvent('School pickup and soccer practice', { title: 'Choir', start: at('2026-11-13T19:00'), end: at('2026-11-13T20:00') });
    const r = await runDemo(quiet);
    const text = r.output.join('\n');
    expect(text).toContain('proposes “Dinner”, Fri Nov 13, 8:00–9:30 PM');
    expect(text).toContain('#1 With Sam: “Dinner” — Fri Nov 13, 8:00–9:30 PM');
    expect(text).toContain("ALEX'S CALENDAR    + “Dinner”, Fri Nov 13, 8:00–9:30 PM");
    expect(text).not.toContain('7:00–8:30 PM');
    for (const who of ['alex', 'sam'] as const) {
      expect(dinners(r.calendars[who])).toHaveLength(1);
      expect(r.calendars[who].find((e) => e.title === 'Dinner')!.start).toEqual(at('2026-11-13T20:00'));
    }
    expect(r.leaks).toEqual([]);
    expect(text).not.toContain('Choir');
  });

  it('Alex busy at the proposed time: Alex declines, nothing is booked, no "Booked" line, the CHECK says 0', async () => {
    addSeedEvent('Gym', { title: 'Late meeting', start: at('2026-11-13T19:00'), end: at('2026-11-13T19:30') });
    const r = await runDemo(quiet);
    const text = r.output.join('\n');
    expect(text).toContain("Alex's Violet → Sam's Violet: declines");
    expect(text).not.toContain('Booked:');
    expect(text).not.toContain("ALEX'S CALENDAR");
    expect(text).not.toContain("SAM'S CALENDAR");
    expect(text).toContain("After both: 0 on Alex's calendar, 0 on Sam's.");
    expect(dinners(r.calendars.alex)).toEqual([]);
    expect(dinners(r.calendars.sam)).toEqual([]);
    expect(r.digest ?? '').not.toContain('Booked after');
    expect(text).not.toContain('Late meeting');
  });
});

describe('the screen follows the model', () => {
  it("a different place in the scripted proposal shows up in the channel, both prompts and both calendars", async () => {
    rewriteModel((_req, res) => ({
      ...res,
      content: res.content.map((b) =>
        b.type === 'tool_use' && b.name === 'propose'
          ? { ...b, input: { ...(b.input as Record<string, unknown>), events: ((b.input as Record<string, unknown>).events as Array<Record<string, unknown>>).map((e) => ({ ...e, location: 'Harbor Grill' })) } }
          : b,
      ),
    }));
    const r = await runDemo(quiet);
    const text = r.output.join('\n');
    expect(text).not.toContain("Luigi's");
    expect(text).toContain('at Harbor Grill');
    expect(text).toContain('at “Harbor Grill”. Book it? Reply yes or no.');
    expect(r.calendars.alex.find((e) => e.title === 'Dinner')?.location).toBe('Harbor Grill');
  });

  it('the leak detector is real: an Envoy that says a private seed detail makes the run report LEAK', async () => {
    rewriteModel((_req, res) => ({
      ...res,
      content: res.content.map((b) =>
        b.type === 'tool_use' && b.name === 'say' && String((b.input as Record<string, unknown>).text).startsWith('On Saturday morning')
          ? { ...b, input: { text: 'Alex has Swim lessons for the kids then.' } }
          : b,
      ),
    }));
    const r = await runDemo(quiet);
    expect(r.leaks).toContain('Swim lessons for the kids');
    expect(r.output.join('\n')).toContain('LEAK: Swim lessons for the kids');
  });
});

describe('scripted mode never touches the network', () => {
  it('with ANTHROPIC_API_KEY set and no live client, no fetch happens and the screen says scripted', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'placeholder-not-a-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(parseDemoArgs(['--fast'], process.env)).toEqual({ fast: true, live: null });
      const r = await runDemo(quiet);
      expect(r.output[1]).toContain('Model: scripted demo model');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it('three scripted runs print the same transcript, line for line (the owners\' digests are grouped Alex then Sam)', async () => {
    const a = (await runDemo(quiet)).output;
    for (let i = 0; i < 2; i++) expect((await runDemo(quiet)).output).toEqual(a);
  });
});

describe('readable order', () => {
  it("the owner's `pause` / `resume` text is shown before its effect in the log", async () => {
    const out = (await runDemo(quiet)).output;
    const idx = (s: string) => out.findIndex((l) => l.includes(s));
    expect(idx('Alex: pause')).toBeGreaterThan(-1);
    expect(idx('Alex: pause')).toBeLessThan(idx("Alex's Violet paused."));
    expect(idx('Alex: resume')).toBeLessThan(idx("Alex's Violet resumed."));
  });
});

describe('README and DEMO.md commands and keys', () => {
  const readme = read('README.md');
  const demo = read('docs/DEMO.md');
  const scripts = Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts);

  it('every `npm run <script>` they print exists (test:e2e is added by the e2e milestone, checked only once test/e2e exists)', () => {
    const named = [...`${readme}\n${demo}`.matchAll(/npm run ([a-z:0-9-]+)/g)].map((m) => m[1]!);
    expect(named).toContain('demo');
    for (const s of named) {
      if (s === 'test:e2e') continue;
      expect(scripts, s).toContain(s);
    }
  });

  it('every demo flag DEMO.md mentions is accepted', () => {
    const flags = [...new Set([...demo.matchAll(/npm run demo -- (--[a-z-]+)/g)].map((m) => m[1]!))];
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      const parsed = parseDemoArgs([f], { ANTHROPIC_API_KEY: 'placeholder' });
      expect('error' in parsed, f).toBe(false);
    }
  });

  it('the keys table and .env.example agree: every table name is in .env.example, every empty .env.example key with no default is in the table', () => {
    const section = readme.split('## Keys you need to create')[1]!.split('\n## ')[0]!;
    const table = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]!);
    const env = [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => ({ name: m[1]!, value: m[2]! }));
    const envNames = env.map((e) => e.name);
    for (const t of table) expect(envNames, t).toContain(t);
    const withDefault = new Set(['NODE_ENV', 'PORT', 'TRANSPORT', 'TELEGRAM_MODE', 'VIOLET_MODEL', 'VIOLET_ENVOY_MODEL']);
    for (const e of env) if (!withDefault.has(e.name)) expect(table, e.name).toContain(e.name);
    // Placeholders only: every secret-bearing line in .env.example is empty.
    for (const e of env) if (/KEY|TOKEN|SECRET/.test(e.name)) expect(e.value, e.name).toBe('');
  });

  it('no emoji in the README, DEMO.md or the demo output', async () => {
    const out = (await runDemo(quiet)).output.join('\n');
    const emoji = /\p{Extended_Pictographic}/u;
    expect(readme).not.toMatch(emoji);
    expect(demo).not.toMatch(emoji);
    expect(out).not.toMatch(emoji);
  });
});
