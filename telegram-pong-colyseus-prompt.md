# Build Prompt: Realtime Pong — Telegram Mini App on Colyseus

Copy everything below the line into your coding agent (Claude Code, Cursor, etc.).

---

## Role

You are building a production-ready Telegram Mini App: realtime 1v1 Pong, on a multi-game platform foundation.

Work incrementally. Stop and ask before making architectural choices that are expensive to reverse. Do not add features I did not ask for.

## Product concept

Two people play Pong against each other in realtime inside Telegram. One player drops an invite link into a chat; whoever taps it first becomes the opponent. When the match ends, the winner gets a shareable result image that goes back into the chat, which produces the next invite.

**There is no AI opponent.** Matches are only ever human against human. This is a product decision, not an oversight.

Pong is the first game on the platform, not the product. Judge every decision against two questions: does this make someone more likely to invite another person, and does this still hold when a second game is added?

## Scope — Phase 1

1. Colyseus room for Pong, with a shared deterministic simulation.
2. Netcode good enough that the ball is smooth on mobile data.
3. Invite flow: link into a chat, first tapper joins, match starts.
4. Head-to-head records and per-chat leaderboards. **No global rating.**
5. Shareable post-match result image.
6. Anti-cheat as specified below.
7. Localization, Russian and English.

**Explicit non-goals.** Do not build: an AI opponent, random matchmaking, global rating or ELO, crypto/TON/wallets, tap-to-earn, energy or lives systems, Telegram Stars payments, admin panels, tournaments, in-game chat, spectator mode, RTL layout. If you believe one is necessary, stop and explain rather than build.

## Fixed stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces, TypeScript throughout |
| Frontend | React + TypeScript + Vite, scaffolded via `npx @telegram-apps/create-mini-app` |
| Telegram SDK | `@telegram-apps/sdk` + `@telegram-apps/sdk-react` |
| Game server | **Colyseus 0.18**, `uWebSockets.js` transport |
| Bot | grammY, **webhook mode only** |
| ORM | Drizzle (integrated with Colyseus 0.18 tooling) |
| Database | Neon (serverless Postgres) |
| Hosting | Frontend on Vercel; game server + bot on fly.io, **one machine** |

**Critical:** do not additionally load Telegram's single-file `telegram-web-app.js`. Mixing it with `@telegram-apps` packages causes subtle failures. Tutorials using `window.Telegram.WebApp` directly must be rewritten against the SDK.

### Colyseus version discipline

- Pin **0.18** explicitly. Prediction, rollback, interpolation and lag compensation are built in as of 0.18; older documentation and FAQ pages state that prediction is not provided — those pages describe earlier versions. Verify you are reading 0.18 docs.
- **Never mix Colyseus package versions** in `package.json` — this is a documented source of confusing errors.
- Set `"useDefineForClassFields": false` in tsconfig when targeting ES2022 or newer, otherwise `@type()` decorators fail to define property accessors correctly.
- 0.18 is the last release before 1.0 and its prediction APIs are new and still iterating. **Isolate every call to the prediction API behind a thin adapter layer** so a version bump does not spread across the client.

## Monorepo layout

```
packages/
  game-core/      # shared deterministic simulation + types + constants
  server/         # Colyseus rooms, bot, HTTP API
  client/         # React Mini App
```

`game-core` is imported by both server and client. This is the whole reason the backend is TypeScript: rollback reconciliation requires both sides to run an identical deterministic simulation, and Colyseus' own tutorial recommends sharing one implementation across both.

Nothing game-specific may live outside `game-core` and the room class. Adding a second game must mean: a new module in `game-core`, a new Room class, a new React component — and no edits to auth, invites, sharing, stats or i18n.

## Colyseus room design

- One Room class per game, registered by name: `gameServer.define("pong", PongRoom)`. That registration is the game registry — do not build a second one.
- Game loop via `setSimulationInterval((dt) => this.update(dt))`. Default is 60fps; **set it to 30 Hz**.
- **Set `patchRate` explicitly.** The default sends state patches every 50ms (20fps), which will not match a 30 Hz tick. Mismatched tick and patch rates cause visible artifacts.
- Room state via Schema. Use `StateView` for per-client visibility — not needed for Pong, but establish the pattern now, because hidden-information games are the reason the platform exists.
- Authenticate in `onAuth`: validate raw `initData` there, reject before the room is entered.
- Reconnection via `allowReconnection(client, 30)` in `onDrop`, restoring in `onReconnect`. Mark the player disconnected in state, pause the match for both with a visible countdown, award a technical win on timeout. **Do not hand-roll a grace period** — the framework has one.

