# Violet — architecture (v1)

Each person gets a personal AI agent called **Violet**, reachable at its own chat
address. Owners text their agent. Agents talk to each other to sort things out.
Humans approve every outcome.

This document is the build contract. Code and tests refer to the invariant IDs
(`I1`…`I18`) below. If the code and this document disagree, fix one of them in
the same commit.

---

## 1. Decisions already made

| Topic | Decision |
|---|---|
| Transport | **Telegram Bot API** (one bot per agent). WhatsApp is blocked for this use: Meta's WhatsApp Business Solution Terms bar general-purpose AI assistants as a number's primary function (in force since 15 Jan 2026 outside the EEA/Italy/Brazil). Twilio WhatsApp inherits the same terms. The transport is an interface, so WhatsApp can be added later. |
| Agent-to-agent | **Open conversation** between LLMs, not a fixed times-only protocol. Safety comes from structure (section 2), not from restricting topics. |
| Strangers | Fixed canned reply. No model call. |
| Stack | TypeScript (strict, ESM), Node 22, Postgres 16, Fastify, Claude API. Deploy target Fly. |
| Model | `VIOLET_MODEL`, default `claude-opus-5-5`. |

## 2. Principles

1. **Rules live in code, not in the prompt.** Every rule in the spec is enforced
   by a code path that holds even if the model is fully compromised. Prompts are
   a second layer, never the only one.
2. **Open mouth, closed vault.** Each agent has two minds:
   - **Brain** — serves the owner thread. Full access (calendar, Gmail, notes,
     history). Takes instructions only from the owner.
   - **Envoy** — talks to other agents. It knows only (a) the *brief* its owner
     released for this conversation, (b) its owner's free/busy inside the
     conversation's time window, (c) the conversation transcript. It has no
     tool, no context and no code path that reaches event details, email,
     notes or the owner thread. Whatever a hostile agent talks it into, there
     is nothing in the vault to spill.
3. **Untrusted text is data.** Anything not typed by the owner in the owner
   thread (strangers, other agents, email bodies, calendar invites) is wrapped
   and labelled before any model sees it, and never reaches a model as an
   instruction turn.
4. **One door out.** Every outbound message goes through `OutboundGateway`.
   Pause, logging and "who may receive what" are enforced there.
5. **Humans approve outcomes.** Approval text is rendered by code from
   structured data. Only a real inbound owner message can resolve an approval.
6. **Everything is logged.** `action_log` is append-only.

## 3. Hard invariants

| ID | Invariant |
|---|---|
| I1 | Owner identity = exact match of `(transport, fromAddress)` with the agent's `owner_address`. Nothing in message content can grant owner authority. |
| I2 | Only owner-thread inbound messages become instruction (`user`) turns for the Brain. |
| I3 | A non-owner sender never triggers a model call. They get one canned reply (rate-limited) that says it is an AI, takes the message, and reveals nothing — not even the owner's name. |
| I4 | `OutboundGateway` exposes exactly two ways out: `sendToOwner(agentId, text, …)` and `sendCanned(agentId, contactId, cannedKey)`. There is no API that sends free text to a non-owner. |
| I5 | The model cannot approve. Approvals are resolved only by the deterministic resolver acting on an inbound owner-thread message (typed yes/no or a button press). No tool resolves approvals. |
| I6 | Calendar writes happen only inside `CalendarWriter`, which loads the approval from the DB, requires status `approved`, and builds the event from the **stored approval payload**, never from caller arguments. |
| I7 | An agent-to-agent outcome is booked only when **both** owners' approvals for that exact proposal are `approved`. Free/busy is re-checked right before booking. |
| I8 | No code path sends email. `GmailProvider` has no send method. The real Gmail HTTP client allow-lists method+path and rejects anything else (in particular `messages/send` and `drafts/send`). |
| I9 | The Envoy's tool set is exactly: `check_availability`, `say`, `propose`, `accept`, `decline`, `ask_owner`, `end_conversation`. Its context is built only from a2a tables. Unknown tool names are rejected. |
| I10 | `check_availability` returns busy intervals only (start/end). It is limited to the conversation's window (≤ 7 days for a window declared by the peer, ≤ 31 days for one set by the own owner), and to a per-side call budget. No window → no availability access. |
| I11 | Everything the Brain releases to another agent (brief, later guidance) passes `EgressGuard` (blocks private calendar phrases the owner did not use themselves) and the **taint rule**: if the Brain read untrusted content in the same turn, the release is held for a yes/no from the owner showing the exact text. The owner is always shown, in code-rendered text, exactly what was released. |
| I12 | Peer agents must be in the same household. Limits per pair: open conversations ≤ 3, new conversations per day ≤ 10, messages per side per conversation ≤ 12, `ask_owner` per side per conversation ≤ 2. |
| I13 | Text authored by another agent or a stranger is sanitized (control chars and newlines stripped, length capped) and quoted before it is shown to an owner. It can never forge a second line or an approval prompt. |
| I14 | Paused agent: the gateway refuses every send except the single pause/resume ack. The router stores inbound (and, for strangers, raises the `message_taken` digest flag, which sends nothing) and does nothing else; a message once held stays held on every retry of its job, even after a resume. The scheduler skips the agent. The Envoy does not run. |
| I15 | Every inbound, outbound, suppressed send, model turn, tool call, denied tool call, approval change, calendar write, draft, a2a message, flag, digest, pause/resume and pairing writes an `action_log` row. A DB trigger blocks UPDATE/DELETE/TRUNCATE on `action_log`. |
| I16 | Secrets come from env vars only. Google refresh tokens are encrypted at rest (AES-256-GCM, key from env). Nothing secret is logged. |
| I17 | Immediate texts to an owner are only: replies to their own message, approval prompts, Envoy questions, and urgent flags. Urgent non-approval flags are budgeted (≤ 3 per local day) and respect quiet hours (22:00–07:00 owner time). Everything else waits for the digest. |
| I18 | Webhooks are authenticated (Telegram secret token, constant-time compare) and idempotent (unique transport message id). |

## 4. Stack and conventions

- Node 22, TypeScript `strict`, ESM (`"type": "module"`), `tsx` for dev, `tsc` build to `dist/`.
- Runtime deps: `fastify`, `pg`, `@electric-sql/pglite`, `zod`, `luxon`, `@anthropic-ai/sdk`, `pino`. Keep the list short; justify anything else.
- No ORM. SQL lives in repo modules. Migrations are plain `.sql` files run in order.
- **Db adapter**: one interface, two drivers. `PgDb` (node-postgres) for real Postgres. `PgliteDb` (Postgres compiled to WASM, in-process) for zero-setup tests, the demo, and local dev when `DATABASE_URL` is unset. Driver differences are hidden in the adapter: never read `bigint` columns raw (cast `::int` / `::text` in SQL), always `count(*)::int`.
- IDs: `crypto.randomUUID()` stored as `text`. Times: `timestamptz`. No `Date.now()` in app code — everything takes a `Clock`.
- Tests: `vitest`. Default driver PGlite in-memory. If `TEST_DATABASE_URL` is set, each test world creates and drops its own schema in real Postgres. Both must pass.
- Scripts: `npm run build` (tsc to `dist/`, copies the `.sql` migrations), `npm run typecheck`, `npm test`, `npm run test:pg`, `npm run migrate`, `npm run dev`, `npm run demo`, `npm run owner:add`, `npm run google:link`. The CLIs also run from the build with no dev dependency: `npm run migrate:prod`, `owner:add:prod`, `google:link:prod` (`node dist/cli/<name>.js`).
- Test personas are **Alex** and **Sam**. No real names, numbers, emails or keys anywhere in the repo.
- `.gitignore`: `node_modules`, `dist`, `.env*` (except `.env.example`), `.data`, `.worktrees`.

