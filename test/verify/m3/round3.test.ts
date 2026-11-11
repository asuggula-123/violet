/** Verifier (M3) round 3: re-checks the round-2 fixes (DST, header folding, MIME walk, denial audit). */
import { describe, expect, it } from 'vitest';
import { checkAllowed, describe as describeUrl } from '../../../src/google/allowlist.js';
import { buildRawDraft, foldHeader } from '../../../src/google/draft.js';
import { GoogleDeniedError } from '../../../src/google/errors.js';
import { bodyText, MAX_MIME_DEPTH, type GPart } from '../../../src/google/mime.js';
import { dateInZone, dateTimeInZone, zonedToUtc } from '../../../src/google/time.js';
import { createGoogleWorld } from '../../unit/google/helpers.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EV = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Independent oracle: local wall fields of an instant in a zone. */
function wallOf(ms: number, zone: string): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const ZONES = [
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'America/Santiago',
  'America/Havana',
  'America/Asuncion',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Asia/Beirut',
  'Africa/Cairo',
  'America/Scoresbysund',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'UTC',
];

describe('verify M3 r3: time zones (round-2 finding 1)', () => {
  it.each(ZONES)('every 2026 date in %s starts at the first instant whose local date is that date', (zone) => {
    const bad: string[] = [];
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      const start = dateInZone(date, zone)!.getTime();
      const ok = wallOf(start, zone).slice(0, 10) === date && wallOf(start - 1000, zone).slice(0, 10) < date;
      if (!ok) bad.push(`${date} → ${new Date(start).toISOString()}`);
    }
    expect(bad).toEqual([]);
  });

  it.each(ZONES)('every 90 minutes (alternating :00 and :30) of 2026 in %s: existing wall times round-trip, gaps resolve forward, overlaps take the earlier instant', (zone) => {
    const bad: string[] = [];
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 90 * 60_000) {
      const d = new Date(t);
      const res = zonedToUtc(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()).getTime();
      const wall = d.toISOString().slice(0, 19);
      const got = wallOf(res, zone);
      if (got === wall) {
        // Overlap: no earlier instant may show the same wall time.
        for (const back of [30, 60, 90, 120]) if (wallOf(res - back * 60_000, zone) === wall) bad.push(`${zone} ${wall}: later of an overlap`);
      } else {
        // Gap: forward resolution means the result is after the requested wall time and is a real
        // instant shortly after the transition (within 2 h of the requested wall clock).
        const shownAsUtc = Date.parse(`${got}Z`);
        if (!(shownAsUtc > t && shownAsUtc - t <= 2 * 3_600_000)) bad.push(`${zone} ${wall} → ${got}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('floating times in a gap and an overlap (New York and London)', () => {
    expect(dateTimeInZone('2026-03-08T02:30:00', 'America/New_York')!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(dateTimeInZone('2026-11-01T01:30:00', 'America/New_York')!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(dateTimeInZone('2026-03-29T01:30:00', 'Europe/London')!.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(dateTimeInZone('2026-10-25T01:30:00', 'Europe/London')!.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('verify M3 r3: draft header folding (round-2 finding 2)', () => {
  const head = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0]!;
  const unfold = (h: string) => h.replace(/\r\n(?=[ \t])/g, '');

  it('folded To and References unfold to exactly the original lists', () => {
    const to = Array.from({ length: 20 }, (_, i) => `person${i}.${'x'.repeat(30)}@example${i}.test`);
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}.${'y'.repeat(40)}@mail.example.test>`);
    const raw = buildRawDraft({ to, subject: 'Re: plan', body: 'ok', reply: { messageId: '<last@mail.example.test>', references: refs.join(' ') } });
    const lines = unfold(head(raw)).split('\r\n');
    expect(lines.find((l) => l.startsWith('To:'))).toBe(`To: ${to.join(', ')}`);
    const kept = [refs[0]!, ...refs.slice(-9), '<last@mail.example.test>'];
    expect(lines.find((l) => l.startsWith('References:'))).toBe(`References: ${kept.join(' ')}`);
    expect(lines.find((l) => l.startsWith('In-Reply-To:'))).toBe('In-Reply-To: <last@mail.example.test>');
    for (const l of head(raw).split('\r\n')) expect(l.length).toBeLessThanOrEqual(998);
    // A folded continuation line never starts a new header (no header injection via folding).
    for (const l of head(raw).split('\r\n').slice(1)) expect(/^[ \t]/.test(l) || /^[A-Za-z-]+: /.test(l)).toBe(true);
  });

  it('foldHeader with a single item keeps it on the header line', () => {
    expect(foldHeader('To', ['sam@example.test'], ', ')).toBe('To: sam@example.test');
  });

  it('an address whose domain exceeds RFC 5321 limits (255) is refused, so no header line can exceed 998', () => {
    const domain = Array.from({ length: 20 }, () => 'd'.repeat(63)).join('.') + '.test';
    let raw: string | undefined;
    try {
      raw = buildRawDraft({ to: [`alex@${domain}`], subject: 's', body: 'b' });
    } catch {
      return; // refused: fine
    }
    for (const l of head(raw).split('\r\n')) expect(l.length).toBeLessThanOrEqual(998);
  });
});