## Simulation and netcode

- **Fixed timestep, fully deterministic.** No `Math.random()` in the tick — seed the room and use a seeded PRNG from `game-core`. Be deliberate about floating point. Rollback reconciliation on a non-deterministic simulation produces a visible stutter on every correction, so determinism is a hard requirement, not a preference.
- Use Colyseus 0.18's built-in prediction, rollback, interpolation and lag compensation. Do not write your own clock sync, snapshot buffer or reconciliation loop.
- Reference implementations of exactly this pattern on 0.18: the Colyseus Karts demo (fixed timestep, prediction with rollback, lag-compensated hits) and ColyStrike (30 Hz authoritative server, fixed-delay interpolation). Study their approach; ColyStrike's source is paid, so use it as a behavioural reference only.
- Test under simulated 150ms RTT and packet loss before declaring this stage done. Smoothness on localhost proves nothing.

**Controls.** Finger tracking along the lower screen area; the paddle follows X. Not buttons. Vertical orientation — paddles top and bottom, since phone screens are narrow. Verify touch handling does not scroll the page or dismiss the Mini App. Respect Telegram theme params and safe-area insets.

**Empty-room problem.** With no AI opponent, invite links are often tapped much later. Rooms must be asynchronous: an open room persists about an hour, and when someone joins, the bot messages the inviter that their opponent is waiting. Without this, most invites die silently.

## Infrastructure

Single fly.io machine: `min_machines_running = 1`, auto-stop disabled. Pong load is negligible; one machine holds hundreds of concurrent rooms.

Design for later scale-out without building it: a room id must carry its machine id so a second player can be routed via `fly-replay`. Do not introduce Redis — at this size it only adds latency.

- **No blocking or database work inside a tick.** Persist match results after the match ends.
- **Neon:** use the pooled (pgbouncer) connection string. Neon scale-to-zero adds wake latency to the first query after idle — never block app startup or match start on a cold query.
- Colocate the fly region and the Neon region (Frankfurt or Amsterdam for a primarily Russian-speaking audience).
- Vercel and fly are different origins: configure CORS explicitly. Telegram's webview caches aggressively — set cache headers so deploys are visible.
- HTTPS is mandatory for Mini App URLs. Provide a Dockerfile and docker-compose, and document local HTTPS tunneling.

## Anti-cheat

Colyseus gives server authority; enforce the rest yourself:

- The client sends a **desired paddle position**; the server moves the paddle under a hard speed cap. This one rule eliminates the teleporting-paddle cheat. It must live in `game-core` so client prediction and server truth agree.
- Rate-limit inbound messages and silently drop excess.
- Validate `initData` in `onAuth` with HMAC-SHA256 against the bot token, rejecting stale `auth_date`. Then issue our own short-lived token — a stolen `initData` otherwise stays usable for a day.
- Only the server writes match results. Never accept a result from a client.
- Rate-limit room creation per user.

The one real remaining cheat is a script that tracks the ball perfectly. It cannot be caught in realtime; catch it offline:

- Log the full input trace of every match (kilobytes for Pong).
- A nightly batch job computes per-player features: reaction latency distribution after ball direction changes, RMS tracking error, overshoot frequency, idle fraction. Humans react in roughly 200–250ms with high variance and frequent overshoot; scripts react in tens of milliseconds with near-zero variance. This job may be a separate Python worker if that is easier — it is offline and shares no code with the server.
- **Never auto-ban.** A flag means exclusion from leaderboards, not a block. False positives on strong players are certain.

## Rating and leaderboards

**Do not build a global rating in Phase 1.** All matches are invite-only between people who chose each other, which makes collusion indistinguishable from normal play. A global rating here is unprotectable by any algorithm.

Instead:

- **Head-to-head records** per pair ("12:7 against @vasya"). Farming a friend is pointless — visible only to those two, unlocks nothing.
- **Per-chat leaderboards** by win count. Manipulation inside a chat is policed by the chat's own members.
- **Profile stats** with no rank: matches played, win rate, longest rally, best streak.

A global rating arrives only once a random matchmaking pool exists, computed **exclusively from pool matches**. Leave the seam: tag every match with its origin (`invite` or `pool`) from day one. Build nothing else for it now.