## 5. Layout

```
src/
  config.ts            env parsing (zod)
  clock.ts             Clock, SystemClock, FakeClock
  app.ts               buildApp(deps, modules) — composition root
  deps.ts              production wiring of providers (clock, transport, llm, google, logger)
  modules.ts           defaultModules list (one line per milestone)
  server.ts            Fastify: /healthz, webhooks, oauth, dev endpoints
  db/                  db.ts (Db, PgDb, PgliteDb), open.ts, migrate.ts, migrations/*.sql
  core/                types.ts, repos/*, router.ts, outbound.ts, jobs.ts, jobContext.ts,
                       scheduler.ts, actionLog.ts, flags.ts, setup.ts, pairing.ts, canned.ts, sanitize.ts,
                       later.ts (placeholder interfaces for services later milestones install)
  transport/           types.ts, fake.ts, telegram/*
  llm/                 types.ts (LlmClient), anthropic.ts, scripted.ts, toolLoop.ts
  brain/               brain.ts, prompt.ts, tools/*, untrusted.ts
  approvals/           module.ts, service.ts, resolver.ts, calendarWriter.ts, calendarEvent.ts, repo.ts, line.ts, types.ts
  google/              types.ts, fake.ts, oauth.ts, routes.ts, http.ts, allowlist.ts, errors.ts, api.ts, services.ts,
                       calendar.ts, gmail.ts, mime.ts, draft.ts, time.ts, tokens.ts, crypto.ts, scopes.ts
  a2a/                 types.ts, service.ts, envoy.ts, envoyTools.ts, egress.ts, outcome.ts, render.ts
  flags/               module.ts, policy.ts, digest.ts, digestStore.ts, render.ts, conflicts.ts, time.ts, types.ts
  cli/                 migrate.ts, ownerAdd.ts, googleLink.ts, demo.ts, chat.ts
test/
  helpers/world.ts     createTestWorld()
  unit/ … e2e/         e2e/simulation.test.ts, e2e/privacy.test.ts, e2e/injection.test.ts
```

## 6. Data model

Migration files are pre-assigned so parallel milestones never collide.

**001_core.sql (M1)**

`messages`, `jobs`, `flags` and `contact_notes` also have `seq bigserial unique`: a stable order for
rows written at the same clock instant (the FakeClock makes that common). Order by `seq`; never read it raw.
- `households(id, name, created_at)`
- `owners(id, household_id, name, timezone, digest_hour default 18, created_at)`
- `agents(id, owner_id unique, name default 'Violet', transport, agent_address, owner_address null, pairing_code_hash null, pairing_expires_at null, paused bool, paused_at null, created_at, unique(transport, agent_address))`
- `contacts(id, agent_id, transport, address, display_name null, kind 'owner'|'stranger', first_seen_at, last_seen_at, last_canned_reply_at null, unique(agent_id, transport, address))`
- `contact_notes(id, agent_id, contact_id null, subject null, body, created_at)`
- `messages(id, agent_id, thread 'owner'|'contact', contact_id null, direction 'in'|'out', body, purpose null, transport_message_id null, reply_to_transport_message_id null, meta jsonb, created_at)`
- `inbound_events(id, transport, transport_message_id, agent_address, payload jsonb, received_at, processed_at null, progress jsonb default '{}', unique(transport, transport_message_id))`; M2 (002) adds `arrival_seq bigserial` (arrival order at ingest, used by the approval resolver) — `progress` maps each routing step already done to its result, so a retried `inbound.process` job resumes instead of redoing side effects.
- `jobs(id, type, lane null, payload jsonb, status 'queued'|'running'|'done'|'failed'|'dead', attempts, max_attempts, run_at, locked_at null, last_error null, dedupe_key unique null, created_at, finished_at null)` — `failed` = waiting for a retry at `run_at`; `dead` = out of attempts. A partial unique index on `lane where status = 'running'` makes "one running job per lane" a database rule. `dedupe_key` is unique for the table's lifetime (an idempotency key, not "one active job"). A lane runs in order: a job is claimable only while **no older unfinished job of its lane** exists — `queued` and due, `failed` (waiting for a retry) or `running` — whatever row locks other workers hold (a head job another worker has locked but not yet marked running still holds the lane). A `queued` job scheduled for later takes its place in the lane when it becomes due. **Visibility timeout:** every pump first recovers jobs still `running` after `staleMs` (default 10 min, measured on the `Clock` from `locked_at`): one that used its last attempt becomes `dead` (+ `job.dead`), any other is requeued as `failed`, due now. So a crashed worker or a finish that could not be written never wedges a lane, and handlers run **at least once**. An attempt's outcome is written only if the row still carries that attempt number, so a late finish from a lost worker is a no-op. `job.dead` rows carry `agent_id` when the lane is an agent id. A handler error with `permanent: true` (e.g. `PermanentTransportError`) makes the job `dead` at once; one with `retryAfterMs` is not retried before that delay.
- `flags(id, agent_id, kind, urgency 'now'|'digest', text, dedupe_key null, status 'pending'|'sent'|'suppressed', created_at, delivered_at null, digest_date null, unique(agent_id, dedupe_key))`
- `scheduler_state(name, scope, last_run_at, primary key(name, scope))`
- `action_log(id bigserial, at, agent_id null, actor, action, detail jsonb)` + append-only trigger
- `schema_migrations(version, applied_at)` — `migrate()` is safe to run from several processes at once (every instance migrates at boot): each script takes a transaction-level advisory lock on the schema and inserts its version row first, so the loser of a race rolls back and skips.

**002_approvals.sql (M2)**
- `approvals(id, agent_id, ref int, kind, payload jsonb, prompt, status 'pending'|'approved'|'denied'|'expired'|'cancelled'|'executed'|'failed', group_id null, prompt_transport_message_id null, prompt_sending_until null, idempotency_key null, created_at, expires_at, resolved_at null, resolved_by_message_id null, executed_at null, error null, unique(agent_id, ref), unique(agent_id, idempotency_key))` — `prompt_transport_message_id` null = prompt not delivered yet (paused or send failed).
- `approval_refs(agent_id pk, last_ref)` — per-agent ref counter, bumped by one upsert in the insert transaction.
- `calendar_writes(id, owner_id, approval_id, event_id, idempotency_key unique, created_at, deleted_at null)` — `deleted_at` set by `CalendarWriter.undo`.
- `brain_turns(message_id pk, agent_id, status 'running'|'done', outcome null, created_at, finished_at null)` and `brain_tool_memo(message_id, tool, input_hash, occurrence, result, created_at, pk(message_id, tool, input_hash, occurrence))` — Brain turn idempotency (8.2).

