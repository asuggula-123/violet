/** The period a digest covers: its owner-local date, from the date's first instant to the build time. */
export interface DigestRange {
  date: string;
  from: Date;
  to: Date;
}

/**
 * A digest section. Flag items land in it through registerKind; a section with `lines`
 * is also LIVE: its lines are computed by code when the digest is built (M2 adds
 * 'waiting' = approvals still pending). Lines are sanitized to one line each (I13).
 */
export interface DigestSection {
  key: string;
  title: string;
  order: number;
  lines?(agentId: string, range: DigestRange): Promise<string[]>;
}

export interface DigestService {
  /** Maps a flag kind to a section key; unknown kinds go to 'also'. */
  registerKind(kind: string, sectionKey: string): void;
  /** Adds a section, or replaces the one with the same key (its kind mappings stay). */
  addSection(section: DigestSection): void;
  /** Scheduler task: builds and sends every digest that is due at `now`. */
  runDue(now: Date): Promise<void>;
  /** The text that would be sent now (null = nothing to say). Writes nothing. */
  preview(agentId: string): Promise<string | null>;
}
