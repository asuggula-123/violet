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
| I14 | Paused agent: the gateway refuses every send except the single pause/resume ack. The router stores inbound and does nothing else. The scheduler skips the agent. The Envoy does not run. |
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
- Scripts: `npm run typecheck`, `npm test`, `npm run test:pg`, `npm run migrate`, `npm run dev`, `npm run demo`, `npm run owner:add`.
- Test personas are **Alex** and **Sam**. No real names, numbers, emails or keys anywhere in the repo.
- `.gitignore`: `node_modules`, `dist`, `.env*` (except `.env.example`), `.data`, `.worktrees`.

## 5. Layout

```
src/
  config.ts            env parsing (zod)
  clock.ts             Clock, SystemClock, FakeClock
  app.ts               buildApp(deps, modules) — composition root
  modules.ts           defaultModules list (one line per milestone)
  server.ts            Fastify: /healthz, webhooks, oauth, dev endpoints
  db/                  db.ts (Db, PgDb, PgliteDb), migrate.ts, migrations/*.sql
  core/                types.ts, repos/*, router.ts, outbound.ts, jobs.ts,
                       scheduler.ts, actionLog.ts, flags.ts, setup.ts, canned.ts, sanitize.ts
  transport/           types.ts, fake.ts, telegram/*
  llm/                 types.ts (LlmClient), anthropic.ts, scripted.ts, toolLoop.ts
  brain/               brain.ts, prompt.ts, tools/*, untrusted.ts
  approvals/           service.ts, resolver.ts, calendarWriter.ts
  google/              types.ts, fake.ts, oauth.ts, http.ts, calendar.ts, gmail.ts, tokens.ts
  a2a/                 types.ts, service.ts, envoy.ts, envoyTools.ts, egress.ts, outcome.ts, render.ts
  flags/               digest.ts, conflicts.ts, budget.ts
  cli/                 migrate.ts, ownerAdd.ts, demo.ts, chat.ts
test/
  helpers/world.ts     createTestWorld()
  unit/ … e2e/         e2e/simulation.test.ts, e2e/privacy.test.ts, e2e/injection.test.ts
```

## 6. Data model

Migration files are pre-assigned so parallel milestones never collide.

**001_core.sql (M1)**
- `households(id, name, created_at)`
- `owners(id, household_id, name, timezone, digest_hour default 18, created_at)`
- `agents(id, owner_id unique, name default 'Violet', transport, agent_address, owner_address null, pairing_code_hash null, pairing_expires_at null, paused bool, paused_at null, created_at, unique(transport, agent_address))`
- `contacts(id, agent_id, transport, address, display_name null, kind 'owner'|'stranger', first_seen_at, last_seen_at, last_canned_reply_at null, unique(agent_id, transport, address))`
- `contact_notes(id, agent_id, contact_id null, subject null, body, created_at)`
- `messages(id, agent_id, thread 'owner'|'contact', contact_id null, direction 'in'|'out', body, purpose null, transport_message_id null, reply_to_transport_message_id null, meta jsonb, created_at)`
- `inbound_events(id, transport, transport_message_id, agent_address, payload jsonb, received_at, processed_at null, unique(transport, transport_message_id))`
- `jobs(id, type, lane null, payload jsonb, status 'queued'|'running'|'done'|'failed'|'dead', attempts, max_attempts, run_at, locked_at null, last_error null, dedupe_key unique null, created_at, finished_at null)`
- `flags(id, agent_id, kind, urgency 'now'|'digest', text, dedupe_key null, status 'pending'|'sent'|'suppressed', created_at, delivered_at null, digest_date null, unique(agent_id, dedupe_key))`
- `scheduler_state(name, scope, last_run_at, primary key(name, scope))`
- `action_log(id bigserial, at, agent_id null, actor, action, detail jsonb)` + append-only trigger
- `schema_migrations(version, applied_at)`

**002_approvals.sql (M2)**
- `approvals(id, agent_id, ref int, kind, payload jsonb, prompt, status 'pending'|'approved'|'denied'|'expired'|'cancelled'|'executed'|'failed', group_id null, prompt_transport_message_id null, created_at, expires_at, resolved_at null, resolved_by_message_id null, executed_at null, error null, unique(agent_id, ref))`
- `calendar_writes(id, owner_id, approval_id, event_id, idempotency_key unique, created_at)`

