import type { ApprovalService } from '../../approvals/types.js';
import type { Clock } from '../../clock.js';
import type { ActionLog } from '../../core/actionLog.js';
import type { FlagService } from '../../core/flags.js';
import type { Repos } from '../../core/repos/index.js';
import type { Db } from '../../db/db.js';
import type { CalendarProvider, GmailProvider } from '../../google/types.js';
import { ToolError } from '../../llm/tools.js';
import { parseInstant } from '../time.js';

/** What the Brain's tools may use. Nothing here can message anyone: tools never send. */
export interface BrainToolDeps {
  db: Db;
  clock: Clock;
  repos: Repos;
  /** Read-only: calendar writes happen only in CalendarWriter (I6). */
  calendar: Pick<CalendarProvider, 'freeBusy' | 'listEvents'>;
  gmail: GmailProvider;
  approvals: ApprovalService;
  flags: FlagService;
  actionLog: ActionLog;
}

export const MAX_RANGE_DAYS = 31;

/** A validated [from, to) range of at most 31 days. */
export function range(from: string, to: string): { from: Date; to: Date } {
  const a = parseInstant(from);
  const b = parseInstant(to);
  if (b.getTime() <= a.getTime()) throw new ToolError('"to" must be after "from".');
  if (b.getTime() - a.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new ToolError(`The range can be at most ${MAX_RANGE_DAYS} days.`);
  return { from: a, to: b };
}

/** Escapes a user string for use inside an ILIKE pattern. */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** One line: newlines and control characters become spaces. */
export function line(s: string, n: number): string {
  return cap(s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim(), n);
}
