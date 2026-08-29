# Realtime Pong — a Telegram Mini App

Two people play Pong against each other in realtime inside Telegram. One player
drops an invite link into a chat; whoever taps it first becomes the opponent.
When the match ends, the winner gets a shareable result image that goes back
into the chat, which produces the next invite.

**There is no AI opponent.** Matches are only ever human against human. That is
a product decision, not an oversight.

Pong is the first game on the platform, not the product. Auth, invites,
sharing, stats and i18n are game-agnostic; adding a second game means a new
module in `game-core`, a new Room class, and a new React component.

---

## Layout

```
packages/
  game-core/   deterministic simulation, types, constants  (no dependencies)
    src/net/   the replicated Colyseus schemas             (@pong/game-core/net)
  server/      Colyseus rooms, bot, HTTP API
  client/      React Mini App
tools/
  cheat-detection/   nightly offline batch job (Python)
docs/
  ASSUMPTIONS.md                 every judgement call, and 6 deviations from the brief
  CHAT-INSTANCE-VERIFICATION.md  run this before enabling chat leaderboards
```

`game-core` is imported by both server and client. That is the entire reason
the backend is TypeScript: rollback reconciliation is only silent when both
sides run a bit-identical simulation, so there is exactly one implementation.

**Read `docs/ASSUMPTIONS.md` before changing anything in the netcode.** It
records six places where the shipping libraries differ from what you might
expect, each of which produces a silent failure rather than an error.

---

## Quick start