**003_google.sql (M3)** — `google_accounts(owner_id pk, email, refresh_token_enc, scopes, connected_at, revoked_at null)`, `oauth_states(state pk, owner_id, created_at, expires_at)`

**004_a2a.sql (M4)**
- `a2a_conversations(id, initiator_agent_id, responder_agent_id, topic, status, window_start null, window_end null, created_at, updated_at, closed_at null, close_reason null)`
- `a2a_sides(conversation_id, agent_id, brief, owner_notes jsonb, cleared_text, availability_calls int, messages_sent int, owner_questions int, awaiting_owner bool, primary key(conversation_id, agent_id))`
- `a2a_messages(id, conversation_id, seq int, from_agent_id null, kind 'open'|'text'|'proposal'|'accept'|'decline'|'system'|'close', body, payload jsonb, created_at, unique(conversation_id, seq))`

**005_flags.sql (M5)** — `digests(id, agent_id, local_date, body, sent_at, unique(agent_id, local_date))`

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

// src/core/outbound.ts
export interface OutboundGateway {
  /** Returns null when suppressed (paused). */
  sendToOwner(agentId: string, text: string, opts: { purpose: Exclude<OutboundPurpose, 'canned'>; buttons?: { id: string; label: string }[] }): Promise<{ messageId: string; transportMessageId: string } | null>;
  sendCanned(agentId: string, contactId: string, key: CannedKey): Promise<void>;
}

// src/llm/types.ts — mirrors the Anthropic Messages API shape
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };          // thinking etc. — pass back verbatim
export interface LlmMessage { role: 'user' | 'assistant'; content: string | LlmBlock[] }
export interface LlmTool { name: string; description: string; input_schema: Record<string, unknown> }
export interface LlmRequest {
  system: string; messages: LlmMessage[]; tools: LlmTool[]; maxTokens: number;
  /** Not sent to the API. Used for logging and for scripting tests. */
  meta: { agentId: string; mind: 'brain' | 'envoy'; conversationId?: string };
}
export interface LlmResponse { content: LlmBlock[]; stopReason: string; usage?: { inputTokens: number; outputTokens: number } }
export interface LlmClient { complete(req: LlmRequest): Promise<LlmResponse> }

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

// src/core/jobs.ts — DB-backed queue; one running job per lane (lane = agent id)
export interface JobQueue {
  register(type: string, handler: (payload: any) => Promise<void>): void;
  enqueue(type: string, payload: unknown, opts?: { lane?: string; runAt?: Date; dedupeKey?: string }): Promise<void>;
  pump(): Promise<number>;           // run all currently runnable jobs; returns how many ran
  start(): void; stop(): Promise<void>;
}

// src/core/scheduler.ts
export interface Scheduler {
  register(name: string, everyMs: number, fn: (now: Date) => Promise<void>): void;
  runDue(): Promise<void>;
}

