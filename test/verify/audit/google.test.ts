/**
 * Independent audit (Google slice): Calendar write only after approval, Gmail read and
 * draft only, never send, secrets. Failing tests are evidence of findings; do not weaken them.
 */
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { calendarEventKind } from '../../../src/approvals/calendarEvent.js';
import { createCalendarWriter, CalendarWriteRefused } from '../../../src/approvals/calendarWriter.js';
import { checkAllowed } from '../../../src/google/allowlist.js';
import { GoogleDeniedError } from '../../../src/google/errors.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { createGoogleWorld, type GoogleWorld } from '../../unit/google/helpers.js';
import { scriptBrain, toolUse } from '../../unit/brain/script.js';

const START = '2026-11-13T19:00:00-05:00';
const END = '2026-11-13T20:30:00-05:00';

describe('audit google: what the calendar_event prompt shows is what is booked', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  const prompts = () => w.transport.sent.filter((m) => m.toAddress === w.alex.address && m.purpose === 'approval');

  it('location and description are booked although the prompt never showed them', async () => {
    w = await createTestWorld();
    const payload = {
      title: 'Dinner',
      start: START,
      end: END,
      location: 'HIDDEN-LOCATION-MARKER',
      description: 'HIDDEN-DESCRIPTION-MARKER: anything a fooled model wrote',
    };
    scriptBrain(w, w.alex, [[toolUse('t1', 'request_calendar_event', payload)], 'Asked you about dinner.']);
    await w.ownerSays(w.alex, 'book dinner friday');
    const prompt = prompts().at(-1)!;
    const a = (await w.app.approvals!.listPending(w.alex.agent.id))[0]!;
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    const booked = w.calendar.writes.find((x) => x.op === 'create');
    expect(booked && booked.op === 'create' ? booked.event : null).toMatchObject({ location: 'HIDDEN-LOCATION-MARKER' });
    // Evidence: the owner's yes booked fields the prompt did not show.
    expect(prompt.text).toContain('HIDDEN-LOCATION-MARKER');
    // Corrected by fix group P (RULING P1): calendar_event has no description any more (the Brain
    // cannot set one), so none is booked; the prompt shows everything that is.
    expect(booked && booked.op === 'create' ? booked.event.description : 'missing').toBeUndefined();
    expect(prompt.text).not.toContain('HIDDEN-DESCRIPTION-MARKER');
  });

  it('a title longer than 80 characters is cut in the prompt but booked whole', async () => {
    w = await createTestWorld();
    const title = `Dinner ${'x'.repeat(80)} TAIL-THE-OWNER-NEVER-SAW`;
    scriptBrain(w, w.alex, [[toolUse('t1', 'request_calendar_event', { title, start: START, end: END })], 'Asked.']);
    await w.ownerSays(w.alex, 'book dinner friday');
    const prompt = prompts().at(-1)!;
    const a = (await w.app.approvals!.listPending(w.alex.agent.id))[0]!;
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    const booked = w.calendar.writes.find((x) => x.op === 'create');
    expect(booked && booked.op === 'create' ? booked.event.title : '').toContain('TAIL-THE-OWNER-NEVER-SAW');
    expect(prompt.text).toContain('TAIL-THE-OWNER-NEVER-SAW');
  });
});