**003_google.sql (M3)**
- `google_accounts(owner_id pk, email null, refresh_token_enc, scopes, connected_at, revoked_at null)` — `email` is null when Gmail read was not granted; `scopes` = space-separated scopes Google actually granted; `refresh_token_enc` = `v1.<iv>.<ciphertext>.<tag>` (AES-256-GCM, owner id as associated data).
- `oauth_states(state pk, owner_id, created_at, expires_at, used_at null)` — `state` holds the sha256 hex of the state value (never the value); `used_at` makes it single use (consumed by one atomic `UPDATE … RETURNING`).

**004_a2a.sql (M4)**
- `a2a_conversations(id, initiator_agent_id, responder_agent_id, topic, status, window_start null, window_end null, created_at, updated_at, closed_at null, close_reason null)`
- `a2a_sides(conversation_id, agent_id, brief, owner_notes jsonb, cleared_text, availability_calls int, messages_sent int, owner_questions int, awaiting_owner bool, primary key(conversation_id, agent_id))`
- `a2a_messages(id, conversation_id, seq int, from_agent_id null, kind 'open'|'text'|'proposal'|'accept'|'decline'|'system'|'close', body, payload jsonb, created_at, unique(conversation_id, seq))`

**005_flags.sql (M5)**
- `flags` gains `held_until null` (held for quiet hours), `budget_date date null` (owner-local date whose budget it uses), `attempt_at null` (send lease), `overflowed_at null` (a `now` flag turned digest item), `digest_id null` (the one digest carrying it), `retry_at null` + `send_failures` (release-task backoff after a retryable send failure). A **digest item** = `status 'pending'` and (`urgency 'digest'` or `overflowed_at` set); it becomes `sent` (+ `digest_date`) when its digest is delivered.
- `digests(id, agent_id, local_date, body null, status 'sending'|'sent'|'empty'|'rolled_over', item_count, left_out, created_at, lease_until null, sent_at null, send_failures, unique(agent_id, local_date))` — a row closes the date; `body` null = empty.

**006_transport.sql (M6)** — `telegram_state(bot_id pk, last_update_id)`

## 7. Contracts

These are the starting contracts. M1 creates them as real `.ts` files. A later
milestone may change one if it must — keep the change minimal and report it.

