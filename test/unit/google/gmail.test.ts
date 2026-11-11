import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRawDraft, encodeHeaderWord } from '../../../src/google/draft.js';
import { GoogleInvalidInputError } from '../../../src/google/errors.js';
import { GoogleGmail } from '../../../src/google/gmail.js';
import { bodyText, htmlToText, MAX_BODY_CHARS, MAX_HTML_CHARS, type GPart } from '../../../src/google/mime.js';
import { bearer, createGoogleWorld, expectRefresh, SECRETS, type GoogleWorld } from './helpers.js';

const ME = 'https://gmail.googleapis.com/gmail/v1/users/me';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const part = (mimeType: string, data: string | Buffer, extra: Partial<GPart> = {}): GPart => ({ mimeType, filename: '', body: { data: b64(data) }, ...extra });

/** Decodes a raw draft back into header lines and the decoded body. */
function decodeRaw(raw: string): { headers: string[]; body: string; text: string } {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, encoded] = text.split('\r\n\r\n') as [string, string];
  return { headers: head.split('\r\n'), body: Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8'), text };
}

describe('MIME parsing', () => {
  it('single-part text/plain', () => {
    expect(bodyText(part('text/plain', 'Hello Alex'))).toBe('Hello Alex');
  });

  it('multipart/alternative prefers text/plain over html', () => {
    const p: GPart = { mimeType: 'multipart/alternative', parts: [part('text/html', '<p>HTML</p>'), part('text/plain', 'Plain wins')] };
    expect(bodyText(p)).toBe('Plain wins');
  });

  it('html only → stripped text (scripts, styles, tags, entities)', () => {
    const html =
      '<html><head><style>p{color:red}</style><title>T</title></head><body><script>alert(1)</script>' +
      '<p>Dinner&nbsp;at 7 &amp; drinks</p><div>Line&lt;2&gt;</div>A<br>B &#233; &#x1F600; &quot;q&quot;<!-- hidden --></body></html>';
    expect(bodyText(part('text/html', html))).toBe('Dinner at 7 & drinks\nLine<2>\nA\nB é 😀 "q"');
  });

  it('nested multipart/mixed with attachments: inline text only, attachments ignored', () => {
    const p: GPart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [part('text/plain', 'Body text'), part('text/html', '<b>Body</b>')] },
        part('text/plain', 'attached notes', { filename: 'notes.txt' }),
        part('text/plain', 'disposition attachment', { headers: [{ name: 'Content-Disposition', value: 'attachment; filename=x' }] }),
        { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att1', size: 100 } },
      ],
    };
    expect(bodyText(p)).toBe('Body text');
  });

  it('multiple inline text/plain parts are joined in order', () => {
    const p: GPart = { mimeType: 'multipart/mixed', parts: [part('text/plain', 'One'), part('text/plain', 'Two')] };
    expect(bodyText(p)).toBe('One\n\nTwo');
  });

  it('decodes base64url UTF-8 and other charsets', () => {
    expect(bodyText(part('text/plain', 'Grüße — ✓ 日本'))).toBe('Grüße — ✓ 日本');
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(bodyText(part('text/plain', latin1, { headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }] }))).toBe('café');
    expect(bodyText(part('text/plain', 'ok', { headers: [{ name: 'Content-Type', value: 'text/plain; charset=bogus-charset' }] }))).toBe('ok');
  });

  it('normalizes CRLF, caps the body, handles empty payloads', () => {
    expect(bodyText(part('text/plain', 'a\r\nb\rc'))).toBe('a\nb\nc');
    const long = bodyText(part('text/plain', 'x'.repeat(MAX_BODY_CHARS + 500)));
    expect(long.length).toBeLessThan(MAX_BODY_CHARS + 20);
    expect(long.endsWith('[…truncated]')).toBe(true);
    expect(bodyText(undefined)).toBe('');
    expect(bodyText({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
    expect(bodyText({ mimeType: 'image/png', body: { data: b64('png') } })).toBe('');
  });

  it('htmlToText collapses whitespace', () => {
    expect(htmlToText('<p>  a   b </p>\n\n\n\n<p>c</p>')).toBe('a b\n\nc');
  });

  it('htmlToText drops comments, script/style/head/title content, and maps br and block ends to newlines', () => {
    expect(htmlToText('<html><head><title>T</title><style>p{x:1}</style></head><body>a<!-- c <p>x</p> -->b<br/>c<BR>d</body></html>')).toBe('ab\nc\nd');
    expect(htmlToText('x<SCRIPT type="t">if (a<b) {}</script >y<scripts>z</scripts>')).toBe('xyz');
    expect(htmlToText('<div>one</div><div>two</div><li>3</li>')).toBe('one\ntwo\n3');
    expect(htmlToText('<!doctype html><p>Fish &amp; chips &lt;3 &#x1F600;</p>')).toBe('Fish & chips <3 \u{1F600}');
  });

  it('htmlToText: an unclosed tag, comment or script runs to the end and is dropped', () => {
    expect(htmlToText('keep <a href="x')).toBe('keep');
    expect(htmlToText('keep <!-- never closed <p>x</p>')).toBe('keep');
    expect(htmlToText('keep <script>never closed</p>')).toBe('keep');
  });

  it('htmlToText is linear on hostile input and caps what it reads', () => {
    for (const html of ['<'.repeat(400_000), '<!--'.repeat(200_000), '<script>'.repeat(100_000), '<a'.repeat(200_000) + '>', '<p>x</p>'.repeat(100_000), '</'.repeat(200_000)]) {
      const t0 = performance.now();
      const out = htmlToText(html);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(out.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
    }
    const huge = bodyText(part('text/html', `<p>${'y'.repeat(5_000_000)}</p>`));
    expect(huge.length).toBeLessThan(MAX_BODY_CHARS + 20);
  });

  it('deep or huge MIME trees are walked iteratively with depth and part caps', () => {
    let deep: GPart = part('text/plain', 'too deep');
    for (let i = 0; i < 20_000; i += 1) deep = { mimeType: 'multipart/mixed', parts: [deep] };
    expect(bodyText(deep)).toBe('');
    let shallow: GPart = part('text/plain', 'ok');
    for (let i = 0; i < 10; i += 1) shallow = { mimeType: 'multipart/mixed', parts: [shallow] };
    expect(bodyText(shallow)).toBe('ok');
    const wide: GPart = { mimeType: 'multipart/mixed', parts: Array.from({ length: 5000 }, (_, i) => part('text/plain', `p${i}`)) };
    const out = bodyText(wide);
    expect(out.startsWith('p0\n\np1\n\np2')).toBe(true);
    expect(out).not.toContain('p4999');
  });
});

describe('draft encoding', () => {
  it('builds RFC 2822 with CRLF, UTF-8 base64 body, base64url overall', () => {
    const raw = buildRawDraft({ to: ['sam@example.test', 'alex@example.test'], subject: 'Dinner Friday', body: 'Hi Sam,\nsee you.\n— Alex' });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const d = decodeRaw(raw);
    expect(d.headers).toEqual([
      'To: sam@example.test, alex@example.test',
      'Subject: Dinner Friday',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(d.body).toBe('Hi Sam,\r\nsee you.\r\n— Alex');
    expect(d.text).not.toMatch(/^From:|^Bcc:/m);
  });

  it('RFC 2047 encodes non-ASCII subjects in valid encoded words', () => {
    expect(encodeHeaderWord('Plain ASCII')).toBe('Plain ASCII');
    const subject = 'Café 🎉 '.repeat(10);
    const encoded = encodeHeaderWord(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(subject);
  });

  it('adds In-Reply-To and References for replies, filtering junk ids', () => {
    const raw = buildRawDraft({
      to: ['sam@example.test'],
      subject: 'Re: Dinner',
      body: 'Yes',
      reply: { messageId: '<m2@example.test>', references: '<m1@example.test> junk <bad id> <m2@example.test>' },
    });
    const { headers } = decodeRaw(raw);
    expect(headers).toContain('In-Reply-To: <m2@example.test>');
    expect(headers).toContain('References: <m1@example.test> <m2@example.test>');
  });

  it('drops a malformed Message-ID from the original instead of injecting it', () => {
    const raw = buildRawDraft({ to: ['sam@example.test'], subject: 's', body: 'b', reply: { messageId: '<x>\r\nBcc: evil@example.test', references: '' } });
    const { text } = decodeRaw(raw);
    expect(text).not.toContain('Bcc');
    expect(text).not.toContain('In-Reply-To');
  });

  it.each([
    ['sam@example.test\r\nBcc: evil@example.test'],
    ['sam@example.test\nBcc: evil@example.test'],
    ['Sam <sam@example.test>'],
    ['sam@example.test, evil@example.test'],
    ['sam@example.test;evil@example.test'],
    ['not-an-address'],
    ['@example.test'],
    ['sam@'],
    ['sam@localhost'],
    ['sam @example.test'],
    ['"sam"@example.test'],
    [''],
  ])('rejects recipient %j', (addr) => {
    expect(() => buildRawDraft({ to: [addr], subject: 's', body: 'b' })).toThrow(GoogleInvalidInputError);
  });

  it('enforces RFC 5321 length limits on recipients (domain <= 253, address <= 254)', () => {
    const label = 'd'.repeat(63);
    const domain253 = [label, label, label, 'd'.repeat(56), 'test'].join('.'); // 63*3 + 56 + 4 + 4 dots = 253
    expect(domain253.length).toBe(253);
    // Domain of exactly 253 with a short local part: address 'a@' + 253 = 255 > 254 -> refused.
    expect(() => buildRawDraft({ to: [`a@${domain253}`], subject: 's', body: 'b' })).toThrow(GoogleInvalidInputError);
    const domain252 = domain253.slice(1);
    expect(buildRawDraft({ to: [`a@${domain252}`], subject: 's', body: 'b' })).toBeTruthy(); // 254 chars: accepted
    const longDomain = Array.from({ length: 20 }, () => label).join('.') + '.test';
    expect(() => buildRawDraft({ to: [`alex@${longDomain}`], subject: 's', body: 'b' })).toThrow(GoogleInvalidInputError);
  });

  it.each([['Hi\r\nBcc: evil@example.test'], ['Hi\nX: y'], ['Hi\rX'], ['Tab\tbad'], ['nul\u0000']])('rejects subject %j', (subject) => {
    expect(() => buildRawDraft({ to: ['sam@example.test'], subject, body: 'b' })).toThrow(GoogleInvalidInputError);
  });

  it('rejects empty and oversized recipient lists and oversized subjects/bodies', () => {
    expect(() => buildRawDraft({ to: [], subject: 's', body: 'b' })).toThrow(/at least one recipient/);
    expect(() => buildRawDraft({ to: Array(21).fill('a@example.test'), subject: 's', body: 'b' })).toThrow(/at most 20/);
    expect(() => buildRawDraft({ to: ['a@example.test'], subject: 'x'.repeat(501), body: 'b' })).toThrow(/too long/);
    expect(() => buildRawDraft({ to: ['a@example.test'], subject: 's', body: 'x'.repeat(100_001) })).toThrow(/too long/);
  });

  it('a body cannot add headers: CRLF in the body stays inside the base64 part', () => {
    const { headers, body } = decodeRaw(buildRawDraft({ to: ['sam@example.test'], subject: 's', body: 'x\r\n\r\nBcc: evil@example.test\r\n' }));
    expect(headers.some((h) => h.startsWith('Bcc'))).toBe(false);
    expect(body).toContain('Bcc: evil@example.test');
  });

  it('folds To and References under 78-ish characters and trims long reference chains', () => {
    const refs = Array.from({ length: 500 }, (_, i) => `<id${i}@mail.example.test>`).join(' ');
    const to = Array.from({ length: 20 }, (_, i) => `${'a'.repeat(60)}${i}@${'b'.repeat(60)}.example.test`);
    const { headers, text } = decodeRaw(buildRawDraft({ to, subject: 'Re: hi', body: 'x', reply: { messageId: '<orig@mail.example.test>', references: refs } }));
    for (const l of headers) expect(l.length).toBeLessThanOrEqual(998);
    const unfolded = text.split('\r\n\r\n')[0]!.replace(/\r\n /g, ' ').split('\r\n');
    expect(unfolded.find((l) => l.startsWith('To: '))).toBe(`To: ${to.join(', ')}`);
    const kept = unfolded.find((l) => l.startsWith('References: '))!.slice('References: '.length).split(' ');
    expect(kept).toHaveLength(11);
    expect(kept[0]).toBe('<id0@mail.example.test>');
    expect(kept.at(-2)).toBe('<id499@mail.example.test>');
    expect(kept.at(-1)).toBe('<orig@mail.example.test>');
    const short = decodeRaw(buildRawDraft({ to: ['sam@example.test', 'alex@example.test'], subject: 's', body: 'x' })).headers;
    for (const l of short.slice(2)) expect(l.length).toBeLessThanOrEqual(78);
  });
});

describe('GoogleGmail', () => {
  let gw: GoogleWorld;
  beforeEach(async () => {
    gw = await createGoogleWorld();
    await gw.connect(gw.w.alex.owner.id);
    expectRefresh(gw.stub);
  });
  afterEach(async () => gw.close());

  const owner = () => gw.w.alex.owner.id;
  const meta = (id: string, subject: string) => ({
    id,
    threadId: `t-${id}`,
    snippet: 'See you &amp; Sam at 7 &#39;ish&#39;',
    internalDate: '1794571200000',
    payload: {
      headers: [
        { name: 'From', value: 'Sam <sam@example.test>' },
        { name: 'To', value: 'alex@example.test' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Wed, 11 Nov 2026 09:00:00 -0500' },
      ],
    },
  });

  it('search lists ids then fetches metadata for each, capped', async () => {
    gw.stub.expect({
      method: 'GET',
      url: `${ME}/messages?q=from%3Asam+dinner&maxResults=2`,
      check: (init) => expect(bearer(init)).toBe(`Bearer ${SECRETS.accessToken}`),
      respond: { json: { messages: [{ id: 'm1', threadId: 't-m1' }, { id: 'm2', threadId: 't-m2' }, { id: 'm3' }], resultSizeEstimate: 3 } },
    });
    for (const id of ['m1', 'm2']) {
      gw.stub.expect({
        method: 'GET',
        url: `${ME}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        respond: { json: meta(id, `Subject ${id}`) },
      });
    }
    const results = await gw.g.gmail.search(owner(), 'from:sam dinner', 2);
    expect(results).toEqual([
      { id: 'm1', threadId: 't-m1', from: 'Sam <sam@example.test>', to: 'alex@example.test', subject: 'Subject m1', snippet: "See you & Sam at 7 'ish'", date: new Date(1794571200000) },
      expect.objectContaining({ id: 'm2', subject: 'Subject m2' }),
    ]);
    expect(gw.stub.pending).toBe(0);
  });

  it('search caps max at 25 and handles no results', async () => {
    gw.stub.expect({ method: 'GET', url: `${ME}/messages?q=x&maxResults=25`, respond: { json: { resultSizeEstimate: 0 } } });
    expect(await gw.g.gmail.search(owner(), 'x', 1000)).toEqual([]);
  });

  it('getMessage fetches format=full and extracts the body', async () => {
    gw.stub.expect({
      method: 'GET',
      url: `${ME}/messages/m1?format=full`,
      respond: {
        json: { ...meta('m1', 'Dinner'), payload: { ...meta('m1', 'Dinner').payload, mimeType: 'multipart/alternative', parts: [part('text/plain', 'Friday at 7?'), part('text/html', '<p>Friday at 7?</p>')] } },
      },
    });
    const m = await gw.g.gmail.getMessage(owner(), 'm1');
    expect(m).toMatchObject({ id: 'm1', threadId: 't-m1', subject: 'Dinner', bodyText: 'Friday at 7?' });
  });

  it('createDraft posts raw base64url to drafts, nothing else', async () => {
    gw.stub.expect({
      method: 'POST',
      url: `${ME}/drafts`,
      check: (init) => {
        const sent = JSON.parse(String(init.body));
        expect(Object.keys(sent)).toEqual(['message']);
        expect(Object.keys(sent.message)).toEqual(['raw']);
        expect(decodeRaw(sent.message.raw).headers[0]).toBe('To: sam@example.test');
      },
      respond: { json: { id: 'r-123', message: { id: 'msg', threadId: 'thr' } } },
    });
    expect(await gw.g.gmail.createDraft(owner(), { to: ['sam@example.test'], subject: 'Hi', body: 'Hello' })).toEqual({ draftId: 'r-123' });
  });

  it('createDraft as a reply: threadId plus In-Reply-To/References from the original', async () => {
    gw.stub.expect({
      method: 'GET',
      url: `${ME}/messages/orig1?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
      respond: { json: { id: 'orig1', threadId: 'thread-9', payload: { headers: [{ name: 'Message-Id', value: '<abc@mail.example.test>' }, { name: 'References', value: '<root@mail.example.test>' }] } } },
    });
    gw.stub.expect({
      method: 'POST',
      url: `${ME}/drafts`,
      check: (init) => {
        const sent = JSON.parse(String(init.body));
        expect(sent.message.threadId).toBe('thread-9');
        const { headers } = decodeRaw(sent.message.raw);
        expect(headers).toContain('In-Reply-To: <abc@mail.example.test>');
        expect(headers).toContain('References: <root@mail.example.test> <abc@mail.example.test>');
      },
      respond: { json: { id: 'r-9' } },
    });
    expect(await gw.g.gmail.createDraft(owner(), { to: ['sam@example.test'], subject: 'Re: Dinner', body: 'Yes!', replyToMessageId: 'orig1' })).toEqual({ draftId: 'r-9' });
  });

  it('createDraft rejects header injection before any network call', async () => {
    await expect(gw.g.gmail.createDraft(owner(), { to: ['sam@example.test\r\nBcc: x@example.test'], subject: 's', body: 'b' })).rejects.toBeInstanceOf(GoogleInvalidInputError);
    await expect(gw.g.gmail.createDraft(owner(), { to: ['sam@example.test'], subject: 's\r\nBcc: x@example.test', body: 'b', replyToMessageId: 'orig1' })).rejects.toBeInstanceOf(
      GoogleInvalidInputError,
    );
    expect(gw.stub.calls).toEqual([]);
  });

  it('a replyToMessageId that would leave the allow-list is denied', async () => {
    await expect(gw.g.gmail.createDraft(owner(), { to: ['sam@example.test'], subject: 's', body: 'b', replyToMessageId: 'x/send' })).rejects.toMatchObject({ code: 'denied' });
    await expect(gw.g.gmail.getMessage(owner(), '../drafts/send')).rejects.toMatchObject({ code: 'denied' });
    expect(gw.stub.calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token']);
  });

  it('has no send method of any kind (I8)', () => {
    const names = [...Object.getOwnPropertyNames(GoogleGmail.prototype), ...Object.keys(gw.g.gmail)];
    expect(names.filter((n) => /send/i.test(n))).toEqual([]);
  });
});