describe('audit google: CalendarWriter refuses everything but an approved approval (I6)', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('pending, denied, cancelled, expired and unknown approvals book nothing; a re-used approval books once', async () => {
    w = await createTestWorld();
    const writer = w.app.approvals!.calendar;
    const req = () => w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', start: START, end: END } });
    const pending = await req();
    await expect(writer.executeApproved(pending.id)).rejects.toBeInstanceOf(CalendarWriteRefused);
    const denied = await req();
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `deny:${denied.id}` });
    await expect(writer.executeApproved(denied.id)).rejects.toBeInstanceOf(CalendarWriteRefused);
    const cancelled = await req();
    await w.app.approvals!.cancel(cancelled.id, 'test');
    await expect(writer.executeApproved(cancelled.id)).rejects.toBeInstanceOf(CalendarWriteRefused);
    await expect(writer.executeApproved('no-such-approval')).rejects.toBeInstanceOf(CalendarWriteRefused);
    const expiring = await w.app.approvals!.request(w.alex.agent.id, {
      kind: 'calendar_event',
      payload: { title: 'Dinner', start: START, end: END },
      expiresAt: new Date(w.clock.now().getTime() + 60_000),
    });
    w.clock.advance({ minutes: 5 });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${expiring.id}` });
    await expect(writer.executeApproved(expiring.id)).rejects.toBeInstanceOf(CalendarWriteRefused);
    expect(w.calendar.writes).toEqual([]);

    // Sam's button for Alex's approval resolves nothing.
    const alexOwn = await req();
    await w.ownerSays(w.sam, '', { kind: 'button', buttonPayload: `approve:${alexOwn.id}` });
    expect((await w.app.approvals!.get(alexOwn.id))!.status).toBe('pending');
    expect(w.calendar.writes).toEqual([]);

    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${alexOwn.id}` });
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
    await writer.executeApproved(alexOwn.id);
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${alexOwn.id}` });
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toHaveLength(1);
  });
});

describe('audit google: allow-list probes (I8)', () => {
  const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const EV = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const denied: [string, string][] = [
    ['post', `${G}/drafts`],
    ['Post', `${G}/drafts`],
    ['POST', `${G.replace('/me', '/ME')}/drafts`],
    ['POST', `${G}/Drafts`],
    ['POST', `${G}/DRAFTS/send`],
    ['POST', 'https://GMAIL.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com./gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com:443/gmail/v1/users/me/drafts'],
    ['POST', `${G}/drafts%2Fsend`],
    ['POST', `${G}/drafts%2fsend`],
    ['POST', `${G}/drafts;send`],
    ['POST', `${G}/drafts/send/`],
    ['POST', `${G}/drafts?$httpMethod=send`],
    ['POST', `${G}/drafts?x=1&uploadType=multipart`],
    ['GET', `${G}/drafts/send`],
    ['PUT', `${G}/drafts/abc`],
    ['PATCH', `${EV}/abc`],
    ['PUT', `${EV}/abc`],
    ['POST', `${EV}/import`],
    ['POST', `${EV}/quickAdd`],
    ['POST', `${EV}/abc/move`],
    ['POST', `${EV}?sendUpdates=all`],
    ['POST', `${EV}?sendUpdates=none&sendUpdates=all`],
    ['POST', `${EV}?sendNotifications=true`],
    ['DELETE', `${EV}/abc?sendUpdates=externalOnly`],
    ['POST', `${G}/messages/insert`],
    ['POST', `${G}/messages/import`],
    ['POST', `${G}/messages/send`],
    ['POST', `${G}/settings/forwardingAddresses`],
    ['PUT', `${G}/settings/autoForwarding`],
    ['POST', `${G}/settings/filters`],
    ['POST', `${G}/settings/delegates`],
    ['PUT', `${G}/settings/vacation`],
    ['POST', 'https://www.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media'],
    ['POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts'],
    ['POST', 'https://www.googleapis.com/batch/gmail/v1'],
    ['POST', 'https://content-gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com\\@evil.example/gmail/v1/users/me/drafts'],
    ['POST', 'https://user@gmail.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', `${G}/drafts#send`],
    ['POST', `http://gmail.googleapis.com/gmail/v1/users/me/drafts`],
    ['GET', `${G}/messages/abc?alt=media`],
    ['GET', `${G}/messages/abc?format=raw&fields=raw`],
  ];
  for (const [m, u] of denied) {
    it(`denies ${m} ${u}`, () => {
      expect(() => checkAllowed(m, u)).toThrow(GoogleDeniedError);
    });
  }
  it('still allows the real calls', () => {
    expect(() => checkAllowed('POST', `${G}/drafts`)).not.toThrow();
    expect(() => checkAllowed('POST', `${EV}?sendUpdates=none`)).not.toThrow();
    expect(() => checkAllowed('DELETE', `${EV}/abc?sendUpdates=none`)).not.toThrow();
  });
});

describe('audit google: true reasons when Google is configured but the owner is not connected', () => {
  let gw: GoogleWorld;
  afterEach(async () => gw.close());

  it('an approved calendar_event for an owner who never connected Google says so', async () => {
    gw = await createGoogleWorld();
    const w = gw.w;
    const approval = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', start: START, end: END } });
    await w.db.query(`UPDATE approvals SET status = 'approved', resolved_at = $2 WHERE id = $1`, [approval.id, w.clock.now()]);
    const writer = createCalendarWriter({
      db: w.db,
      clock: w.clock,
      repos: w.app.repos,
      calendar: gw.g.calendar,
      actionLog: w.app.actionLog,
      flags: w.app.flags,
      log: pino({ level: 'silent' }),
      kind: (n) => (n === 'calendar_event' ? calendarEventKind : undefined),
    });
    const result = await writer.executeApproved(approval.id);
    expect(gw.stub.calls).toEqual([]); // no network call at all
    expect(result.ok).toBe(false);
    // Evidence (minor): GoogleNotConnectedError has only safeMessage, which nothing reads, so the
    // owner hears the generic "the calendar didn't accept it" instead of "Google isn't connected".
    expect(result.ok ? '' : result.reason).toMatch(/connect/i);
  });
});

describe('audit google: a transient Google error at booking time', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('ends the owner-approved booking failed for good, with no retry (evidence, minor)', async () => {
    const { GoogleTransientError } = await import('../../../src/google/errors.js');
    w = await createTestWorld();
    const create = w.calendar.createEvent.bind(w.calendar);
    let failed = false;
    w.calendar.createEvent = async (...args) => {
      if (!failed) {
        failed = true;
        throw new GoogleTransientError('google POST events: HTTP 503', 503);
      }
      return create(...args);
    };
    const a = await w.app.approvals!.request(w.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', start: START, end: END } });
    await w.ownerSays(w.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
    await w.advance({ minutes: 30 });
    // P6: a typed Google error names itself in the owner's line (its ownerMessage).
    expect(w.lastTo(w.alex.address)).toBe("I couldn't book #1: Google didn't respond properly. Try again shortly.");
    // A retryable error (503) is not retried: the yes is spent and nothing is booked.
    // RULING R17: no code change; this is a known limit, stated in the README.
    expect((await w.app.approvals!.get(a.id))!.status).toBe('failed');
    expect(w.calendar.writes.filter((x) => x.op === 'create')).toEqual([]);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')).toContain('A temporary Google error at the moment of booking fails the booking; ask again.');
  });
});
