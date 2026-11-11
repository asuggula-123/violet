import { describe, expect, it } from 'vitest';
import { addDays, isQuietHours, localDate, quietHoursEnd, startOfLocalDate } from '../../../src/flags/time.js';
import { NY } from './helpers.js';

describe('owner-local time helpers', () => {
  it('local dates differ by zone for the same instant', () => {
    const t = new Date('2026-11-10T02:00:00Z');
    expect(localDate(NY, t)).toBe('2026-11-09');
    expect(localDate('Pacific/Kiritimati', t)).toBe('2026-11-10');
    expect(localDate('UTC', t)).toBe('2026-11-10');
  });

  it('days are 23 and 25 hours long across DST', () => {
    const len = (d: string) => (startOfLocalDate(NY, addDays(d, 1)).getTime() - startOfLocalDate(NY, d).getTime()) / 3_600_000;
    expect(len('2027-03-14')).toBe(23);
    expect(len('2026-11-01')).toBe(25);
    expect(len('2026-11-09')).toBe(24);
  });

  it('quiet hours are [22:00, 07:00) and end at the next 07:00', () => {
    expect(isQuietHours(NY, new Date('2026-11-10T02:59:59Z'))).toBe(false); // 21:59:59
    expect(isQuietHours(NY, new Date('2026-11-10T03:00:00Z'))).toBe(true); // 22:00
    expect(isQuietHours(NY, new Date('2026-11-10T11:59:59Z'))).toBe(true); // 06:59:59
    expect(isQuietHours(NY, new Date('2026-11-10T12:00:00Z'))).toBe(false); // 07:00
    expect(quietHoursEnd(NY, new Date('2026-11-10T03:00:00Z')).toISOString()).toBe('2026-11-10T12:00:00.000Z');
    expect(quietHoursEnd(NY, new Date('2026-11-10T09:00:00Z')).toISOString()).toBe('2026-11-10T12:00:00.000Z');
    // Spring forward: 22:00 EST → 07:00 EDT is 8 hours later.
    expect(quietHoursEnd(NY, new Date('2027-03-14T03:00:00Z')).toISOString()).toBe('2027-03-14T11:00:00.000Z');
  });

  it('addDays crosses months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
});