// src/app.ts
export interface AppDeps { db: Db; clock: Clock; transport: Transport; llm: LlmClient; calendar: CalendarProvider; gmail: GmailProvider; config: Config; log: Logger }
export interface Module { name: string; install(app: App): void | Promise<void> }
export interface App {
  deps: AppDeps;
  repos: Repos; actionLog: ActionLog; gateway: OutboundGateway; jobs: JobQueue; scheduler: Scheduler; flags: FlagService; router: Router;
  ingest(msg: InboundMessage): Promise<void>;     // persist + enqueue, fast
  settle(): Promise<void>;                        // pump until idle (tests, demo)
  start(): Promise<void>; stop(): Promise<void>;
  // installed by later modules:
  approvals?: ApprovalService; brain?: Brain; a2a?: A2AService; digest?: DigestService;
}
```

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

## 8. Flows

### 8.1 Inbound routing (deterministic, before any model)

1. Webhook authenticates, normalizes to `InboundMessage`, calls `app.ingest` → insert `inbound_events` (dedupe) + enqueue `inbound.process` on lane = agent → return 200.
2. Unknown `agentAddress` → log, drop.
3. Pairing: if the agent has no `owner_address` and the text is `/start <code>` matching the unexpired pairing code → bind owner, ack. A wrong or missing code is treated like any stranger.
4. Sender is owner (I1):
   - `pause` / `resume` (exact, case-insensitive, optional leading `/`) → flip state, one ack.
   - Paused → store, log, stop.
   - `ownerInterceptors` (approval resolver) → handled? stop.
   - `onOwnerMessage` (the Brain).
5. Sender is not owner (I3): upsert contact, store message, log. Paused → stop. Otherwise send the canned reply if none was sent to this contact in the last 12 h, and raise a `digest` flag ("Message from …").
6. Unsupported media: owner gets "I can only read text for now."; strangers get the normal canned flow.

### 8.2 Owner turn (Brain)

System prompt (rules, owner profile, local time, pending approvals, open Envoy questions) + last 40 owner-thread messages + tool loop (≤ 10 steps). Final text → `gateway.sendToOwner(purpose 'reply')`. Tool results containing third-party text are wrapped in `<untrusted source="…">` and mark the turn **tainted**.

Brain tools (M2): `get_schedule`, `find_free_time`, `request_calendar_event`, `search_email`, `read_email`, `draft_email`, `remember`, `recall`, `search_history`, `list_messages_taken`, `list_pending_approvals`.
Added by M4: `talk_to_agent`, `tell_envoy`, `list_agent_conversations`, `read_agent_conversation`, `send_transcript_to_owner`, `end_agent_conversation`.

### 8.3 Approvals

- `approvals.request(agentId, { kind, payload, groupId?, expiresAt? })` → the registered kind renders a **one-line** prompt from the payload → sent at once: `#7 Dinner — Fri Nov 13, 7:00–8:30 PM. Book it? Reply yes or no.` (with yes/no buttons where the transport supports them).
- Resolver (owner interceptor): matches `yes|y|yep|yeah|ok|okay|sure|approve|do it|go ahead|👍` / `no|n|nope|nah|don't|decline|cancel|👎`, optionally followed by `#?<ref>`. Target = explicit ref → else the prompt being replied to → else the only pending approval → else ask "Which one?" with a one-line list. No pending approvals → not handled (falls through to the Brain). Button payloads `approve:<id>` / `deny:<id>` resolve directly.
- Kinds register `{ render(payload), onApproved, onDenied, onExpired }`. M2: `calendar_event`. M4: `a2a_outcome`, `a2a_release`.
- Default expiry 24 h. A sweep job marks expired and calls `onExpired`.

### 8.4 Agent-to-agent (open conversation)

Start: owner tells the Brain what they want → Brain calls `talk_to_agent({ with, topic, brief, window_start?, window_end? })` → taint rule + `EgressGuard` (I11) → conversation created, `open` message (topic + brief + window) delivered to the peer over the internal channel (a job on the peer's lane) → owner sees code-rendered: `Talking to Sam's Violet about "Dinner Friday": "<brief>"`.

Each delivery runs one **Envoy turn** on the receiving side: context = own brief + own owner notes + transcript (peer text wrapped as untrusted) → tool loop with the seven Envoy tools → exactly one outward act (`say`, `propose`, `accept`, `decline`, `ask_owner`, `end_conversation`).

- `propose({ summary, events: [{ title, start, end, location?, calendars: 'both'|'mine'|'theirs' }] })` — 0 to 5 events. Zero events = an agreement with nothing to book.
- `accept({ proposal_seq })` — code validates the proposal, re-checks free/busy for every calendar it touches, then creates one `a2a_outcome` approval per owner, rendered by code from the stored proposal. Both yes → `CalendarWriter` books on each calendar (separate events, no invites sent), both owners get "Booked: …". One no → the other owner's prompt is cancelled and they are told "Sam said no to: …"; the conversation waits for new guidance from the owner who said no.
- `ask_owner({ question })` → owner gets one line at once; the Brain relays the answer with `tell_envoy` (same I11 checks) and the Envoy resumes.
- Limits per I12. Idle 24 h → expired. Every message is stored; either owner can ask for the full verbatim transcript (`send_transcript_to_owner` sends code-rendered text, not a model paraphrase).

### 8.5 Flags, digest, proactive

- `now` flags: one line, at once, within budget and quiet hours (I17). Approval prompts and Envoy questions are never budgeted.
- `digest` flags: held. At the owner's local `digest_hour` (default 18:00), once per local date, code renders the digest: messages taken, agent conversations opened/closed, drafts created, things booked, approvals still waiting, overflowed flags. Empty → nothing sent.
- Conflict check: hourly, looks 36 h ahead for overlapping events; a new overlap raises a `now` flag once (dedupe key = the event pair).

### 8.6 Pause

`pause` → state flips, one ack, then silence to everyone (I14). `resume` → ack, `onResume` hooks run (waiting Envoy turns are re-queued; stranger messages taken meanwhile appear in the next digest).

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
