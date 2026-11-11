import type { Logger } from 'pino';
import type { ApprovalService } from '../approvals/types.js';
import type { Clock } from '../clock.js';
import type { ActionLog } from '../core/actionLog.js';
import type { FlagService } from '../core/flags.js';
import type { JobQueue } from '../core/jobs.js';
import type { OutboundGateway } from '../core/outbound.js';
import type { Repos } from '../core/repos/index.js';
import type { Db } from '../db/db.js';
import type { CalendarProvider } from '../google/types.js';
import { ToolError } from '../llm/tools.js';

/** What the Brain side of a2a uses (releases, outcomes, notices). The Envoy gets a narrower set (envoy.ts). */
export interface A2ADeps {
  db: Db;
  clock: Clock;
  jobs: JobQueue;
  actionLog: ActionLog;
  flags: FlagService;
  repos: Repos;
  gateway: OutboundGateway;
  approvals: ApprovalService;
  /** Read-only here: calendar writes happen only in CalendarWriter (I6). */
  calendar: Pick<CalendarProvider, 'freeBusy' | 'listEvents'>;
  log: Logger;
}

/**
 * A refused call, with a short reason the model may read. `limit` set → logged as
 * `a2a.limit` (I12), otherwise as `a2a.tool_denied`.
 */
export class Refusal extends ToolError {
  constructor(
    readonly reason: string,
    message: string,
    readonly limit = false,
  ) {
    super(message);
  }
}

export const isRefusal = (err: unknown): err is Refusal => err instanceof Refusal;
