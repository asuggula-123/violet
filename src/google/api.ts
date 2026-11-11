import { GoogleAuthError, GoogleScopeMissingError, type Capability } from './errors.js';
import type { GoogleHttp } from './http.js';
import type { TokenStore } from './tokens.js';

export interface ApiCall {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  json?: unknown;
}

/**
 * An owner's authorized call: account connected and not revoked, capability granted,
 * access token attached. A 401 drops the cached token and tries once more with a
 * fresh one (a single bounded retry, not a loop).
 */
export class GoogleApi {
  constructor(
    private readonly http: GoogleHttp,
    readonly tokens: TokenStore,
  ) {}

  async call<T>(ownerId: string, capability: Capability, req: ApiCall): Promise<T> {
    const account = await this.tokens.active(ownerId);
    if (!account.capabilities[capability]) {
      throw new GoogleScopeMissingError(`owner ${ownerId} has not granted ${capability}`, capability);
    }
    const send = async () => {
      const token = await this.tokens.accessToken(ownerId);
      try {
        return await this.http.request<T>({ ...req, ownerId, accessToken: token });
      } catch (err) {
        if (err instanceof GoogleAuthError) this.tokens.invalidate(ownerId, token);
        if (err instanceof GoogleScopeMissingError) throw new GoogleScopeMissingError(err.message, capability, err.status);
        throw err;
      }
    };
    try {
      return await send();
    } catch (err) {
      if (err instanceof GoogleAuthError && err.status === 401) return send();
      throw err;
    }
  }
}

/** Builds a URL with query parameters (repeated keys for arrays). */
export function url(base: string, query: Record<string, string | number | boolean | string[] | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, String(item));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
