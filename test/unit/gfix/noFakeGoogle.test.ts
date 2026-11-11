import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config.js';
import { createDeps } from '../../../src/deps.js';
import { GoogleCalendar } from '../../../src/google/calendar.js';
import { GoogleError } from '../../../src/google/errors.js';
import { FakeCalendar, FakeGmail } from '../../../src/google/fake.js';
import { createGoogleProviders } from '../../../src/google/providers.js';
import { googleOf } from '../../../src/google/services.js';
import type { CalendarProvider, GmailProvider } from '../../../src/google/types.js';
import { GoogleNotConfiguredError, NOT_CONFIGURED_REASON, UnconfiguredCalendar, UnconfiguredGmail } from '../../../src/google/unconfigured.js';
import { safeToolMessage } from '../../../src/llm/tools.js';
import { buildServer } from '../../../src/server.js';
import { FakeClock } from '../../../src/clock.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { googleEnv } from '../google/helpers.js';
import { lastResults, scriptBrain, toolUse } from '../brain/script.js';
import { captureLog, noGoogleWorld, type NoGoogleWorld } from './helpers.js';

const fri = (h: number, m = 0) => `2026-11-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`;
const BARE = { TRANSPORT: 'fake' };

describe('Google providers by environment', () => {
  let w: TestWorld | undefined;
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  const providers = async (env: Record<string, string>) => {
    w ??= await createTestWorld({ modules: [] });
    const { log, lines } = captureLog('info');
    return { ...createGoogleProviders({ config: parseConfig(env), db: w.db, clock: new FakeClock(), log }), lines };
  };

  it('production without Google: providers that fail, not stand-ins; one warning line; no Google services behind them', async () => {
    const p = await providers({ ...BARE, NODE_ENV: 'production' });
    expect(p.calendar).toBeInstanceOf(UnconfiguredCalendar);
    expect(p.gmail).toBeInstanceOf(UnconfiguredGmail);
    expect(googleOf(p)).toBeNull(); // so the /oauth routes stay unregistered
    expect(p.lines.map((l) => [l.level, l.msg])).toEqual([[40, expect.stringContaining('Google is not configured')]]);
  });

  it('development and test keep the in-memory fakes, with one info line saying so', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const p = await providers({ ...BARE, NODE_ENV });
      expect(p.calendar).toBeInstanceOf(FakeCalendar);
      expect(p.gmail).toBeInstanceOf(FakeGmail);
      expect(p.lines).toHaveLength(1);
      expect(p.lines[0]).toMatchObject({ level: 30, msg: expect.stringMatching(/calendar and mailbox are in-memory stand-ins/) });
    }
  });

  it('configured Google wins in every environment, with no stand-in line', async () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      const p = await providers(googleEnv({ NODE_ENV }));
      expect(p.calendar).toBeInstanceOf(GoogleCalendar);
      expect(googleOf(p)).not.toBeNull();
      expect(p.lines).toEqual([]);
    }
  });

  it('createDeps wires the failing providers in production', async () => {
    w = await createTestWorld({ modules: [] });
    const deps = createDeps(parseConfig({ ...BARE, NODE_ENV: 'production' }), w.db);
    expect(deps.calendar).toBeInstanceOf(UnconfiguredCalendar);
    expect(deps.gmail).toBeInstanceOf(UnconfiguredGmail);
  });
});

describe('not-configured providers', () => {
  it('fail every call with a typed, non-retryable not_connected error carrying the safe reason', async () => {
    const cal: CalendarProvider = new UnconfiguredCalendar();
    const mail: GmailProvider = new UnconfiguredGmail();
    const d = new Date(0);
    const calls = [
      cal.freeBusy('o', d, d),
      cal.listEvents('o', d, d),
      cal.createEvent('o', { title: 't', start: d, end: d }, 'k'),
      cal.deleteEvent('o', 'e'),
      mail.search('o', 'q', 1),
      mail.getMessage('o', 'id'),
      mail.createDraft('o', { to: ['a@example.com'], subject: 's', body: 'b' }),
    ];
    for (const call of calls) {
      const err = await call.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleNotConfiguredError);
      expect(err).toBeInstanceOf(GoogleError);
      expect(err).toMatchObject({ code: 'not_connected', retryable: false, safeMessage: `${NOT_CONFIGURED_REASON}.`, ownerMessage: NOT_CONFIGURED_REASON });
      expect(safeToolMessage(err)).toBe(NOT_CONFIGURED_REASON);
    }
    expect(Object.getOwnPropertyNames(UnconfiguredGmail.prototype).sort()).toEqual(['constructor', 'createDraft', 'getMessage', 'search']);
  });
});

