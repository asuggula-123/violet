# Deploying Violet

Every step says what it touches:

- **[local]**: your machine only.
- **[account]**: creates or changes something in a cloud or vendor account (Fly, Telegram, Google).
- **[money]**: starts something that is billed. Check the provider's current pricing first; this guide quotes no prices.
- **[real people]**: sends messages to, or reads data of, real people.

Nothing here runs by itself. Read each command before you paste it. Replace every `<...>`.

Violet runs as **one** always-on process: HTTP server, job queue, scheduler and daily
digest live in it. It needs Postgres 16 and **exactly one** Fly machine (`fly.toml`
explains why two machines would run every scheduled task twice).

## 1. Prepare

1. **[local]** Install `flyctl` (see Fly's docs) and `openssl`.
2. **[account]** `fly auth login`
3. **[local]** Edit `fly.toml`: set `app` to a name of your own (`violet-app` is a
   placeholder; names are global) and `primary_region` to a region near you
   (`fly platform regions`). Below, `<app>` is that name.
4. **[account]** `fly apps create <app>`

## 2. Database

**[account] [money]** Violet needs a Postgres 16 database and its connection URL in
`DATABASE_URL`. Pick one (check current options and pricing first):

- Fly's managed Postgres (`fly mpg --help`), or Fly's older unmanaged Postgres app
  (`fly postgres create`, then `fly postgres attach --app <app> <postgres app>`, which sets
  the `DATABASE_URL` secret for you);
- any other Postgres 16 provider: set `DATABASE_URL` yourself in step 5 (add
  `?sslmode=require` if the provider wants TLS).

Migrations run automatically at every boot (`src/main.ts`, before the server listens,
under a Postgres advisory lock). There is no separate migration step. The migrations are
the plain SQL files in `src/db/migrations/`, applied in order and recorded in
`schema_migrations`: `001_core.sql`, `002_approvals.sql`, `003_google.sql`,
`004_a2a.sql` (the agent-to-agent tables), `005_flags.sql`, `006_transport.sql`, `007_i19.sql` (genuine
approval deliveries, prompts held until the end of a Brain turn). Production has no
fallback database: with `NODE_ENV=production` (set in the image) and no `DATABASE_URL`,
the server and every CLI stop with `DATABASE_URL is missing: ...` instead of using an
embedded database.

## 3. Telegram bots (one per owner)

**[account]** For each owner (e.g. Alex and Sam), in Telegram, talk to `@BotFather`:

1. `/newbot`, choose a display name and a username ending in `bot`.
2. Keep the token it gives you: `<bot id>:<secret>`. The digits before `:` are the
   **bot id**, which is that owner's agent address.
3. Keep the bot **username** (without `@`) for the pairing link.

Never paste tokens into files, chats or tickets. They go only into `fly secrets set`.

## 4. Google OAuth client (optional: calendar and Gmail)

**[account]** Skip this to run without Google. In production (`NODE_ENV=production`)
Violet then has no calendar or Gmail at all, and says so: the boot log warns
`Google is not configured`, every calendar or email request the owner makes fails and
the assistant is told "Google isn't connected on this server" (it tells the owner in its
own words), and an event the owner approves is not booked — the
owner gets `I couldn't book #<n>: Google isn't connected on this server.` and the
approval ends `failed`. Nothing is stored in a stand-in. (Outside production — local
runs and tests — in-memory stand-ins are used instead, and the log says so at start-up.)
In Google Cloud Console, in a project of your own:

1. Enable the **Google Calendar API** and the **Gmail API**.
2. OAuth consent screen: user type External (or Internal on Workspace); add the scopes
   below; add both owners' Google accounts as test users while you set up.
3. Credentials → Create credentials → OAuth client ID → type **Web application**.
   Authorized redirect URI: `https://<app>.fly.dev/oauth/google/callback`
   (the callback route in `src/google/routes.ts`). Keep the client ID and secret.
4. Set the consent screen's publishing status to **In production**: in *Testing*,
   Google expires refresh tokens after 7 days and owners would have to reconnect
   weekly. Gmail scopes are restricted: Google shows an "unverified app" warning and may
   ask for verification; check Google's current rules for apps used by a few people.

Scopes requested by default (`src/google/scopes.ts`), all under
`https://www.googleapis.com/auth/`: `calendar.freebusy`, `calendar.events.owned`,
`gmail.readonly`, `gmail.drafts.create`. `GOOGLE_SCOPES` (space-separated full URLs)
overrides them; if the consent screen rejects `gmail.drafts.create`, use `gmail.compose`
(the HTTP allow-list still makes sending email impossible).

## 5. Secrets

**[account]** Every secret is an environment variable read by `src/config.ts`. Non-secret
settings (`NODE_ENV`, `PORT`, `TRANSPORT`, `TELEGRAM_MODE`) are in `fly.toml` `[env]`.

| Name | Required | What it is | How to get it |
|---|---|---|---|
| `DATABASE_URL` | yes | Postgres connection URL | step 2 (set by `fly postgres attach`) |
| `PUBLIC_BASE_URL` | yes | Public https base URL, no trailing path. Used to register the Telegram webhooks at boot and to build Google connect links. Not sensitive. | `https://<app>.fly.dev` |
| `TELEGRAM_BOT_TOKENS` | yes | Comma-separated bot tokens `<bot id>:<secret>`, one per agent, no duplicates | step 3 |
| `TELEGRAM_WEBHOOK_SECRET` | yes | Secret Telegram sends with every webhook call: 16–256 characters of `A-Z a-z 0-9 _ -` | `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | for the Brain | Claude API key, read by `src/deps.ts`. Without it no model is called: the owner's free-text messages get the fixed reply "My AI model isn't connected yet, …"; yes/no answers, pause/resume, the stranger reply and the digest still work. | Anthropic Console |
| `GOOGLE_CLIENT_ID` | for Google | OAuth client ID | step 4 |
| `GOOGLE_CLIENT_SECRET` | for Google | OAuth client secret | step 4 |
| `GOOGLE_REDIRECT_URI` | for Google | Must equal the redirect URI registered in step 4 | `https://<app>.fly.dev/oauth/google/callback` |
| `TOKEN_ENC_KEY` | for Google | 32 random bytes, standard base64. Encrypts Google refresh tokens at rest (AES-256-GCM). | `openssl rand -base64 32` |
| `ADMIN_TOKEN` | no | Bearer token for the dev endpoints `/dev/inbound` and `/dev/outbox`. Those never exist with `NODE_ENV=production`, so production does not use it. | `openssl rand -hex 32` |

Google is used only when all four of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI` and `TOKEN_ENC_KEY` are set. Optional, not secret: `VIOLET_MODEL`
(the Brain's model, default `claude-opus-5-5`), `VIOLET_ENVOY_MODEL` (the agent-to-agent
model, default `VIOLET_MODEL`), `GOOGLE_SCOPES`. `.env.example` lists every variable
`src/config.ts` reads, with a one-line explanation each.

Set them in one command (values only on your machine; leave out the Google lines to run
without Google, and `DATABASE_URL` if `attach` set it):

```sh
fly secrets set --app <app> \
  DATABASE_URL='<postgres url>' \
  PUBLIC_BASE_URL='https://<app>.fly.dev' \
  TELEGRAM_BOT_TOKENS='<alex bot token>,<sam bot token>' \
  TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY='<anthropic key>' \
  GOOGLE_CLIENT_ID='<client id>' \
  GOOGLE_CLIENT_SECRET='<client secret>' \
  GOOGLE_REDIRECT_URI='https://<app>.fly.dev/oauth/google/callback' \
  TOKEN_ENC_KEY="$(openssl rand -base64 32)"
```

`fly secrets list --app <app>` shows names and digests, never values. Keep your own copy
of `TOKEN_ENC_KEY` somewhere safe: without it stored Google connections cannot be read.

## 6. Deploy

1. **[account] [money]** `fly deploy --app <app> --ha=false` (builds the `Dockerfile`,
   starts one always-on machine; `--ha=false` stops Fly creating a second one).
2. **[account]** `fly scale count 1 --app <app>` and `fly status --app <app>`: exactly one
   machine, state `started`.
3. **[local]** `curl https://<app>.fly.dev/healthz` → `{"ok":true}` (it checks the database).
4. **[account]** `fly logs --app <app>`: look for `migrations applied` (first boot),
   `telegram webhook registered` once per bot, and `violet started`.

## 7. Add the household and the owners

**[account]** Open a shell on the machine and run the CLI from the build (no dev tools in
the image):

```sh
fly ssh console --app <app>
cd /app
npm run owner:add:prod -- --household Home --name Alex --tz Europe/London \
  --transport telegram --agent-address <alex bot id> --bot-username <alex bot username>
npm run owner:add:prod -- --household Home --name Sam --tz Europe/London \
  --transport telegram --agent-address <sam bot id> --bot-username <sam bot username>
```

`--tz` is an IANA zone. The second call finds the household by name (exact match, or pass
the household id printed by the first call). Each call prints the
owner id and a pairing code (shown once, valid 24 hours). A call prints
`Household: <name> (<id>)` first. If a call says the database is missing
(`DATABASE_URL is missing: ...`), check `printenv DATABASE_URL NODE_ENV` in that shell.

## 8. Pair each owner

**[real people]** Each owner opens their own bot in Telegram (or the printed
`https://t.me/<bot username>?start=<code>` link) and sends exactly `/start <code>`. The
first matching message binds that Telegram account as the owner; anyone else who writes
to the bot gets a fixed canned reply. Run `owner:add` again only for a new owner.

A lost or expired code: issue a fresh one for that agent (the agent id is the `Agent:`
line `owner:add` printed). The old code stops working at once; the new one is printed
once, with the same instructions, and valid 24 hours:

```sh
cd /app && npm run pairing:reissue:prod -- --agent <agent id> --bot-username <bot username>
```

It refuses an agent that is already paired. To move an agent to another Telegram account
(for example the owner's new phone number), add `--reset`: the paired chat stops being the
owner at once (its next message gets the stranger reply) and a new code is issued. A message
from the old chat that was already being handled when the reset ran gets no reply, and one
not yet handed to the assistant is dropped (`inbound.dropped`, reason `owner_reset`). The
agent keeps its history and pending approvals, so pair only the same owner again.
`action_log` records `pairing.reset` and `pairing.code_issued` (never the code). Locally:
`npm run pairing:reissue -- --agent <agent id>`.

## 9. Agent-to-agent (between owners of one household)

Nothing to set up beyond step 7: an owner asks their Violet to sort something out with
another owner ("ask Sam about dinner on Friday") and the two agents talk.

- **Same household only.** An agent can talk only to agents whose owners are in the same
  household (I12). `owner:add` puts an owner in the household named by `--household`: use
  the same name (exact match) or the household id for both owners. A different spelling
  creates a second household, and the agents cannot reach each other. Agents are found by
  the other owner's first name.
- **Nothing leaves the server for agent-to-agent traffic.** The agents' conversation is
  rows in Postgres and jobs on the server's own queue; no Telegram message, email or other
  network message carries it. What does go out: the Envoy's model calls (Claude API, model
  `VIOLET_ENVOY_MODEL`, default `VIOLET_MODEL`) and, with Google connected, free/busy reads
  inside the conversation's time window.
- **What owners see [real people]:** the exact text their Violet sent the other agent
  (`Talking to Sam's Violet about …`), questions the other side's Violet needs answered (at
  once), one yes/no prompt per owner for any outcome (both must say yes before anything is
  booked: separate events, no invites), and digest lines for conversations started, closed,
  stuck or booked. Either owner can ask for the verbatim transcript.
