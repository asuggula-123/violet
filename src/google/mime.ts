/** Reading Gmail's parsed MIME tree into plain text. */

export const MAX_BODY_CHARS = 20_000;
/** HTML beyond this many characters is never looked at (the text is capped far lower). */
export const MAX_HTML_CHARS = 4 * MAX_BODY_CHARS;
/** Raw base64url decoded per part: enough for MAX_HTML_CHARS of 4-byte UTF-8. */
const MAX_PART_B64 = Math.ceil((MAX_HTML_CHARS * 4) / 3) + 4;

export interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}

export function header(part: GPart | undefined, name: string): string {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? '';
}

function isAttachment(p: GPart): boolean {
  return (p.filename ?? '') !== '' || /^\s*attachment/i.test(header(p, 'Content-Disposition'));
}

function charsetOf(p: GPart): string {
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(header(p, 'Content-Type'))?.[1] ?? 'utf-8';
}

function decodePart(p: GPart): string {
  const raw = p.body?.data;
  if (!raw) return '';
  // Cap before decoding: a 25 MB part is never fully decoded (the text is capped anyway).
  const data = raw.length > MAX_PART_B64 ? raw.slice(0, MAX_PART_B64 - (MAX_PART_B64 % 4)) : raw;
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charsetOf(p)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Sender-controlled structure: deeper nesting and parts beyond this are ignored. */
export const MAX_MIME_DEPTH = 50;
export const MAX_MIME_PARTS = 500;

/** Depth-first, iterative (no recursion over sender input): inline parts of one MIME type, in document order. */
function collect(root: GPart, type: string): GPart[] {
  const out: GPart[] = [];
  const stack: { p: GPart; depth: number }[] = [{ p: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_MIME_PARTS) {
    const { p, depth } = stack.pop()!;
    visited += 1;
    const mime = (p.mimeType ?? '').toLowerCase();
    if (mime.startsWith('multipart/')) {
      if (depth >= MAX_MIME_DEPTH || !Array.isArray(p.parts)) continue;
      // Pushed in reverse so the first child is popped first (document order).
      // The stack never holds more than the parts still allowed to be visited.
      const room = Math.max(0, Math.min(p.parts.length, MAX_MIME_PARTS - visited - stack.length));
      for (let i = room - 1; i >= 0; i -= 1) {
        const c = p.parts[i];
        if (c && typeof c === 'object') stack.push({ p: c, depth: depth + 1 });
      }
    } else if (mime === type && !isAttachment(p) && p.body?.data) out.push(p);
  }
  return out;
}

/** Prefers text/plain; falls back to stripped text/html. Capped at MAX_BODY_CHARS. */
export function bodyText(payload: GPart | undefined): string {
  if (!payload) return '';
  const plain = collect(payload, 'text/plain');
  let text: string;
  if (plain.length > 0) text = plain.map(decodePart).join('\n\n');
  else {
    const html = collect(payload, 'text/html')[0];
    text = html ? htmlToText(decodePart(html)) : '';
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[…truncated]` : text;
}

/** Elements whose content is not text. */
const SKIP_CONTENT = new Set(['script', 'style', 'head', 'title']);
/** Elements whose end starts a new line. */
const BLOCK = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table']);
const TAG_NAME = /\/?([A-Za-z][A-Za-z0-9]*)/y;

/**
 * One linear pass (sender-controlled input: no backtracking regex over the document).
 * The input is capped first; an unclosed tag, comment or script/style/head/title
 * element runs to the end of the input and is dropped.
 */
export function htmlToText(input: string): string {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    TAG_NAME.lastIndex = lt + 1;
    const m = TAG_NAME.exec(html);
    i = gt + 1;
    if (!m || m.index + m[0].length > gt) continue; // not an element tag (e.g. <!doctype>): drop it
    const closing = m[0].startsWith('/');
    const name = m[1]!.toLowerCase();
    if (!closing && SKIP_CONTENT.has(name)) {
      const close = findClose(html, name, i);
      if (close < 0) break;
      i = close;
    } else if (name === 'br' || (closing && BLOCK.has(name))) out.push('\n');
  }
  return decodeEntities(out.join(''))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Index just past `</name ...>` at or after `from`, or -1. Linear: each '<' is examined once. */
function findClose(html: string, name: string, from: number): number {
  let at = from;
  for (;;) {
    const lt = html.indexOf('</', at);
    if (lt < 0) return -1;
    const after = lt + 2 + name.length;
    if (html.slice(lt + 2, after).toLowerCase() === name && !/[A-Za-z0-9]/.test(html.charAt(after))) {
      const gt = html.indexOf('>', after);
      return gt < 0 ? -1 : gt + 1;
    }
    at = lt + 2;
  }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in NAMED) return NAMED[k]!;
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}