```ts
// src/db/db.ts
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;   // multi-statement script, no params (migrations; runs atomically)
  close(): Promise<void>;
}

// src/clock.ts
export interface Clock { now(): Date }

// src/transport/types.ts
export type TransportName = 'fake' | 'telegram';
export interface InboundMessage {
  transport: TransportName;
  agentAddress: string;              // which agent endpoint received it
  fromAddress: string;               // sender's stable id on this transport
  fromName?: string;                 // display name — untrusted
  kind: 'text' | 'button' | 'unsupported';
  text: string;                      // '' when unsupported
  buttonPayload?: string;            // e.g. "approve:<approvalId>"
  transportMessageId: string;        // unique per transport — idempotency key
  replyToTransportMessageId?: string;
  receivedAt: Date;
}
export type OutboundPurpose = 'reply' | 'approval' | 'question' | 'flag' | 'digest' | 'ack' | 'canned' | 'transcript';
export interface OutboundMessage {
  agentAddress: string;
  toAddress: string;
  text: string;
  buttons?: { id: string; label: string }[];
  purpose: OutboundPurpose;
}
export interface Transport {
  readonly name: TransportName;
  send(msg: OutboundMessage): Promise<{ transportMessageId: string }>;
}
// send() failures: TransportError { permanent, reason, retryAfterMs? }, subclassed as
// PermanentTransportError (retrying cannot help) and RetryableTransportError.

// src/core/outbound.ts
export interface OutboundGateway {
  /** Returns null when suppressed (paused). */
  sendToOwner(agentId: string, text: string, opts: { purpose: Exclude<OutboundPurpose, 'canned'>; buttons?: { id: string; label: string }[] }): Promise<{ messageId: string; transportMessageId: string } | null>;
  sendCanned(agentId: string, contactId: string, key: CannedKey): Promise<void>;
}
// createOutbound() also returns a ControlChannel { sendPauseAck } that only the router
// receives: the single pause/resume ack (I14) is not reachable through the gateway.

// src/llm/types.ts — mirrors the Anthropic Messages API shape
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };          // thinking etc. — pass back verbatim
export interface LlmMessage { role: 'user' | 'assistant'; content: string | LlmBlock[] }
export interface LlmTool { name: string; description: string; input_schema: Record<string, unknown> }
export interface LlmRequest {
  system: string;                    // stable: cached (prompt caching), byte-identical across turns
  systemDynamic?: string;            // volatile (time, pending items): sent after the cache breakpoint
  messages: LlmMessage[]; tools: LlmTool[]; maxTokens: number;
  /** Not sent to the API. Used for logging and for scripting tests. */
  meta: { agentId: string; mind: 'brain' | 'envoy'; conversationId?: string };
}
export interface LlmUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export interface LlmResponse { content: LlmBlock[]; stopReason: string; usage?: LlmUsage }
export interface LlmClient { complete(req: LlmRequest): Promise<LlmResponse> }
// src/llm/errors.ts — every client failure is an LlmError { code, retryable }; UnconfiguredLlm
// (no ANTHROPIC_API_KEY) throws code 'unconfigured', retryable false.
// src/llm/anthropic.ts — AnthropicLlm: Messages API (beta endpoint, server-side refusal fallback
// `fallbacks: 'default'`), model per mind (VIOLET_MODEL / VIOLET_ENVOY_MODEL), effort 'medium',
// thinking left at the model default; cache breakpoints on the last tool and the stable system
// block, automatic caching for the message prefix. 429/529/5xx/408/409/network → retryable.

// src/llm/tools.ts + toolLoop.ts — shared by Brain and Envoy
export interface ToolDef<C, I> { name; description; input: ZodType<I>; taints?: boolean; sideEffect?: boolean; handler(input: I, ctx: C): Promise<string> }
export class ToolRegistry<C> { register(def); get(name); names(); llmTools() }   // registration order = API order
runToolLoop({ llm, system, systemDynamic?, messages, tools, execute(tool, input, call), onDenied?(call, reason), maxSteps, maxTokens, meta })
  → { finalText, messages, steps, stopReason: 'end_turn'|'max_tokens'|'refusal'|'max_steps'|…, usage, toolNames }
// One step = one model call. Every tool_use gets one tool_result (all in one user message).
// Unknown name / zod-invalid input → is_error result + onDenied ('unknown_tool'|'invalid_input').
// Handler error → is_error with err.ownerMessage (string) or a generic text — never internals.
// max_tokens: tools in that response never run. pause_turn: call again. Assistant content verbatim.

// src/google/types.ts
export interface BusyInterval { start: Date; end: Date }
export interface CalendarEvent { id: string; title: string; start: Date; end: Date; allDay?: boolean; location?: string; description?: string; attendees?: string[] }
export interface NewCalendarEvent { title: string; start: Date; end: Date; location?: string; description?: string }
export interface CalendarProvider {
  freeBusy(ownerId: string, from: Date, to: Date): Promise<BusyInterval[]>;
  listEvents(ownerId: string, from: Date, to: Date): Promise<CalendarEvent[]>;
  createEvent(ownerId: string, ev: NewCalendarEvent, idempotencyKey: string): Promise<{ eventId: string }>;
  deleteEvent(ownerId: string, eventId: string): Promise<void>;   // compensation only, CalendarWriter only
}
export interface EmailSummary { id: string; threadId: string; from: string; to: string; subject: string; snippet: string; date: Date }
export interface EmailFull extends EmailSummary { bodyText: string }
export interface NewDraft { to: string[]; subject: string; body: string; replyToMessageId?: string }
export interface GmailProvider {
  search(ownerId: string, query: string, max: number): Promise<EmailSummary[]>;
  getMessage(ownerId: string, id: string): Promise<EmailFull>;
  createDraft(ownerId: string, draft: NewDraft): Promise<{ draftId: string }>;
  // No send. Ever. (I8)
}

// src/core/flags.ts
export interface FlagService {
  raise(agentId: string, f: { kind: string; urgency: 'now' | 'digest'; text: string; dedupeKey?: string }): Promise<void>;
}
// app.flags is a FlagHub = FlagService + setNowDelivery(fn): the hook M5 uses to install the I17 policy.

// src/core/later.ts re-exports DigestService from src/flags/types.ts (M5): registerKind, addSection, runDue, preview.

// src/core/jobs.ts — DB-backed queue; one running job per lane (lane = agent id)
export interface JobQueue {
  register(type: string, handler: (payload: any) => Promise<void>): void;
  enqueue(type: string, payload: unknown, opts?: { lane?: string; runAt?: Date; dedupeKey?: string; tx?: Queryable }): Promise<void>; // tx: commit with the caller's transaction
  pump(): Promise<number>;           // recover stale running jobs, then run all runnable ones; returns how many ran
  start(): void; stop(): Promise<void>;   // stop: finish the job in flight, claim no more (backlog stays queued)
}
// Each handler runs inside runInJob(job.id, …) (src/core/jobContext.ts); currentJobId()
// tells code below it which job (and so which retry) it belongs to.

// src/core/scheduler.ts
export interface Scheduler {
  register(name: string, everyMs: number, fn: (now: Date) => Promise<void>): void;
  /** Once per active agent (scheduler_state.scope = agent id); paused agents are skipped (I14). */
  registerPerAgent(name: string, everyMs: number, fn: (agentId: string, now: Date) => Promise<void>): void;
  runDue(): Promise<void>;
}

// src/core/actionLog.ts
export interface ActionLog {
  write(entry: { agentId?: string | null; actor: Actor; action: string; detail?: Record<string, unknown> }, q?: Queryable): Promise<void>;
  list(filter?: { action?: string; agentId?: string }): Promise<ActionRow[]>;
}

// src/app.ts
export interface AppDeps { db: Db; clock: Clock; transport: Transport; llm: LlmClient; calendar: CalendarProvider; gmail: GmailProvider; config: Config; log: Logger }
export interface Module { name: string; install(app: App): void | Promise<void> }
export interface App {
  deps: AppDeps;
  repos: Repos; actionLog: ActionLog; gateway: OutboundGateway; jobs: JobQueue; scheduler: Scheduler; flags: FlagHub; router: Router;
  ingest(msg: InboundMessage): Promise<void>;     // persist + enqueue, fast
  settle(): Promise<void>;                        // pump until idle (tests, demo)
  start(): Promise<void>; stop(): Promise<void>;
  // installed by later modules:
  approvals?: ApprovalService; brain?: Brain; a2a?: A2AService; digest?: DigestService;
}
export interface Brain { readonly tools: ToolRegistry<BrainToolCtx>; handle(ctx: OwnerMessageCtx): Promise<void> }
export interface BrainToolCtx { agent; owner; turn: { messageId: string; ownerText: string; tainted: boolean }; now: Date; callKey: string }
```

### Google (M3)

