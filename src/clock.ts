export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface Duration {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  ms?: number;
}

export function durationMs(d: Duration): number {
  return (
    (d.days ?? 0) * 86_400_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.minutes ?? 0) * 60_000 +
    (d.seconds ?? 0) * 1_000 +
    (d.ms ?? 0)
  );
}

export function addMs(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

/** Deterministic clock for tests and the demo. Time moves only when told. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-11-09T09:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advance(by: Duration | number): Date {
    this.current += typeof by === 'number' ? by : durationMs(by);
    return this.now();
  }
}