Chat identity comes from `chat_instance` in `initData`, returned only for Mini Apps opened by direct link. Sessions from the bot menu or `/start` have no chat context — fall back to profile and head-to-head. `chat_instance` is opaque, so the UI says "this chat", never a name. Use `chat_type` to suppress chat leaderboards in solo conversations.

**Verify before building on it:** deploy a throwaway page dumping raw `initData`, open it via direct link from two different group chats with two accounts, on mobile and desktop. Confirm `chat_instance` is identical within a chat and differs across chats — a past Telegram Desktop bug reported otherwise. Report results before implementing chat leaderboards.

## Viral loop

**Invite.** `t.me/<bot>/pong?startapp=<payload>` posted into a chat; the payload carries room code and referrer. Payload alphabet is limited to `A-Z a-z 0-9 _ -`, so base64url-encode and keep it short. Read it via the SDK start param. First tapper takes the open slot.

**Attribution.** On a new user's first launch, record the referrer, write-once. Never overwrite.

**Result image.** Render server-side from an **SVG template with values substituted, rasterized via resvg**. Do not use a headless browser — a CPU spike on this machine stutters the 30 Hz tick of every live match. Render off the game loop entirely. Cache by match id; upload once through the bot and reuse the returned `file_id`.

Card content: score in very large numerals, both avatars, an emoji. Almost no words — it will be read by people whose language differs from the sharer's, and terse cards travel further.

**Sharing.** Bot API 8.0 prepared messages: the backend calls `savePreparedInlineMessage` with the photo and a "Rematch" button; the frontend calls `shareMessage(id)`, giving the user a native chat picker. The prepared message id is **single-use** — prepare a fresh one on every share tap. Do not use `switchInlineQuery`; it is the older, worse flow.

**Rematch** is the retention mechanic that matters. Every result screen and shared card carries a rematch button opening a fresh room with the same opponent.

**Instrumentation.** Log the whole funnel: launch, referrer present, chat context present, room created, opponent joined, match started, match completed, disconnect, share tapped, `shareMessageSent`, `shareMessageFailed`, rematch tapped. Without these the project is unfalsifiable.

## Localization

- Detect language from `user.language_code` in `initData`. It is signed, so trustworthy server-side, and matches what the bot sees in `from.language_code`.
- Frontend: `i18next` + `react-i18next`, initialized **explicitly** from `initData`. Do not use the browser language detector — it misreads the webview.
- Bot: a plain object of strings is enough. No gettext machinery.
- The field is optional and may carry a region (`pt-br`, `en-gb`). Resolve: exact tag → base language → English. Never render an empty string.
- Allow a manual override and persist it. Priority: explicit choice → `language_code` → English.
- Format numbers with `Intl.NumberFormat` on the resolved locale.
- Ship `ru` and `en`, structured so a new language is one JSON file. No hardcoded user-facing strings.

## Deliverables

- Working monorepo: `game-core`, `server`, `client`, Dockerfile, compose file.
- README: BotFather setup, environment variables, local HTTPS development, deploys to Vercel and fly.
- Tests for: `initData` validation, `game-core` determinism (same seed and inputs produce identical state on repeated runs), and paddle speed-cap enforcement.
- A one-page note listing every assumption made where my instructions were ambiguous.

## Acceptance criteria

From two phones on mobile data: account A creates a room and shares the invite into a group chat; account B taps it and joins; both play a full match with a visibly smooth ball and no rubber-banding; the server writes the result; A shares the result card via the native picker; B taps rematch and a new room opens. Each account sees its own Telegram language. Head-to-head record and chat leaderboard both update. Killing one client's network for five seconds mid-match pauses the game and resumes cleanly on reconnect.

## Working style

Something runnable at the end of each stage:

1. Verify `chat_instance` behaviour and report back.
2. Propose the monorepo layout, the `game-core` interface as actual code, and the data model. **Wait for my approval.**
3. `game-core` Pong simulation with determinism tests. No network.
4. Colyseus room, two browser tabs on localhost, no Telegram.
5. Prediction, rollback and interpolation via the 0.18 APIs. **Test under 150ms simulated latency and packet loss before proceeding.**
6. Telegram integration: `onAuth`, invites, async rooms, reconnection.
7. Stats, head-to-head, chat leaderboards.
8. Result image and sharing.
9. Anti-cheat logging and the offline detection job.
10. Localization pass.

Do not skip ahead. Stage 5 determines whether this product works at all — do not treat it as polish.
