import { describe, expect, it } from 'vitest';
import { formatRange, isoInZone, isoInstant, parseInstant } from '../../../src/brain/time.js';

const NY = 'America/New_York';

describe('time helpers', () => {
  it('writes instants in the zone with the right offset, across DST', () => {
    expect(isoInZone(new Date('2026-11-14T00:00:00Z'), NY)).toBe('2026-11-13T19:00:00-05:00');
    expect(isoInZone(new Date('2026-07-01T16:30:00Z'), NY)).toBe('2026-07-01T12:30:00-04:00');
    expect(isoInZone(new Date('2026-11-13T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-14T00:30:00+05:30');
    expect(isoInZone(new Date('2026-11-13T19:00:00Z'), 'UTC')).toBe('2026-11-13T19:00:00+00:00');
  });

  it('formats ranges compactly', () => {
    const d = (s: string) => new Date(s);
    expect(formatRange(d('2026-11-13T19:00:00-05:00'), d('2026-11-13T20:30:00-05:00'), NY)).toBe('Fri Nov 13, 7:00–8:30 PM');
    expect(formatRange(d('2026-11-13T11:00:00-05:00'), d('2026-11-13T13:00:00-05:00'), NY)).toBe('Fri Nov 13, 11:00 AM – 1:00 PM');
    expect(formatRange(d('2026-11-13T23:00:00-05:00'), d('2026-11-14T01:00:00-05:00'), NY)).toBe('Fri Nov 13, 11:00 PM – Sat Nov 14, 1:00 AM');
    expect(formatRange(d('2026-11-13T00:00:00-05:00'), d('2026-11-13T00:30:00-05:00'), NY)).toBe('Fri Nov 13, 12:00–12:30 AM');
  });

  it('accepts only ISO 8601 with an explicit offset', () => {
    expect(isoInstant.safeParse('2026-11-13T19:00:00-05:00').success).toBe(true);
    expect(isoInstant.safeParse('2026-11-13T19:00Z').success).toBe(true);
    for (const bad of ['2026-11-13T19:00:00', '2026-11-13', 'tomorrow', '2026-11-13T19:00:00+0500', '2026-02-30T25:00:00Z']) {
      expect(isoInstant.safeParse(bad).success, bad).toBe(false);
      expect(() => parseInstant(bad), bad).toThrow();
    }
  });
});