- `src/google/http.ts` is the only code that calls Google. The allow-list (`allowlist.ts`, I8) is checked on the parsed URL before `fetch`: exact host, exact path segments (raw path must be in normal form: no `%`, `\`, dot or empty segments), ids `[A-Za-z0-9_-]`, and a per-route list of query keys (`sendUpdates` is pinned to `none`, every value). Providers `encodeURIComponent` ids in paths, so a hostile id is denied by the allow-list rather than reshaping the URL. Allowed: `POST oauth2…/token`, `POST calendar/v3/freeBusy`, `GET|POST calendar/v3/calendars/primary/events`, `DELETE …/events/{id}`, `GET gmail/v1/users/me/{profile, messages, messages/{id}, threads/{id}}`, `POST …/me/drafts`. A denied call throws `GoogleDeniedError` and writes `google.denied` (best effort, never masking the denial; control characters and lone surrogates in the logged URL are escaped so jsonb accepts it). No retries in the client (the job queue retries); one bounded re-try after a 401 with a fresh token.
- Typed errors (`errors.ts`), each with a short owner-safe `safeMessage`: `GoogleDeniedError`, `GoogleNotConnectedError`, `GoogleAuthError` (401, `invalid_grant`, revoked), `GoogleScopeMissingError` (with `capability`), `GoogleNotFoundError`, `GoogleConflictError`, `GoogleRateLimitedError` (`retryAfterSec`), `GoogleTransientError`, `GoogleInvalidInputError`, `GoogleRequestError`. `retryable` is true for rate-limited and transient.
- Capabilities come from the **granted** scopes: `calendarFreeBusy`, `calendarRead`, `calendarWrite`, `gmailRead`, `gmailDraft`. A call without its capability throws `GoogleScopeMissingError` before any network call. Default scopes: `calendar.freebusy`, `calendar.events.owned`, `gmail.readonly`, `gmail.drafts.create` (`GOOGLE_SCOPES` overrides).
- `invalid_grant` on refresh → `revoked_at` set, `google.revoked` logged, one `now` flag `Google access expired — reconnect needed.` (dedupe key per connection), `GoogleAuthError`. A refresh token that fails to decrypt (wrong/rotated `TOKEN_ENC_KEY`, corrupt row) → `GoogleAuthError` reason `undecryptable`, one `now` flag of kind `google.undecryptable` (same text, dedupe per connection), the account is **not** marked revoked (restoring the key recovers it). `googleModule` (in `defaultModules`) binds `app.flags` for this.
- Connect: `oauth.createConnectLink(ownerId)` (CLI `npm run google:link -- --owner <id>`) → `GET /oauth/google/start?state=…` → Google consent → `GET /oauth/google/callback` → `google.connected` (or `google.connect_failed {reason}`). Routes exist only when Google is configured. `createDeps` uses the real providers when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and `TOKEN_ENC_KEY` are all set, else the fakes; `googleOf(deps)` returns the services behind real providers.
- Calendar: `createEvent` uses event id = lowercase base32hex(sha256(idempotencyKey)) and `sendUpdates=none`; HTTP 409 returns the same id. `deleteEvent` treats 404/410 as done. `listEvents` skips cancelled events and reads at most 20 pages of 250; more pages left at that point is a `GoogleRequestError`, never a partial list; all-day dates start at the first instant of that date in the calendar's zone (midnight, or the DST transition where midnight is skipped; end exclusive), `allDay: true`. Floating wall times inside a DST gap resolve forward (pre-transition offset), overlaps take the earlier instant.
- Gmail: `search` caps at 25 messages; bodies prefer `text/plain`, fall back to stripped HTML, capped at 20,000 chars. Sender-controlled input is bounded: each part's base64 is cut before decoding, the MIME tree is walked iteratively (depth ≤ 50, ≤ 500 parts, the rest ignored), HTML is cut at 80,000 chars and stripped in one linear scan (no backtracking regex; an unclosed tag, comment or script runs to the end and is dropped). Drafts are hand-built RFC 2822 (base64 UTF-8 body, RFC 2047 subject); recipients must be bare addresses within RFC 5321 limits (address ≤ 254, domain ≤ 253 chars) and the subject has no control characters (`GoogleInvalidInputError`). Replies set `threadId`, `In-Reply-To`, `References` (the first id plus the last 10). `To` and `References` are folded (CRLF + space) so no line exceeds ~78 chars (RFC 5322 limit 998). No send anywhere; a test scans `src/` for send endpoints.

### Router hooks (M1 defines, later milestones fill)

```ts
export interface RouterHooks {
  /** Deterministic pre-brain handlers, tried in order. Return true if handled. */
  ownerInterceptors: Array<(ctx: OwnerMessageCtx) => Promise<boolean>>;   // M2 adds the approval resolver
  /** The Brain. M1 default: replies "I'm not fully set up yet." */
  onOwnerMessage: (ctx: OwnerMessageCtx) => Promise<void>;
  onPause: Array<(agentId: string) => Promise<void>>;
  onResume: Array<(agentId: string) => Promise<void>>;                    // M4 re-queues waiting Envoy turns
}
```

Routing is resumable (I18): each step of flow 8.1 (route decision, stored message +
`inbound.received`, pause state, ack, canned reply, flag, hooks) is recorded in
`inbound_events.progress`, and a retried job skips the steps already done. DB-only
steps commit with their record in one transaction (exactly once). Steps that send or
call hooks are recorded after they succeed, so **hooks run at least once per
`messageId`**: a hook with side effects keys them on `ctx.messageId`.

### Test world (M1 creates, everyone uses)

```ts
const w = await createTestWorld();
w.alex, w.sam            // { owner, agent, address, agentAddress }
await w.ownerSays(w.alex, 'pause');             // ingest + settle
await w.strangerSays(w.alex, '+15550001', 'hi');
w.textsTo(w.alex.address)                       // string[] in order
w.lastTo(w.alex.address)
await w.advance({ hours: 3 });                  // clock + scheduler.runDue + settle
await w.actions({ action: 'outbound.sent' });
w.llm.calls                                     // every LlmRequest ever made (vault assertions)
w.llm.on({ agentId, mind: 'brain' }, (req, n) => response);
await w.close();
```

### Dev endpoints

`/dev/inbound` (speaks as any sender, owners included) and `/dev/outbox` exist only with
`TRANSPORT=fake`, `NODE_ENV` not `production`, **and** `ADMIN_TOKEN` set. Every call
needs `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare); otherwise 401.
Without `ADMIN_TOKEN` the routes are not registered (I1).

### Telegram transport (M6)

- One bot per agent. `agent_address` = bot id (the digits before `:` in the token); owner address = Telegram user id. Tokens come from `TELEGRAM_BOT_TOKENS` (comma-separated, format-checked, no duplicates).
- Ids: inbound `transportMessageId` = `<bot id>:<update id>` (I18). Outbound ids and `replyToTransportMessageId` (a reply, or the message carrying a pressed button) = `<chat id>:<message id>`.
- Inbound: private chats only. Text → `text`; other messages → `unsupported`, and so is text the sender did not type (a forward: `forward_origin`/`forward_from`/`forward_from_chat`/`forward_sender_name`/`forward_date`, or `via_bot` output), so it never reads as the owner's words (principle 3, I5); `callback_query` → `button` (`buttonPayload` = callback data, `text` '', sender = the presser). Edits, channel posts, bot senders, other updates → ignored. Group/supergroup/channel → ignored and the bot leaves the chat. Untrusted strings (text, names, callback data) drop U+0000 and replace lone surrogates with U+FFFD, which Postgres `jsonb` rejects, so no update is unstorable (a webhook 500 on every redelivery, a stuck poll offset). Every ignored update is logged as `inbound.dropped` (`transport`, `botId`, `updateId`, `reason`) and a left chat as `telegram.chat_left` (I15).
- Outbound: plain text (no `parse_mode`), link previews off, split at 4096 UTF-16 units on paragraph/line/space boundaries; buttons = one inline-keyboard row on the last chunk, `callback_data` = button id (≤ 64 bytes, else a permanent error). A retryable failure after some chunks went out is remembered in process (6 h on the app `Clock`), keyed by the running job's id (`core/jobContext.ts`: the job queue runs each handler inside `runInJob(job.id, …)`) and the message, so only that job's retry resumes with the first undelivered chunk; a new job, or a send outside any job, always sends the whole message.
- Errors: 400/401/403/404 → permanent; 429 (with `retry_after` → `retryAfterMs`), 5xx, network → retryable. The token is in the request URL, so errors are built from the method name and Telegram's `error_code`/`description` only; URLs and fetch errors are never logged.
- Webhook mode: `POST /webhooks/telegram/:botId`, `X-Telegram-Bot-Api-Secret-Token` checked against `TELEGRAM_WEBHOOK_SECRET` (constant time) before the body is parsed → 401; unknown bot → 404; malformed body → 400; else ingest → 200. Error bodies are `{"ok":false}`. At boot, with `PUBLIC_BASE_URL`, `setWebhook` per bot (secret token, `allowed_updates` = message, callback_query).
- Polling mode (`TELEGRAM_MODE=polling`, local dev): per bot, `deleteWebhook` once, then long-poll `getUpdates`; the offset (`telegram_state`, with the time of the last ingested update) advances only after an update is ingested. An offset over 6 days old is not sent (Telegram may restart update ids at a random lower value after a week without updates); the stored id then follows the new ids down, and redeliveries are deduplicated by ingest.
- `owner:add --transport telegram [--bot-username <name>]` prints the exact `/start <code>` text and a `t.me/<bot>?start=<code>` link.

