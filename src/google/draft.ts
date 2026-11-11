import { GoogleInvalidInputError } from './errors.js';

/** RFC 2822 drafts, built by hand. Every header value is validated (no header injection). */

const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 500;
const MAX_BODY = 100_000;
/** A bare address: no display names, quotes, brackets, separators or whitespace. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** Message-ID as Gmail returns it; anything else from a third-party header is dropped. */
const MESSAGE_ID = /^<[^<>\s\u0000-\u001f\u007f]{1,500}>$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** RFC 5321 limits: whole address (forward path minus brackets) and domain. */
const MAX_ADDRESS = 254;
const MAX_DOMAIN = 253;

export interface ReplyContext {
  messageId: string;
  references: string;
}

export interface DraftInput {
  to: string[];
  subject: string;
  body: string;
  reply?: ReplyContext;
}

export function validateRecipients(to: string[]): string[] {
  if (to.length === 0) throw new GoogleInvalidInputError('A draft needs at least one recipient.');
  if (to.length > MAX_RECIPIENTS) throw new GoogleInvalidInputError(`A draft can have at most ${MAX_RECIPIENTS} recipients.`);
  for (const a of to) {
    const domain = a.slice(a.lastIndexOf('@') + 1);
    if (CONTROL.test(a) || a.length > MAX_ADDRESS || domain.length > MAX_DOMAIN || !ADDRESS.test(a)) throw new GoogleInvalidInputError('That email address is not valid.');
  }
  return to;
}

export function validateSubject(subject: string): string {
  if (CONTROL.test(subject)) throw new GoogleInvalidInputError('The subject cannot contain line breaks or control characters.');
  if (subject.length > MAX_SUBJECT) throw new GoogleInvalidInputError('The subject is too long.');
  return subject;
}

/** RFC 2047 B-encoding for non-ASCII; words ≤ 75 chars, never splitting a UTF-8 sequence. */
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    // "=?UTF-8?B?" + "?=" = 12 chars; 45 bytes → 60 base64 chars → 72 ≤ 75.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Only well-formed `<id@host>` tokens survive from third-party References headers. */
export function cleanMessageIds(raw: string): string[] {
  return raw.split(/\s+/).filter((t) => MESSAGE_ID.test(t));
}

/** References kept on a reply: the thread root plus the most recent ones (as mail clients do). */
const MAX_REFERENCES = 11;
const FOLD_AT = 78;

/**
 * Folds `name: item1<sep>item2…` with CRLF + space between items so physical lines stay
 * near 78 characters (RFC 5322 2.1.1/2.2.3). One item longer than that keeps its own line;
 * every item is ≤ 500 characters, far below the 998 limit.
 */
export function foldHeader(name: string, items: string[], sep: string): string {
  const lines: string[] = [];
  let line = `${name}:`;
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item}${sep.trimEnd()}` : item;
    if (line.length + 1 + piece.length > FOLD_AT && line.trim() !== `${name}:`) {
      lines.push(line);
      line = ` ${piece}`;
    } else line += ` ${piece}`;
  });
  lines.push(line);
  return lines.join('\r\n');
}

function base64Lines(text: string): string {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** The raw RFC 2822 message, base64url as the Gmail API wants it. */
export function buildRawDraft(d: DraftInput): string {
  const to = validateRecipients(d.to);
  const subject = validateSubject(d.subject);
  if (d.body.length > MAX_BODY) throw new GoogleInvalidInputError('The draft is too long.');
  const headers = [foldHeader('To', to, ', '), `Subject: ${encodeHeaderWord(subject)}`];
  if (d.reply && MESSAGE_ID.test(d.reply.messageId)) {
    let refs = [...cleanMessageIds(d.reply.references).filter((r) => r !== d.reply!.messageId), d.reply.messageId];
    if (refs.length > MAX_REFERENCES) refs = [refs[0]!, ...refs.slice(-(MAX_REFERENCES - 1))];
    headers.push(`In-Reply-To: ${d.reply.messageId}`, foldHeader('References', refs, ' '));
  }
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
  const body = d.body.replace(/\r\n?|\n/g, '\r\n');
  const message = `${headers.join('\r\n')}\r\n\r\n${base64Lines(body)}\r\n`;
  return Buffer.from(message, 'utf8').toString('base64url');
}
