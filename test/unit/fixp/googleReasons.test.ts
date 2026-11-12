/**
 * P6: true owner-facing reasons for Google failures. Every typed Google error carries its safe
 * text as `ownerMessage`, which CalendarWriter and the tool loop read; no text promises a connect
 * link the Brain cannot make.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  GoogleAuthError,
  GoogleDeniedError,
  GoogleError,
  GoogleInvalidInputError,
  GoogleNotConnectedError,
  GoogleRateLimitedError,
  GoogleRequestError,
  GoogleScopeMissingError,
  GoogleTransientError,
} from '../../../src/google/errors.js';
import { GoogleNotConfiguredError, NOT_CONFIGURED_REASON } from '../../../src/google/unconfigured.js';
import { safeToolMessage } from '../../../src/llm/tools.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { FRI } from '../a2a/helpers.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const errors: GoogleError[] = [
  new GoogleNotConnectedError('o1'),
  new GoogleAuthError('refresh failed', 'invalid_grant', 400),
  new GoogleScopeMissingError('no scope', 'calendarWrite'),
  new GoogleDeniedError('POST x'),
  new GoogleRateLimitedError('429', 429),
  new GoogleTransientError('503', 503),
  new GoogleInvalidInputError('That address is not valid.'),
  new GoogleRequestError('400', 400),
];

describe('P6: Google errors give their true reason', () => {
  it('every typed error has ownerMessage = safeMessage, and the tool loop shows it', () => {
    for (const e of errors) {
      expect(e.ownerMessage).toBe(e.safeMessage);
      expect(safeToolMessage(e)).toBe(e.safeMessage);
    }
    expect(new GoogleNotConfiguredError('x').ownerMessage).toBe(NOT_CONFIGURED_REASON);
  });

  it('no text offers what the Brain cannot do (it cannot make a connect link)', () => {
    for (const e of errors) expect(e.safeMessage).not.toMatch(/ask me/i);
    expect(new GoogleNotConnectedError('o1').safeMessage).toBe("Google isn't connected yet. Ask whoever set up Violet for a connect link.");
  });

  for (const e of errors) {
    it(`an approved calendar_event that fails with ${e.name} tells the owner that reason`, async () => {
      w = await createTestWorld();
      const world = w;
      world.calendar.createEvent = async () => {
        throw e;
      };
      const a = await world.app.approvals!.request(world.alex.agent.id, { kind: 'calendar_event', payload: { title: 'Dinner', ...FRI.dinner } });
      await world.ownerSays(world.alex, '', { kind: 'button', buttonPayload: `approve:${a.id}` });
      expect(world.lastTo(world.alex.address)).toBe(`I couldn't book #${a.ref}: ${e.safeMessage.replace(/\.$/, '')}.`);
    });
  }
});