- **Without Google** (production): an outcome both owners approve is not booked; both get
  `Couldn't book …: Google isn't connected on this server. Nothing was booked.`
- Limits: 3 open conversations and 10 new ones a day per pair of agents, 12 messages per side.

## 10. Connect Google (optional)

**[real people]** In `fly ssh console --app <app>`:

```sh
cd /app && npm run google:link:prod -- --owner <owner id>
```

Send the printed link to that owner (single use, valid 15 minutes). They sign in to their
own Google account and approve. The page says "Connected. You can close this tab." and
`action_log` records `google.connected`.

## 11. Day to day

- **Health:** `curl https://<app>.fly.dev/healthz`, `fly status`, `fly checks list`,
  `fly logs --app <app>`.
- **Pause an agent [real people]:** the owner texts `pause` to their bot (also `/pause`,
  any case). The agent sends one ack and then nothing to anyone (no reply, flag, digest or
  stranger reply); the scheduler skips it. `resume` undoes it: approval prompts held
  meanwhile are sent, and messages strangers left meanwhile are in the next digest.
- **What owners receive unasked [real people]:** approval prompts at once, and so are
  agent-to-agent questions and results (`Waiting for Sam.`, `Booked: …`, `Sam said no to: …`),
  even at night and outside the daily budget; urgent flags
  (e.g. a calendar conflict, Google needing a reconnect) at most 3 per owner-local day and
  never between 22:00 and 07:00 (held until 07:00); everything else in one daily digest at
  the owner's digest hour (18:00 local, the `owners.digest_hour` column; nothing is sent when
  there is nothing to say).
