# Violet

Each person in a household gets a personal AI agent called Violet. You text your
Violet; it can talk to the other people's Violets to sort things out, like a time for
dinner. Nothing happens until the people involved say yes.

## What it does today

- You chat with your Violet on Telegram (one bot per person).
- With Google connected: it reads your Calendar and Gmail, writes email drafts for you
  to send, and books an event after you say yes to a one-line prompt.
- It plans with another person's Violet (for example, dinner on Friday). From your
  calendar and email, only busy times cross; what you ask it to say is passed on. Both
  calendars are booked only after both people say yes.
- Strangers get one fixed reply: it is an AI and has taken the message. The message
  goes in your digest.
- A typed yes or no counts only right under Violet's question; otherwise Violet shows the
  question again (or, under its own reply, treats it as conversation). The buttons work
  whenever Violet is not paused.
- `pause` stops it sending anything to anyone; `resume` turns it back on.
- A digest every day at 6 pm. Urgent notes (like a calendar clash): at most 3 a day,
  never between 10 pm and 7 am.

It will not: send email; book anything without a yes (from both people when two are
involved); tell strangers anything about you, or pretend to be human. Not in v1: voice,
SMS, sending email, payments, reading your personal texts.

## Why Telegram, not WhatsApp

WhatsApp's business terms currently bar general-purpose AI assistants as a bot's main
function, with a few regional exceptions. This comes from search results quoting the
terms (the pages could not be opened while building): medium confidence, check again
before relying on it. The chat service is a small adapter (`src/transport/`), so
WhatsApp can be added if the terms change.

## Run it on your computer

Needs Node 22. No keys, no Docker, no network.

```sh
npm ci
npm run demo     # the 60-second story; add -- --fast to skip the pauses
npm test         # the whole test suite
```

`docs/DEMO.md` says what the demo shows and how to present it.

For the real server locally (Postgres in Docker, `npm run dev`), follow "Local run" in
`docs/DEPLOY.md`. To use your real Telegram bots without a public address, also set
`TRANSPORT=telegram`, `TELEGRAM_MODE=polling` and `TELEGRAM_BOT_TOKENS`, then add each
owner with `--transport telegram --agent-address <bot id>` and pair them (DEPLOY.md
steps 7-8).

## Keys you need to create

None for the demo or the tests. For a real server ("you" = make it yourself):

| Name | Where from | What for |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Console | The AI model. Without it, free text gets a fixed "not connected" line. |
| `TELEGRAM_BOT_TOKENS` | Telegram `@BotFather`, one bot per person | Comma-separated; each bot is one Violet. |
| `TELEGRAM_WEBHOOK_SECRET` | You: `openssl rand -hex 32` | Proves webhook calls come from Telegram. |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client | Optional*. Calendar and Gmail. |
| `GOOGLE_CLIENT_SECRET` | Same client | Optional*. |
| `GOOGLE_REDIRECT_URI` | You: `<PUBLIC_BASE_URL>/oauth/google/callback` | Optional*. Register it on the client. |
| `TOKEN_ENC_KEY` | You: `openssl rand -base64 32` | Optional*. Encrypts stored Google access. Keep a copy. |
| `GOOGLE_SCOPES` | Leave empty | Optional. Overrides the Google permissions. |
| `ADMIN_TOKEN` | You: `openssl rand -hex 32` | Local test endpoints only. |
| `DATABASE_URL` | Your Postgres provider | The database. |
| `PUBLIC_BASE_URL` | Your server's address | Webhooks and Google links. |
| Fly account | fly.io | Hosting. |

*Without the four Google settings, calendar and email are off and nothing is booked.
`.env.example` lists every setting. Never put real values in the repo.

## How it is built

Rules live in code, not in the prompt, so they hold even if the model is fooled. Each
Violet has two minds: the Brain works for its owner and sees their data; the Envoy talks
to other agents and sees only what its owner asked it to say, busy times and the
conversation (open mouth, closed vault). Every message out goes through one door, which
enforces pause and who may get what. People approve outcomes through prompts written by
code. Everything is logged. Details: `docs/ARCHITECTURE.md`.

## How it is tested

The three required end-to-end tests are in `test/e2e/`, run with `npm run test:e2e`:
`simulation.test.ts` (the full family story), `privacy.test.ts` (private details never
reach another agent or a stranger), `injection.test.ts` (hostile text from strangers,
agents or email changes nothing). `npm test` runs every test on Postgres inside the
process; `TEST_DATABASE_URL=postgres://… npm run test:pg` runs them on a real Postgres.

## Known limits

- A crash at the wrong moment can make a duplicate Gmail draft or re-send a one-line
  message. If the model is down through every retry, that message gets no reply.
- One server machine only: the scheduler is not safe across processes.
- A typed yes or no relies on Telegram numbering a chat's messages in order. This is not
  yet checked against live Telegram; if it is off, Violet asks again and the buttons still work.
- The clash check cannot tell events marked "free" from busy ones.
- After reading email or calendar details, what it tells another agent is held for the
  owner's yes more often than needed (safe first; to be tuned).
- Vendor docs could not be opened while building: check the Fly and Google steps in
  `docs/DEPLOY.md` against current docs and prices, and the Gmail permission
  `gmail.drafts.create` against Google's consent screen (fallback in DEPLOY.md).
- Nothing has been deployed and no real account has been touched.

## Deploy

`docs/DEPLOY.md` has every step and what each touches. Deploying costs money (a server
and a database) and is your decision.