> **Package manager: [Bun](https://bun.com).** Bun installs and runs scripts;
> the *server* still runs on Node, because `uWebSockets.js` is a Node native
> addon. The Docker image reflects that split — bun in the build stages, plain
> Node at runtime.


```sh
bun install
bun run test        # game-core determinism + initData + two-client netcode
```

The test suite includes end-to-end tests that spawn a real server and connect
two real clients, including one that runs the match under **150ms simulated
latency** and asserts the rollback correction stays at zero. They need no
database and no Telegram credentials.

---

## BotFather setup

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot`.
   Keep the token; it is what signs `initData`, so it is the root of all auth.
2. **Create the Mini App.** `/newapp`, select the bot. The **short name** you
   choose becomes `TELEGRAM_APP_NAME` and appears in every invite link as
   `t.me/<bot>/<app>`. Set the Web App URL to your Vercel deployment.
3. **Set the menu button** (optional): `/mybots` → your bot → *Bot Settings* →
   *Menu Button* → the same URL.
4. **Enable inline mode** — `/setinline`. **Required** for
   `savePreparedInlineMessage`, which is the entire share flow. Without it,
   every share tap returns `share_unavailable`. Check with `getMe`:
   `supports_inline_queries` must be `true`.
5. **Enable group access** if you want the app opened from group chats:
   `/setjoingroups`.

Do **not** call `setWebhook` by hand — the server registers its own webhook on
boot, with a secret token, and a manually-set webhook without that secret is an
unauthenticated command channel.

---

## Environment

Copy `packages/server/.env.example` to `packages/server/.env` and fill it in.
Every variable is validated at boot: a missing one stops the process rather
than surfacing as a failed auth an hour later.

| Variable | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From BotFather. Signs and validates `initData`. |
| `TELEGRAM_BOT_USERNAME` | No leading `@`. |
| `TELEGRAM_APP_NAME` | The Mini App short name from `/newapp`. |
| `TELEGRAM_WEBHOOK_SECRET` | ≥16 chars. Echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token`. |
| `PUBLIC_SERVER_URL` | This server's public HTTPS origin. |
| `PUBLIC_CLIENT_URL` | The Mini App origin, for the CORS allowlist. |
| `DATABASE_URL` | Neon **pooled** string (`-pooler` in the host). |
| `MIGRATION_DATABASE_URL` | Neon **direct** string. Migrations only. |
| `SESSION_SECRET` | ≥32 chars. Distinct from the bot token. |
| `SESSION_TTL_SEC` | Default 3600. |
| `INIT_DATA_MAX_AGE_SEC` | Default 900. Telegram's own default is 86400. |
| `TELEGRAM_REGISTER_WEBHOOK` | **`false` locally.** `setWebhook` is global per bot token, so a laptop that registers itself steals every update from production. |
| `CHAT_LEADERBOARDS_ENABLED` | **Leave `false`** until `docs/CHAT-INSTANCE-VERIFICATION.md` is run. |
| `ROOM_CREATE_LIMIT_PER_HOUR` | Default 30. |
| `COLYSEUS_LATENCY` | Dev only. One-way ms; set `75` for a 150ms round trip. |

The client needs `VITE_SERVER_URL` pointing at the game server.

---

## Local development

### HTTPS is mandatory

Telegram will not open an `http://` Mini App, even on localhost. Two options:

**Locally trusted certificate** (works for a phone on the same Wi-Fi):

```sh
bun run dev:client     # vite-plugin-mkcert issues the cert
```

**A tunnel** (needed for a phone on mobile data, and for the webhook):

```sh
cloudflared tunnel --url http://localhost:5173     # the Mini App
cloudflared tunnel --url http://localhost:2567     # the game server + webhook
```

Then set `PUBLIC_CLIENT_URL` and `PUBLIC_SERVER_URL` to the tunnel URLs, point
the BotFather Web App URL at the client tunnel, and restart the server so it
re-registers the webhook. `ngrok` works identically.

### The stack

```sh
docker compose up -d postgres
cd packages/server
cp .env.example .env      # then fill in TELEGRAM_BOT_TOKEN
MIGRATION_DATABASE_URL=postgresql://pong:pong@localhost:5432/pong bun run db:migrate
bun run dev

# in another terminal (from the repo root)
bun run dev:client
```

`docker compose up` brings up the server too, if you prefer it containerised.

> Local Postgres is **not** a faithful Neon stand-in: it never scales to zero,
> so it never shows the cold-start latency that shaped `db/client.ts`. A green
> local run tells you nothing about the first query after an idle night.

### Testing the netcode honestly

```sh
COLYSEUS_LATENCY=75 bun run dev:server
```

75ms each way is a 150ms round trip — a realistic mobile-data figure. **Test
here, not on a bare localhost.** Smoothness at 0ms proves nothing; the whole
point of the prediction layer is what happens at 150.

The automated version of this is
`packages/client/test/prediction.integration.test.ts`, which asserts the
rollback correction stays at zero under that latency with ~8% of inputs
dropped.

---

## Deploying

### Neon

1. Create a project in **Frankfurt** or **Amsterdam** — the audience is
   primarily Russian-speaking, and this must match the fly region.
2. Take **both** connection strings. The pooled one (`-pooler` in the host)
   goes in `DATABASE_URL`; the direct one goes in `MIGRATION_DATABASE_URL`.
   The pooler cannot hold the session advisory lock a migration needs.
3. `bun run db:migrate`

### fly.io

```sh
fly launch --no-deploy          # fly.toml is already written
fly secrets set \
  TELEGRAM_BOT_TOKEN=... TELEGRAM_BOT_USERNAME=... TELEGRAM_APP_NAME=pong \
  TELEGRAM_WEBHOOK_SECRET=... PUBLIC_SERVER_URL=https://<app>.fly.dev \
  PUBLIC_CLIENT_URL=https://<app>.vercel.app \
  DATABASE_URL=... SESSION_SECRET=...
fly deploy
```

`fly.toml` sets `min_machines_running = 1` and `auto_stop_machines = false`.
**Do not change either.** A Colyseus room lives in the memory of one machine;
if fly stops it, every open invite and every live match dies with it — and an
invite tapped an hour later has to still be there.

### Vercel

Point Vercel at `packages/client` (`vercel.json` handles the monorepo build)
and set `VITE_SERVER_URL` to the fly URL.

`vercel.json` sets `no-cache` on `index.html` and `immutable` on the hashed
assets. Telegram's webview caches aggressively enough that without this pairing
a deploy can stay invisible for hours.

---

## How it works

### Netcode

30 Hz fixed timestep via `setFixedTimestep`, with `patchRate` pinned to the
same 33.33ms — Colyseus' 50ms default against a 33.33ms tick produces a
repeating 3:2 beat the eye reads as the ball hitching.

The client uses Colyseus 0.18's built-in prediction: one `SimReconciler` over
the whole world, running the *same* `stepWithInput()` from `game-core` that the
server's tick runs. **Every call into the prediction API is confined to
`packages/client/src/net/predictionAdapter.ts`** — 0.18 is the last release
before 1.0 and those APIs are still iterating, so a version bump is a change to
one file.

Determinism is a hard requirement, not a preference: rollback on a
non-deterministic simulation produces a visible stutter on *every* correction.
The tick therefore uses only `+ - * /`, comparison, `Math.sqrt` and
`Math.imul`, seeds its PRNG from the room code, and keeps that PRNG state in
replicated state so a replayed serve draws the same direction.

### Controls

Finger tracking along the field; the paddle follows X. Not buttons. Vertical
orientation, paddles top and bottom, because phone screens are narrow.

The client sends a **desired** paddle position and the server moves the paddle
under a hard speed cap. That one rule eliminates the teleporting-paddle cheat,
and it lives in `game-core` so client prediction and server truth agree by
construction — an honest client never sees a correction on its own paddle.

`touch-action: none` plus `disableVerticalSwipes()` is what stops a downward
drag from scrolling the page or pulling the Mini App closed mid-rally.

### Asynchronous rooms

With no AI opponent, invite links are often tapped much later. An open room
persists about an hour, and when someone joins, the bot messages the inviter
that their opponent is waiting. Without this, most invites die silently.

### Anti-cheat

Server authority, plus:

- Paddle speed cap in shared code (above).
- `sanitize: { targetX: [0, FIELD_W] }` on the input buffer, and a `NaN` scrub
  in `game-core` — a `NaN` reaching the simulation never recovers.
- `maxMessagesPerSecond` on the room; excess disconnects.
- `initData` validated once, exchanged for a short-lived token.
- Room creation rate-limited per user per hour.
- Only the server writes match results.

The one cheat that survives is a script that tracks the ball perfectly — every
input it sends is individually legal. It cannot be caught in realtime, so it is
caught offline: every match's input trace is recorded (~30 kB), and
`tools/cheat-detection` computes reaction-lag distributions nightly. **A flag
excludes a player from leaderboards. It never bans.** False positives on strong
players are certain.

### Rating

There is none, deliberately. All Phase-1 matches are invite-only between people
who chose each other, which makes collusion indistinguishable from normal play
— a global rating here is unprotectable by any algorithm. Instead: head-to-head
records per pair, per-chat leaderboards by win count, and rank-free profile
stats. Every match is tagged `origin = 'invite' | 'pool'` so a future rating can
be computed exclusively from pool matches without a backfill.

---

## Acceptance test

Automated tests cover determinism, `initData` validation, the speed cap, and
prediction under latency. The following needs two phones on mobile data:

- [ ] Account A creates a room and shares the invite into a group chat
- [ ] Account B taps it and joins
- [ ] Both play a full match; the ball is visibly smooth, no rubber-banding
- [ ] The server writes the result
- [ ] A shares the result card via the native picker
- [ ] B taps rematch and a new room opens
- [ ] Each account sees its own Telegram language
- [ ] Head-to-head record and chat leaderboard both update
- [ ] Killing one client's network for five seconds mid-match pauses the game
      for **both** players and resumes cleanly on reconnect

The last one is worth doing deliberately: turn on airplane mode for five
seconds, not close the app.

---

## Instrumentation

The whole funnel is logged to `events`: `launch`, `referrer_present`,
`chat_context_present`, `room_created`, `invite_shared`, `opponent_joined`,
`match_started`, `match_completed`, `disconnect`, `reconnected`,
`share_tapped`, `share_message_sent`, `share_message_failed`,
`rematch_tapped`. Without these the project is unfalsifiable.