- **Stop everything [account]:** `fly scale count 0 --app <app>`; start again with
  `fly scale count 1 --app <app>`.
- **Roll back [account]:** `fly releases --app <app> --image` lists earlier images;
  `fly deploy --app <app> --ha=false --image <image ref>` redeploys one. Migrations only
  move forward: an older release runs against the newer schema (tables it does not know
  are ignored).
- **Rotate a secret [account]:** `fly secrets set --app <app> NAME='<new value>'`
  restarts the machine with it.
  - `TELEGRAM_WEBHOOK_SECRET`: the new one is registered with Telegram at boot.
  - A bot token: BotFather `/revoke`, then set the full `TELEGRAM_BOT_TOKENS` list again
    (the bot id stays the same).
  - `GOOGLE_CLIENT_SECRET`: create a new secret in Cloud Console first, then set it.
  - `TOKEN_ENC_KEY`: there is no re-encryption. With a new key, stored Google
    connections cannot be decrypted; each owner gets "Google access expired — reconnect
    needed." and you run `google:link:prod` for them again.
  - `ANTHROPIC_API_KEY`, `DATABASE_URL`: set the new value, then revoke the old one at
    the provider.

## Local run

No accounts, keys or money involved.

- **No keys, embedded database (PGlite in `./.data/pglite`), fake transport:**

  ```sh
  npm ci
  npm run owner:add -- --household Home --name Alex --tz Europe/London \
    --transport fake --agent-address violet-alex --owner-address alex
  ADMIN_TOKEN=local-dev-token npm run dev
  curl -X POST localhost:8080/dev/inbound -H 'authorization: Bearer local-dev-token' \
    -H 'content-type: application/json' \
    -d '{"agentAddress":"violet-alex","fromAddress":"alex","text":"hello"}'
  curl localhost:8080/dev/outbox -H 'authorization: Bearer local-dev-token'
  ```

  With PGlite only one process may open the data directory: stop the server before
  running a CLI. `--owner-address` presets the owner, so no pairing is needed.
- **With Postgres in Docker:** `docker compose up -d postgres`, then prefix the commands
  above with `DATABASE_URL=postgres://violet:violet@127.0.0.1:5432/violet`.
- **The production image, full stack:** `docker compose --profile app up --build`
  (Postgres + the app with the fake transport). Add an owner with
  `docker compose exec app npm run owner:add:prod -- <flags as above>`. The dev endpoints
  use `ADMIN_TOKEN`, default `local-dev-admin-token-not-a-secret`.
- **The production build without Docker:** `npm run build`, then `npm start`; the CLIs
  run as `npm run migrate:prod`, `npm run owner:add:prod`, `npm run google:link:prod`,
  `npm run pairing:reissue:prod`.
- **Tests:** `npm test` (PGlite); `TEST_DATABASE_URL=postgres://violet:violet@127.0.0.1:5432/violet_test npm run test:pg`
  against a real Postgres.