describe('production without Google: every caller is honest and quiet', () => {
  let n: NoGoogleWorld;
  afterEach(async () => n.close());

  it('Brain tools return the reason to a hostile model as tool errors; the turn completes and no draft is claimed', async () => {
    n = await noGoogleWorld();
    const { w } = n;
    let results: ReturnType<typeof lastResults> = [];
    scriptBrain(w, w.alex, [
      [
        toolUse('t1', 'get_schedule', { from: fri(0), to: fri(23) }),
        toolUse('t2', 'find_free_time', { from: fri(9), to: fri(17) }),
        toolUse('t3', 'search_email', { query: 'trip' }),
        toolUse('t4', 'read_email', { id: 'e1' }),
        toolUse('t5', 'draft_email', { to: ['sam@example.com'], subject: 'Dinner', body: 'Friday?' }),
      ],
      (req) => {
        results = lastResults(req);
        return { content: [{ type: 'text', text: 'Google is not connected here.' }], stopReason: 'end_turn' };
      },
    ]);
    await n.ownerSays(w.alex, 'what is on Friday, and draft Sam a note');
    expect(results.map((r) => [r.tool_use_id, r.is_error, r.content])).toEqual([
      ['t1', true, NOT_CONFIGURED_REASON],
      ['t2', true, NOT_CONFIGURED_REASON],
      ['t3', true, NOT_CONFIGURED_REASON],
      ['t4', true, "I couldn't open that email."], // read_email's own fixed text (src/brain/tools/email.ts)
      ['t5', true, NOT_CONFIGURED_REASON],
    ]);
    expect(w.textsTo(w.alex.address)).toEqual(['Google is not connected here.']);
    const [turn] = await w.actions({ action: 'brain.turn' });
    expect(turn!.detail).toMatchObject({ outcome: 'answered', replied: true });
    expect(await w.actions({ action: 'gmail.draft_created' })).toEqual([]);
    expect(await w.app.repos.flags.listByAgent(w.alex.agent.id)).toEqual([]);
    const jobs = await w.db.query<{ status: string }>('SELECT status FROM jobs');
    expect(jobs.rows.every((j) => j.status === 'done')).toBe(true);
  });

  it('an approved calendar_event is never reported booked: one plain line, approval failed, no booked flag, no retry', async () => {
    n = await noGoogleWorld();
    const { w, app } = n;
    scriptBrain(w, w.alex, [[toolUse('t1', 'request_calendar_event', { title: 'Dinner', start: fri(19), end: fri(20, 30) })], 'Asked.']);
    await n.ownerSays(w.alex, 'book dinner friday');
    expect(w.textsTo(w.alex.address)).toEqual(['#1 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.', 'Asked.']);
    // A hostile model that tries to claim success never gets the chance: the resolver
    // answers the yes in code, before the Brain.
    scriptBrain(w, w.alex, ['Booked: Dinner — Fri Nov 13, 7:00–8:30 PM.']);
    const callsBefore = w.llm.calls.length;
    await n.ownerSays(w.alex, 'yes');
    expect(w.llm.calls.length).toBe(callsBefore);
    expect(w.lastTo(w.alex.address)).toBe(`I couldn't book #1: ${NOT_CONFIGURED_REASON}.`);
    expect(w.textsTo(w.alex.address).some((t) => t.startsWith('Booked'))).toBe(false);
    const [approval] = await w.db.query<{ id: string; status: string; error: string }>('SELECT id, status, error FROM approvals').then((r) => r.rows);
    expect(approval).toMatchObject({ status: 'failed', error: NOT_CONFIGURED_REASON });
    expect((await w.actions({ action: 'approval.failed' })).map((a) => a.detail.reason)).toEqual([NOT_CONFIGURED_REASON]);
    expect(await w.actions({ action: 'calendar.event_created' })).toEqual([]);
    expect((await w.db.query('SELECT 1 FROM calendar_writes')).rowCount).toBe(0);
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toEqual([]);

    // Nothing retries: no job is left to run, a direct re-execution reports the same failure,
    // and a second yes finds nothing open.
    expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
    expect(await app.approvals!.calendar.executeApproved(approval!.id)).toEqual({ ok: false, reason: NOT_CONFIGURED_REASON });
    await n.ownerSays(w.alex, 'yes 1');
    expect(w.lastTo(w.alex.address)).toBe("#1 isn't open any more.");
    await n.advance({ hours: 2 });
    expect((await w.app.repos.flags.listByAgent(w.alex.agent.id)).filter((f) => f.kind === 'booked')).toEqual([]);
    expect((await w.db.query(`SELECT 1 FROM jobs WHERE status <> 'done'`)).rowCount).toBe(0);
  });

  it('the hourly conflict check stays silent: no flag, no scheduler failure, one log line per run (not per agent)', async () => {
    n = await noGoogleWorld();
    const { w } = n;
    await n.advance({ minutes: 1 });
    const skipped = () => n.lines.filter((l) => l.msg === 'conflict check skipped');
    const first = skipped().length;
    expect(first).toBe(1); // Alex and Sam fail alike: one line for the run
    for (let i = 0; i < 3; i += 1) await n.advance({ hours: 1 });
    expect(skipped()).toHaveLength(first + 3);
    expect(skipped().every((l) => l.code === 'not_connected' && l.error === 'GoogleNotConfiguredError' && l.stack === undefined)).toBe(true);
    expect(w.transport.sent).toEqual([]);
    expect(await w.app.repos.flags.listByAgent(w.alex.agent.id)).toEqual([]);
    expect(await w.actions({ action: 'scheduler.failed' })).toEqual([]);
  });

  it('the /oauth routes stay unregistered', async () => {
    n = await noGoogleWorld();
    const server = buildServer(n.app);
    for (const url of ['/oauth/google/start?state=x', '/oauth/google/callback?state=x&code=y']) {
      expect((await server.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    await server.close();
  });
});
