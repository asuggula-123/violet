import { GoogleDeniedError } from './errors.js';

/**
 * I8: the complete list of Google calls Violet may make. Matching is on the parsed URL
 * (exact host, exact path segments, known query keys), never on a string prefix.
 * There is no route that sends email.
 */

const ID = Symbol('id');
type Segment = string | typeof ID;

interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  host: string;
  path: readonly Segment[];
  query: readonly string[];
  /** Query keys whose every value must be one of these (e.g. sendUpdates=none only). */
  pinned?: Readonly<Record<string, readonly string[]>>;
}

const OAUTH = 'oauth2.googleapis.com';
const API = 'www.googleapis.com';
const GMAIL = 'gmail.googleapis.com';
const EVENTS = ['calendar', 'v3', 'calendars', 'primary', 'events'];
const ME = ['gmail', 'v1', 'users', 'me'];

export const ALLOWED_ROUTES: readonly Route[] = [
  { method: 'POST', host: OAUTH, path: ['token'], query: [] },
  { method: 'POST', host: API, path: ['calendar', 'v3', 'freeBusy'], query: [] },
  { method: 'GET', host: API, path: EVENTS, query: ['timeMin', 'timeMax', 'singleEvents', 'orderBy', 'pageToken', 'maxResults'] },
  { method: 'POST', host: API, path: EVENTS, query: ['sendUpdates'], pinned: { sendUpdates: ['none'] } },
  { method: 'DELETE', host: API, path: [...EVENTS, ID], query: ['sendUpdates'], pinned: { sendUpdates: ['none'] } },
  { method: 'GET', host: GMAIL, path: [...ME, 'profile'], query: [] },
  { method: 'GET', host: GMAIL, path: [...ME, 'messages'], query: ['q', 'maxResults', 'pageToken'] },
  { method: 'GET', host: GMAIL, path: [...ME, 'messages', ID], query: ['format', 'metadataHeaders'] },
  { method: 'GET', host: GMAIL, path: [...ME, 'threads', ID], query: ['format', 'metadataHeaders'] },
  { method: 'POST', host: GMAIL, path: [...ME, 'drafts'], query: [] },
];

/** Gmail and Calendar ids (including recurring-instance ids) use only these characters. */
const ID_SEGMENT = /^[A-Za-z0-9_-]{1,1024}$/;
/** Literal path segments must look like this; anything else (`.`, `..`, `%2f`, `\`) is refused. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Returns the parsed URL when the call is allowed; throws GoogleDeniedError otherwise. */
export function checkAllowed(method: string, rawUrl: string): URL {
  const deny = (why: string): never => {
    throw new GoogleDeniedError(`google call denied (${why}): ${method} ${describe(rawUrl)}`);
  };
  if (!rawUrl.startsWith('https://') || /[\\\s]/.test(rawUrl)) return deny('scheme or characters');
  const afterScheme = rawUrl.slice('https://'.length);
  const rawPath = afterScheme.slice(afterScheme.indexOf('/')).split(/[?#]/)[0] ?? '';
  if (!afterScheme.includes('/') || rawPath.includes('%')) return deny('encoded or missing path');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('unparseable URL');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') {
    return deny('scheme, credentials, port or fragment');
  }
  // The raw path must already be in normal form (no dot segments) and the host part
  // must be the bare host: anything URL parsing rewrote is refused.
  if (rawPath !== url.pathname || afterScheme.slice(0, afterScheme.indexOf('/')) !== url.hostname) return deny('not in normal form');
  const segments = url.pathname.split('/').slice(1);
  if (segments.some((s) => !PLAIN_SEGMENT.test(s))) return deny('bad path segment');

  const route = ALLOWED_ROUTES.find(
    (r) => r.method === method && r.host === url.hostname && r.path.length === segments.length && r.path.every((p, i) => matches(p, segments[i]!)),
  );
  if (!route) return deny('not on the allow-list');
  for (const key of url.searchParams.keys()) {
    if (!route.query.includes(key)) deny(`query parameter ${key}`);
  }
  for (const [key, values] of Object.entries(route.pinned ?? {})) {
    if (url.searchParams.getAll(key).some((v) => !values.includes(v))) deny(`query value of ${key}`);
  }
  return url;
}

function matches(p: Segment, s: string): boolean {
  return p === ID ? ID_SEGMENT.test(s) : p === s;
}

/** Host and path only, capped — never the query (it could carry anything). */
export function describe(rawUrl: string): string {
  const noQuery = rawUrl.split('?')[0] ?? '';
  // Control characters and lone surrogates (jsonb rejects NUL and unpaired surrogates) are shown as escapes.
  return noQuery
    .slice(0, 200)
    .replace(/[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, (c) => {
      const n = c.charCodeAt(0);
      return n < 0x100 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16)}`;
    });
}
