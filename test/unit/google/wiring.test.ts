import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { parseConfig } from '../../../src/config.js';
import { createDeps } from '../../../src/deps.js';
import { FakeCalendar, FakeGmail } from '../../../src/google/fake.js';
import { GoogleCalendar } from '../../../src/google/calendar.js';
import { GoogleGmail } from '../../../src/google/gmail.js';
import { createGoogle, googleConfigured, googleModule, googleOf } from '../../../src/google/services.js';
import { REVOKED_FLAG_TEXT } from '../../../src/google/tokens.js';
import { defaultModules } from '../../../src/modules.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { googleEnv, SECRETS, StubFetch, TOKEN_URL } from './helpers.js';

describe('Google wiring', () => {
  let w: TestWorld;
  beforeEach(async () => {
    w = await createTestWorld();
  });
  afterEach(async () => w.close());

  it('createDeps uses the real providers only when all four settings are set', () => {
    const real = createDeps(parseConfig(googleEnv()), w.db);
    expect(real.calendar).toBeInstanceOf(GoogleCalendar);
    expect(real.gmail).toBeInstanceOf(GoogleGmail);
    expect(googleOf(real)).not.toBeNull();
    for (const missing of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'TOKEN_ENC_KEY']) {
      const config = parseConfig(googleEnv({ [missing]: '' }));
      expect(googleConfigured(config)).toBe(false);
      const fake = createDeps(config, w.db);
      expect(fake.calendar).toBeInstanceOf(FakeCalendar);
      expect(fake.gmail).toBeInstanceOf(FakeGmail);
      expect(googleOf(fake)).toBeNull();
    }
  });

  it('a malformed TOKEN_ENC_KEY fails at start-up with a clear error', () => {
    expect(() => createDeps(parseConfig(googleEnv({ TOKEN_ENC_KEY: randomBytes(16).toString('base64') })), w.db)).toThrow(/TOKEN_ENC_KEY must decode to 32 bytes/);
  });

  it('GOOGLE_SCOPES is parsed by config and used for consent', async () => {
    const config = parseConfig(googleEnv({ GOOGLE_SCOPES: ' https://www.googleapis.com/auth/calendar.readonly ' }));
    expect(config.GOOGLE_SCOPES).toBe('https://www.googleapis.com/auth/calendar.readonly');
    const g = createGoogle({ config, db: w.db, clock: w.clock, log: pino({ level: 'silent' }), fetch: new StubFetch().fetch });
    const link = await g.oauth.createConnectLink(w.alex.owner.id);
    const consent = new URL((await g.oauth.consentUrl(new URL(link).searchParams.get('state')!))!);
    expect(consent.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('defaultModules includes googleModule, which routes revocation flags through app.flags', async () => {
    expect(defaultModules).toContain(googleModule);
    const stub = new StubFetch();
    const g = createGoogle({ config: parseConfig(googleEnv()), db: w.db, clock: w.clock, log: pino({ level: 'silent' }), fetch: stub.fetch });
    const app = await buildApp({ ...w.app.deps, calendar: g.calendar, gmail: g.gmail }, [googleModule]);
    await g.tokens.save(w.alex.owner.id, { email: null, refreshToken: SECRETS.refreshToken, scopes: ['https://www.googleapis.com/auth/calendar.freebusy'] });
    stub.expect({ method: 'POST', url: TOKEN_URL, respond: { status: 400, json: { error: 'invalid_grant' } } });
    await expect(g.calendar.freeBusy(w.alex.owner.id, w.clock.now(), w.clock.now())).rejects.toMatchObject({ code: 'auth' });
    expect(w.transport.textsTo(w.alex.address)).toEqual([REVOKED_FLAG_TEXT]);
    await app.stop();
  });
});