### Deploy (ops)

- `Dockerfile` (Node 22 slim, multi-stage, prod deps only, user `node`, `CMD ["node","dist/main.js"]`), `fly.toml`, `docker-compose.yml` (`--profile app`: the image on the fake transport), `docs/DEPLOY.md`.
- Exactly **one** process/machine: `scheduler.runDue` has no cross-process claim (read state, run, write `last_run_at`), so two machines run every task twice. The job queue, webhook ingest and `migrate()` are multi-process safe.
- Migrations run at boot in `main.ts`; production needs `DATABASE_URL`: `openDb` (`src/db/open.ts`) refuses the PGlite fallback when `NODE_ENV=production`, for the server and every CLI (`DATABASE_URL is missing: ...`).
- Shutdown on SIGTERM/SIGINT: stop Telegram → close HTTP → `app.stop()` (awaits the scheduler tick in flight, then `jobs.stop()`) → close db → exit 0.

## 8. Flows

### 8.1 Inbound routing (deterministic, before any model)

1. Webhook authenticates, normalizes to `InboundMessage`, calls `app.ingest` → insert `inbound_events` (dedupe) + enqueue `inbound.process` on lane = agent, in one transaction (a failed enqueue rolls back the insert, so a redelivery is not mistaken for a duplicate) → return 200. **Pause is immediate:** if the sender is the owner (I1) and the text is exactly `pause` / `resume` (rule of step 4), the same transaction locks the agent row (`SELECT … FOR UPDATE`, also when the command changes nothing), flips `agents.paused` if it differs, writes `agent.paused` / `agent.resumed` and records the `pause.state` step in `progress`. Because every pause/resume command serializes on that row lock, concurrent commands enqueue their jobs in flip order and the last ack always matches the final state. Any other message that arrives while the agent is paused gets the `paused_at_arrival` step recorded. A redelivery inserts nothing, so it flips nothing.
2. Unknown `agentAddress` → log, drop.
3. Pairing: if the agent has no `owner_address` and the text is `/start <code>` matching the unexpired pairing code → bind owner, ack. A wrong or missing code is treated like any stranger.
4. Sender is owner (I1):
   - `pause` / `resume` (exact, case-insensitive, optional leading `/`) → store the message, send the single ack (internal ack path), run `onPause` / `onResume`, in lane order. The state was already flipped at ingest (step 1); the job reuses that recorded result and never flips or logs a second time (it flips only if the sender became the owner after ingest, by a pairing earlier in the lane). An ack that fails permanently (owner blocked the bot; logged as `outbound.failed`) does not stop the hooks.
   - Paused → store, log (`inbound.held`), stop. Held = the agent is paused at processing time **or** was paused when the message arrived (`paused_at_arrival`). This includes messages that arrived before the pause but are processed after it, retries of older jobs, and messages that arrived while paused whose job runs after a later `resume` was ingested.
   - `ownerInterceptors` (approval resolver) → handled? stop.
   - `onOwnerMessage` (the Brain).
5. Sender is not owner (I3): upsert contact, store message, log. Raise a `digest` flag (`Message from “<name>”: “<text>”`, both quoted, I13; it sends nothing). Paused (same held rule as step 4) → log `inbound.held`, raise that flag, stop: no canned reply, ever, for a held message, and the message is in the first digest after resume (8.6). Otherwise send the canned reply if none was sent to this contact in the last 12 h. The flag comes first so a canned reply that can never be delivered does not keep it back. The canned reply is **best-effort**: one attempt; every attempt leaves an outbound row (I15): a failure before or during the send is logged as `outbound.failed`, and a text that was delivered is logged as `outbound.sent` even if storing its `messages` row then fails (`recorded: false`). A failure never fails the job, retries or holds the lane.
6. Unsupported media: owner gets "I can only read text for now."; strangers get the normal canned flow.

Action names written by M1 (I15): `inbound.received`, `inbound.duplicate`, `inbound.dropped`, `inbound.held`,
`pairing.code_issued`, `pairing.bound`, `pairing.failed`, `agent.paused`, `agent.resumed`, `outbound.sent`,
`outbound.suppressed`, `outbound.failed`, `canned.rate_limited`, `flag.raised`, `job.dead`, `scheduler.failed`,
`household.created`, `owner.created`.

### 8.2 Owner turn (Brain)

System prompt (rules, owner profile, local time, pending approvals, open Envoy questions) + last 40 owner-thread messages + tool loop (≤ 10 steps). Final text → `gateway.sendToOwner(purpose 'reply')`. Tool results containing third-party text are wrapped in `<untrusted source="…">` and mark the turn **tainted**.