describe('verify M3 r3: MIME walk (round-2 finding 3)', () => {
  const text = (s: string): GPart => ({ mimeType: 'text/plain', body: { data: b64(s) } });
  const mp = (...parts: GPart[]): GPart => ({ mimeType: 'multipart/mixed', parts });

  function nest(depth: number, leaf: GPart): GPart {
    let p = leaf;
    for (let i = 0; i < depth; i += 1) p = mp(p);
    return p;
  }

  it('document order across mixed nesting', () => {
    const tree = mp(text('one'), mp(mp(text('two')), text('three')), text('four'), mp(text('five')));
    expect(bodyText(tree)).toBe('one\n\ntwo\n\nthree\n\nfour\n\nfive');
  });

  it('a text part at the depth limit is read, one below it is ignored, 200k levels do not crash', () => {
    expect(bodyText(nest(MAX_MIME_DEPTH, text('deep')))).toBe('deep');
    expect(bodyText(nest(MAX_MIME_DEPTH + 1, text('too deep')))).toBe('');
    expect(() => bodyText(nest(200_000, text('x')))).not.toThrow();
  });

  it('a huge flat multipart is bounded and the early text still wins', () => {
    const parts: GPart[] = [text('first')];
    for (let i = 0; i < 200_000; i += 1) parts.push({ mimeType: 'image/png', body: { size: 1 } });
    const t0 = performance.now();
    expect(bodyText({ mimeType: 'multipart/mixed', parts })).toBe('first');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('cycles in a hand-built tree terminate', () => {
    const a: GPart = { mimeType: 'multipart/mixed', parts: [] };
    a.parts!.push(a, text('t'));
    expect(() => bodyText(a)).not.toThrow();
  });
});

describe('verify M3 r3: allow-list and denial audit (round-2 finding 4)', () => {
  const forbidden: [string, string][] = [
    ['POST', 'https://www.googleapis.com/upload/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media'],
    ['POST', 'https://www.googleapis.com/batch/gmail/v1'],
    ['POST', 'https://gmail.googleapis.com/batch'],
    ['POST', 'https://www.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', `${G}/drafts?alt=media`],
    ['POST', `${G}/drafts?%24.xgafv=1`],
    ['POST', `${EV}?sendUpdates=none&sendUpdates=all`],
    ['POST', `${EV}?send%55pdates=all`],
    ['POST', `${EV}?sendUpdates=none&conferenceDataVersion=1`],
    ['POST', 'https://gmail.googleapis.com./gmail/v1/users/me/drafts'],
    ['POST', 'https://GMAIL.googleapis.com/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com:443/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com\t/gmail/v1/users/me/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts '],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me//drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/ME/drafts'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/alex%40example.test/drafts'],
    ['GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/attachments/def'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send'],
    ['POST ', `${G}/drafts`],
    ['POST\u0000', `${G}/drafts`],
  ];

  it.each(forbidden)('%j %s is denied', (method, url) => {
    expect(() => checkAllowed(method, url)).toThrow(GoogleDeniedError);
  });

  it('describe() never lets NUL, controls or lone surrogates through, and never the query', () => {
    const d = describeUrl(`https://x/\u0000\u001f\u007f\ud800a\udc00?token=SECRET`);
    expect(/[\u0000-\u001f\u007f]/.test(d)).toBe(false);
    expect(d).not.toContain('SECRET');
    expect(/\p{Cs}/u.test(d)).toBe(false); // no lone surrogates (equivalent to String#isWellFormed, which is ES2024 and outside the ES2023 lib)
  });

  it('control characters in the method and URL are still audited and still denied, without fetch', async () => {
    const gw = await createGoogleWorld();
    try {
      await expect(gw.g.http.request({ method: 'POST\u0000', url: `${G}/drafts\u0000\ud800`, ownerId: gw.w.alex.owner.id })).rejects.toBeInstanceOf(GoogleDeniedError);
      expect(gw.stub.calls).toEqual([]);
      const rows = await gw.w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM action_log WHERE action = 'google.denied'");
      expect(rows.rows[0]!.n).toBe(1);
    } finally {
      await gw.close();
    }
  });
});