- Prompt: `system` = stable text (identity, owner name, rules, untrusted marking, time zone); `systemDynamic` = current local time + pending approval summaries.
- History: owner-thread rows up to and including the current message (I2: inbound = `user`, everything Violet sent = `assistant`), consecutive same-role rows merged, leading assistant rows dropped; the current message is the last user turn.
- `wrapUntrusted(source, text)` (`email|calendar|stranger|notes|agent`): NFKC + invisible (Cf) characters removed, any `<` (or bracket look-alike) that starts a tag named `untrusted` inside the content becomes `‹`; the name is matched on a confusable skeleton (default-ignorable and combining marks skipped, case and diacritics folded, Cyrillic/Greek/Armenian/small-capital look-alikes such as `е` U+0435 or `ѕ` U+0455 folded to Latin), with a bounded look-ahead so the pass stays linear. `search_history` taints (Violet's side of the owner thread can quote third parties) and wraps each of Violet's messages as `agent`. Tools with `taints: true` set `ctx.turn.tainted` when they succeed.
- Idempotent per `messageId`: `brain_turns` marks a finished turn (never re-run, never a second reply). `sideEffect` tools are memoized in `brain_tool_memo` by (message, tool, canonical-JSON input hash, occurrence) and get `ctx.callKey` as idempotency key (approvals use it as `idempotencyKey`; notes derive their id from it). Draft creation has no provider key: a crash between `createDraft` and the memo write can repeat it.
- Failures: a retryable `LlmError` (or any non-LlmError) fails the job, which retries the turn. Non-retryable → one fixed apology; `unconfigured` → a fixed "model not connected" text. Refusal, step limit and an empty `max_tokens` answer get fixed texts; an empty final text sends nothing.
- Times in tool inputs: ISO 8601 with explicit offset only; outputs in the owner's zone (`Fri Nov 13, 7:00–8:30 PM [2026-11-13T19:00:00-05:00 → …]`). Range tools take ≤ 31 days.
- Brain tools get read-only calendar access, no gateway and no transport: no tool sends email, writes the calendar, approves, pauses or messages anyone but the owner (approval prompts are sent by the approval service).
- Action names (I15): `brain.turn` (outcome, stopReason, steps, tools, tainted, usage), `tool.call` (tool, ok, memoized), `tool.denied` (tool, reason), `gmail.draft_created`, `note.saved`.

Brain tools (M2): `get_schedule`, `find_free_time`, `request_calendar_event`, `search_email`, `read_email`, `draft_email`, `remember`, `recall`, `search_history`, `list_messages_taken`, `list_pending_approvals`.
Added by M4: `talk_to_agent`, `tell_envoy`, `list_agent_conversations`, `read_agent_conversation`, `send_transcript_to_owner`, `end_agent_conversation`.

### 8.3 Approvals

- `approvals.request(agentId, { kind, payload, groupId?, expiresAt? })` → the registered kind renders a **one-line** prompt from the payload → sent at once: `#7 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.` (with yes/no buttons where the transport supports them).
- Resolver (owner interceptor): matches `yes|y|yep|yeah|ok|okay|sure|approve|do it|go ahead|👍` / `no|n|nope|nah|don't|decline|cancel|👎`, optionally followed by `#?<ref>`. Target = explicit ref (only an approval that already existed when the message was written: `created_after_message_seq` < the message's `seq` AND `created_after_arrival_seq` < the arrival seq of the message's inbound event) → else the prompt being replied to → else the only pending approval whose prompt was delivered **before** the message was written (its outbound row's `seq` < the message's `seq` AND `prompt_sent_after_arrival_seq` < the message's event arrival seq; an undelivered prompt, or one sent after the owner wrote — e.g. created by the Brain turn of that very message and found on a hook retry, or by the Brain turn of an earlier message while this one waited in the lane — is never the implicit target). Arrival order is `inbound_events.arrival_seq` (bigserial, added by 002, allocated at ingest); the owner's stored message carries `meta.inboundEventId`; the approval records the sequence's high-water mark (allocated values, so in-flight ingests count as arrived) at creation and at markSent → else ask "Which one?" with a one-line list of those. A reply-to that names no prompt of this agent never picks the implicit target: "Which one?" if any are answerable. No answerable approvals → not handled (falls through to the Brain). Button payloads `approve:<id>` / `deny:<id>` resolve directly.
- Kinds register `{ schema, render(payload, { timezone }), onApproved?, onDenied?, onExpired?, calendarEvents?(payload), booked?(payload, { timezone }), guard?(approval) }` (`src/approvals/types.ts`). M2: `calendar_event`. M4: `a2a_outcome`, `a2a_release`.
- `request(agentId, { kind, payload, groupId?, expiresAt?, idempotencyKey? })` validates with the kind's schema, stores the parsed payload, allocates the ref, and composes the prompt **by code**: `#<ref> <render(...)> Reply yes or no.` — the rendered part is sanitized (control characters and line breaks stripped), NFKC-normalized, every number sign (`#`, `＃`, `﹟`) removed, capped at 240 chars. A kind may cap the expiry with `latestExpiry(payload)` (`calendar_event`: the event's start). Buttons: `approve:<id>` / `deny:<id>`. Paused → stored unsent; `onResume` and the sweep send unsent pending prompts (after expiring what lapsed, so a stale prompt is never sent). Every send first takes an atomic claim (`prompt_sending_until`, 2 min lease), so concurrent senders deliver a prompt once. The same `idempotencyKey` returns the existing approval.
- Resolution: one `UPDATE … WHERE status = 'pending' AND expires_at > now` setting `resolved_by_message_id`; a retried hook finds its own resolution by that id and re-runs the (idempotent) callbacks. `onApproved` / `onDenied` return the one-line reply (defaults: `Okay, approved #n.` / `Okay, not doing #n.`). Not open → `#n isn't open any more.`; ambiguous → `Which one? #1 … · #2 … — reply yes 1 or no 1.` A button for an approval of another agent resolves nothing. Before targeting, the resolver expires pending approvals past `expires_at` (the sweep does not run while paused), so a late yes gets the not-open text; `listPending` likewise omits them, and `executeApproved` refuses an approval resolved after its expiry.
- `cancel(id, reason)`, `get`, `listPending`, `expireDue`, `sendUnsent`; `approvals.calendar` is the `CalendarWriter`: `executeApproved(id)` (requires `approved`, runs `guard`, books `calendarEvents(stored payload)` with keys `approval:<id>:<n>`, records `calendar_writes`, marks `executed`; an event that has already started is refused (`failed`, "the event has already started"); a failure undoes what it wrote and marks `failed` with a safe reason; anything not `approved` throws `CalendarWriteRefused`) and `undo(id)`.
- Booked items: a kind with `booked(payload, { timezone })` gets one `digest` flag of kind `booked` from `CalendarWriter` once its events are booked (`codeLine` in `line.ts`, which `composePrompt` uses too: one line, NFKC, number signs removed, ≤ 240 chars; dedupe `booked:<approval id>`). It is raised again (a no-op) every time `executeApproved` finds the approval `executed`, so a crash between booking and flag is repaired by the retried resolution. `calendar_event`: `Dinner — Fri Nov 13, 7:00–8:30 PM`. A denied or failed approval raises none.
- Default expiry 24 h. The per-agent `approvals.sweep` (every minute) marks expired, calls `onExpired`, raises a `digest` flag, and sends unsent prompts.
- Action names (I15): `approval.requested`, `approval.approved`, `approval.denied`, `approval.ambiguous`, `approval.not_open`, `approval.cancelled`, `approval.expired`, `approval.executed`, `approval.failed`, `calendar.event_created`, `calendar.event_deleted`, `calendar.write_refused`.

### 8.4 Agent-to-agent (open conversation)

Start: owner tells the Brain what they want → Brain calls `talk_to_agent({ with, topic, brief, window_start?, window_end? })` → taint rule + `EgressGuard` (I11) → conversation created, `open` message (topic + brief + window) delivered to the peer over the internal channel (a job on the peer's lane) → owner sees code-rendered: `Talking to Sam's Violet about "Dinner Friday": "<brief>"`.

Each delivery runs one **Envoy turn** on the receiving side: context = own brief + own owner notes + transcript (peer text wrapped as untrusted) → tool loop with the seven Envoy tools → exactly one outward act (`say`, `propose`, `accept`, `decline`, `ask_owner`, `end_conversation`).

- `propose({ summary, events: [{ title, start, end, location?, calendars: 'both'|'mine'|'theirs' }] })` — 0 to 5 events. Zero events = an agreement with nothing to book.
- `accept({ proposal_seq })` — code validates the proposal, re-checks free/busy for every calendar it touches, then creates one `a2a_outcome` approval per owner, rendered by code from the stored proposal. Both yes → `CalendarWriter` books on each calendar (separate events, no invites sent), both owners get "Booked: …". One no → the other owner's prompt is cancelled and they are told "Sam said no to: …"; the conversation waits for new guidance from the owner who said no.
- `ask_owner({ question })` → owner gets one line at once; the Brain relays the answer with `tell_envoy` (same I11 checks) and the Envoy resumes.
- Limits per I12. Idle 24 h → expired. Every message is stored; either owner can ask for the full verbatim transcript (`send_transcript_to_owner` sends code-rendered text, not a model paraphrase).

### 8.5 Flags, digest, proactive

- `now` flags: one line, at once, within budget and quiet hours (I17). Approval prompts and Envoy questions are never budgeted (they do not go through flags). A paused agent texts no flag: it becomes a digest item.
- `digest` flags: held. At the owner's local `digest_hour` (default 18:00), once per local date, code renders the digest: messages taken, agent conversations opened/closed, drafts created, things booked, approvals still waiting, overflowed flags. Empty → nothing sent.
- Conflict check: hourly, looks 36 h ahead for overlapping events; a new overlap raises a `now` flag once (dedupe key = the event pair).

**Details (M5, `src/flags/`).** All rendering is code; no model call.
- *Now policy* (`policy.ts`, installed by `flagsModule` through `app.flags.setNowDelivery`, so captured `FlagService`s keep working). Each delivery decision runs in one transaction under the agent row lock (`FOR UPDATE`): paused → digest item (`flag.overflow` reason `paused`); quiet hours [22:00, 07:00) owner-local → `held_until` = next 07:00 (`flag.held`); else, if held flags of the agent are already due (`held_until` ≤ now), they are texted first, oldest first, before this flag decides (so a flag raised before the 07:00 release tick never takes the budget ahead of them); then the owner-local date's budget (3; a reserved send counts) → reserve and send, or digest item (`flag.overflow` reason `budget`, `held: true` for a released one). A send holds a 2-minute lease (`attempt_at`); a retryable failure frees it, sets `retry_at` (backoff 1 min doubling to 15 min, at least the transport's `retryAfterMs`) and rethrows (a retried raise finishes the delivery at once; only the release task waits for `retry_at`), a permanent one or a suppressed send makes the flag a digest item (`send_failed` / `suppressed`, budget refunded). A lease left by a crash is retried after it expires unless the gateway already recorded that text. Scheduler task `flags.release` (every tick) texts due held flags oldest first (`flag.released`) and retries failed sends.
- *Digest* (`digest.ts`). Task `digest.run` (every tick) per agent: due from `digest_hour` on (owner-local); inside quiet hours only during `digest_hour` itself, so catch-up never runs in quiet hours. Paused, quiet or unpaired → `digest.deferred {date, reason}` once per date and reason. Build = one transaction under the agent row lock: render the undelivered items plus live sections, insert the date's row with a 2-minute send lease, tie the items to it (`digest_id`). Send the stored body; success → `sent` (+ items) and `digest.sent {date, items, leftOut}`; nothing to say → `empty`, `digest.empty`; retryable failure → the lease is kept until a backoff (1 min doubling to 15 min, at least `retryAfterMs`), one `digest.deferred send_failed {attempt, retryAt}` per attempt, retried with the same body; permanent failure, or a date that ends undelivered → `rolled_over`, items back to the pool for the next date (`digest.deferred day_ended|send_failed`). Before re-sending, a body the gateway already recorded is marked sent instead. Delivery is at least once only across a crash between the transport send and the gateway's record.
- *Rendering* (`render.ts`): `Today:`, then sections by `order`: `Messages taken` (`message_taken`), `Agent conversations` (`a2a_opened`, `a2a_closed`, raised by M4), `Drafts` (`draft_created`), `Booked` (`booked`, `a2a_booked`), `Waiting for you` (live, added by `approvalsModule`: `listPending` — pending and unexpired — one line per approval, its stored prompt without ` Reply yes or no.`, so `#ref` stays answerable as `yes #7`), `Also` (`approval_expired`, overflowed `now` flags, unknown kinds). One `- ` line per item (re-sanitized, I13), ≤ 10 per section then `+N more`, whole body ≤ 3500 chars cut on whole lines with `+N more not shown`; left-out items count as delivered. `app.digest`: `registerKind(kind, sectionKey)`, `addSection({key, title, order, lines?(agentId, range)})` (same key replaces; a live section that throws or does not answer within 5 s is logged and omitted; live sections run in parallel and `runDue` works on up to 4 agents at once, so one slow agent does not hold back the others), `runDue(now)`, `preview(agentId)` (writes nothing). A module that registers sections installs after `flagsModule`.
- *Conflict check* (`conflicts.ts`, `registerPerAgent('flags.conflicts', 1 h)`): `listEvents(now, now+36h)`; timed events only (all-day and zero-length never conflict; touching is not overlap; `CalendarEvent` has no free/cancelled marker and the real provider drops cancelled events); pairs ordered by overlap start; at most 3 new pairs per run; kind `calendar_conflict`, dedupe key `conflict:` + sorted `id@startISO` of both, so a moved event flags again. Text is one code-rendered line with quoted titles and today/tomorrow/weekday words in the owner's zone; in quiet hours it is worded for the 07:00 delivery and overlaps over by then are skipped. Any provider or delivery error → one log line (error class only), no flag, never thrown.
- Action names (I15): `flag.held`, `flag.released`, `flag.overflow`, `digest.sent`, `digest.empty`, `digest.deferred`.

### 8.6 Pause

`pause` → state flips at ingest (never behind the lane's backlog), one ack, then silence to everyone (I14). Because the gateway checks `paused` at send time, nothing an older job or its retry tries to send gets out once the pause is ingested. Messages that arrive while paused stay held even if a `resume` is ingested before their job runs, and a job that recorded its `held` step stays held on retry after a resume (it only finishes its flag step). `resume` → ack, `onResume` hooks run (unsent approval prompts are sent; waiting Envoy turns are re-queued). Stranger messages taken while paused were stored with their `message_taken` digest flag (8.1 step 5) but got no canned reply; they appear in the first digest after resume (the digest is deferred while paused).

## 9. Milestones

| # | Scope | Depends on |
|---|---|---|
| M1 | Core: db adapter + migrations, repos, clock, config, action log, jobs, scheduler, outbound gateway, router (pairing, pause, stranger flow), basic flags, fake transport, fake Google, scripted LLM, test world, CLI `owner:add`, server skeleton. All contract files. | — |
| M2 | Brain: Anthropic client, tool loop, prompt, Brain tools, untrusted wrapping + taint, approvals (service, resolver, expiry), `CalendarWriter`, memory/notes. | M1 |
| M3 | Google: OAuth, encrypted tokens, allow-listed HTTP, real Calendar + Gmail providers. | M1 |
| M6 | Telegram transport: webhook + long polling, pairing, buttons, chunking. | M1 |
| M4 | Agent-to-agent: conversations, Envoy, egress guard, outcome approvals + booking, Brain a2a tools. | M2 |
| M5 | Flags + digest: budget, quiet hours, digest job, conflict detection. | M2 |
| M7 | Required e2e tests (simulation, privacy, injection), README, demo, Dockerfile, fly.toml. | all |

M2, M3, M6 run in parallel. Then M4 and M5 in parallel. Every milestone is
verified by an agent that did not write it.
