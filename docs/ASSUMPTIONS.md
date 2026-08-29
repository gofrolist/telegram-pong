# Assumptions and deviations

Every place the brief was ambiguous, silent, or contradicted by the shipping
libraries. Each entry says what was decided and why, so you can overrule any of
them cheaply.

Items marked **DEVIATION** contradict something the brief stated explicitly.
Those are the ones to read first.

**Versions in use, cross-checked against `docs.colyseus.io/migrating/0.18` and
the `colyseus/colyseus` master branch:** `colyseus@0.18.5`,
`@colyseus/core@0.18.10` (peer `@colyseus/schema ^5.0.8`),
`@colyseus/uwebsockets-transport@0.18.2`, `@colyseus/tools@0.18.3`,
`@colyseus/sdk@0.18.2`, `@colyseus/schema@5.0.23`. `colyseus.js` is not
installed. The other 0.18 breaking changes — `setMetadata` now replacing rather
than merging, `client.id` removed, the 63-field Schema cap, fossil-delta
removal — do not apply: none of those APIs are used, and the largest Schema
here has 9 fields.

---

## DEVIATION 1 — the client package is `@colyseus/sdk`, not `colyseus.js`

The brief's stack table implies the usual `colyseus.js` client. That package
was **renamed `@colyseus/sdk` in 0.17**. `colyseus.js` is still published and
npm's `latest` tag still points at `0.16.22`, which:

- bundles `@colyseus/schema@3.x`, while a 0.18 server requires `^5.0.8` — the
  wire format differs, so the two cannot talk at all; and
- exports no `Predict`, `Reconciler` or `SimReconciler`, so there is no
  prediction API on it.

Installing the package the brief implies produces a client that silently
cannot connect. We use `@colyseus/sdk@0.18.2`.

## DEVIATION 2 — 0.18 API names in the brief are pre-0.18

The brief specifies `gameServer.define("pong", PongRoom)` and
`setSimulationInterval`. In 0.18:

| Brief | Actual 0.18 |
|---|---|
| `gameServer.define(name, Room)` | `defineServer({ rooms: { pong: defineRoom(PongRoom) } })` |
| `setSimulationInterval(dt => …)` | `setTimestep` (variable dt) / **`setFixedTimestep(step, tickRate)`** (fixed dt) |
| — | `this.defineInput(Schema, opts)` for per-client input buffers |
| — | `this.allowRewindState(opts)` for lag compensation |

We use `setFixedTimestep(step, 30)`. It is the one that pairs with prediction:
it advertises the tick rate to predicting clients through the join handshake,
so client rollback replays at exactly the server's `dt`. `setSimulationInterval`
would hand the room a jittery wall-clock delta and break determinism.

## DEVIATION 3 — the Schema is declared with `schema()`, not `@type()`

The brief calls for `"useDefineForClassFields": false` so `@type()` decorators
work. That is correct advice for `tsc`, and insufficient here.

`packages/game-core/src/net/state.ts` is compiled by **three** toolchains: `tsc`
(type check), esbuild via `tsx` (dev server and tests), and Vite/Rollup (the
Mini App). Only `tsc` honours `experimentalDecorators`. The others emit
ES-standard decorators, which `@colyseus/schema` does not implement, and the
result is a runtime `TypeError: Cannot read properties of undefined (reading
'constructor')` at import — observed, not theorised.

Schema 5 ships a declarative builder that is a plain function call:

```ts
export const Ball = schema({ x: t.float32().default(50) }, 'Ball');
```

Identical behaviour under every toolchain, and the `useDefineForClassFields`
footgun disappears entirely because there are no class fields. `tsconfig` still
sets `useDefineForClassFields: false` so that adding a decorator later does not
silently misbehave.

## DEVIATION 4 — input mode is `reliable`

The brief does not specify, but the natural reading of "packet loss" suggests
unreliable delivery with redundancy. Colyseus' `mode: "unreliable"` requires a
transport with a **datagram channel**, which only `@colyseus/h3-transport`
(WebTransport, experimental) provides. Over the uWebSockets transport the brief
mandates, asking for `unreliable` gets the redundancy silently dropped and a
warning logged on every client — observed in testing.

Loss is instead absorbed server-side by `defineInput(..., { idle: true })`,
which repeats a player's last command on a tick that arrives empty. That is the
behaviour the redundancy was for.

## DEVIATION 5 — the Schema classes live in `game-core`, not the room

The brief says nothing game-specific may live outside `game-core` and the room
class. The Schema state is game-specific, so the room would be its natural
home — but the *client* needs the identical classes to decode state, and a
client-side copy that drifts from the server's is a desync that appears only
under load and only on the field they disagree about.

They live in `@pong/game-core/net`, a **separate entry point** so that
importing `@pong/game-core` still pulls in the dependency-free simulation and
nothing else. Only code that actually talks to Colyseus pays for
`@colyseus/schema`, which is pinned to an exact version (`5.0.23`) in both
packages — mixing Colyseus package versions is a documented source of
confusing errors.

## DEVIATION 6 — the room validates our session token, not raw `initData`

The brief says to validate raw `initData` in `onAuth`, and separately to issue
our own short-lived token because a stolen `initData` stays usable for a day.
Doing both means `initData` crosses the wire on every socket, which is the
exposure the short-lived token exists to remove.

So: `POST /api/auth` is the **only** endpoint that accepts `initData`. It
validates the HMAC, checks `auth_date` against a 15-minute window (Telegram's
own default is a day; the Mini App re-mints `initData` on every launch, so a
short window costs honest users nothing), and returns a token. The room's
`static onAuth` validates that token and rejects before a seat is taken, which
is the property the brief actually wanted.

---

## Netcode

- **Tick 30 Hz, `patchRate` pinned to 33.33ms.** As instructed. Colyseus'
  default 50ms against a 33.33ms tick lands patches after one tick, then two,
  in a repeating 3:2 pattern the eye reads as the ball hitching.
- **One reconciler over the whole world**, via `predict.sim()`, not one per
  entity. Pong is a shared world: the ball's next position depends on both
  paddles, so a per-entity reconciler would replay my paddle correctly and
  still get the ball wrong.
- **The opponent's paddle is replicated with its `targetX`**, not just its
  position. During rollback the client re-runs both paddles through the shared
  speed-capped move; without the target it would have to guess where the
  opponent was heading and the ball would diverge on every replay.
- **`attachPrediction` is async.** It waits for the first decoded state patch.
  `joinById` resolves when the seat is confirmed, which is strictly earlier —
  and on a 150ms link, meaningfully earlier. Binding a reconciler to the
  locally auto-instantiated placeholders is rejected by the SDK.
- **Measured result** (`packages/client/test/prediction.integration.test.ts`,
  150ms simulated RTT, ~8% of inputs dropped): **maximum rollback correction
  0.000 units.** Ball prediction runs ~9 units ahead of replicated truth, which
  is the expected lead for 150ms at the ball's speed, not error.

## Game rules (the brief specifies none)

| Decision | Value | Why |
|---|---|---|
| Field | 100 × 180 units | Portrait, ≈9:16.2. Paddles top and bottom. |
| Match length | First to 7, no win-by-2 | Short matches produce more rematches, and rematch is the retention mechanic. |
| Paddle speed cap | 190 units/s | Fast enough to cross the field in ~0.4s; slow enough that positioning is a skill. |
| Ball | 62 → 132 units/s, ×1.045 per hit | A rally accelerates but stays trackable. |
| Serve | Toward the player who just **scored** | The player who conceded gets the breather. |
| Countdown | 1s between points, 3s at match start, 2s after a reconnect | A returning player needs the same beat to find their paddle that a serve gives them. |
| Bounce | Angle skewed by contact offset (`BOUNCE_SKEW = 0.85`) | Centre hit returns straight; edge hit cuts. Pure reflection would make it a game of nothing. |

Determinism constraints that shaped these: the tick uses only `+ - * /`,
comparison, `Math.sqrt` and `Math.imul`. No `Math.sin`/`cos`/`pow`/`atan2` —
those are implementation-defined and may differ between V8 on the server and
JavaScriptCore in Telegram's iOS webview. Serve directions are a precomputed
unit-vector table for the same reason.

Collision is **swept, not discrete**: at 30 Hz and top speed the ball covers
more than twice the paddle thickness per tick, so an overlap test would let it
tunnel through a paddle. Covered by a test that rallies for 30 000 ticks
against two perfect trackers and asserts nobody ever scores.

## Product decisions

- **Both players see themselves at the bottom.** A paddle you steer with your
  thumb has to be near your thumb. The flip is applied in the renderer only —
  the simulation is never mirrored, because a mirrored simulation is not the
  same simulation and rollback would fight it.
- **The host always defends the bottom side** internally (`side` 0); the guest
  is `side` 1. Only the view differs.
- **A rematch room is reserved for one person.** Anyone else who taps that link
  finds the seat taken rather than hijacking the match.
- **The rematch room is opened at share time**, not when the recipient taps, so
  the button in a shared card is live the moment it lands in the chat.
- **An expired or full invite lands on the home screen**, never on an error —
  the tap is itself a conversion opportunity.
- **Chat leaderboards are behind `CHAT_LEADERBOARDS_ENABLED`**, default off
  until `docs/CHAT-INSTANCE-VERIFICATION.md` has been run. See that document.
- **`chat_type` of `sender` or `private` suppresses the chat leaderboard.** A
  "chat leaderboard" between two people is head-to-head, said worse.

## Package manager: Bun installs, Node runs

Bun (`1.3.14`) is the package manager and script runner. The **server runtime
is still Node**, and that split is deliberate rather than incidental:
`uWebSockets.js` is a Node native addon (`.node` binaries built against a
specific `NODE_MODULE_VERSION`), and the whole netcode stack sits on top of it.
The Docker image mirrors the split — bun in the build and dependency stages,
plain Node at runtime, with bun never shipped in the final image.

Node's own `--env-file-if-exists` and `--conditions` flags are used rather than
a dotenv package or a bundler condition, so nothing about environment loading
or workspace resolution depends on which package manager is in use.

## Container and deploy (verified by building and running the image)

- **The base image must be Debian trixie, not bookworm.** `uWebSockets.js`
  ships *prebuilt* `.node` binaries linked against **glibc 2.38**. Bookworm has
  2.36. A bookworm image builds and pushes perfectly, then dies on the first
  container start with `GLIBC_2.38 not found` — i.e. the failure appears in the
  deploy, not in CI. Trixie ships glibc 2.41. Observed and fixed.
- **No compiler toolchain is needed.** Because uWS ships prebuilts, the
  `python3 make g++` the first draft installed was dead weight; `git` and
  `ca-certificates` are enough (uWS is fetched as a GitHub tarball).
- **Production dependencies get their own build stage.** Pruning in place
  (`install --prod` over an existing tree) only rewrites the link tree — it
  leaves the dev packages on disk. `vitest`, `typescript`, `drizzle-kit` and
  three copies of `esbuild` were all still in the image (~90MB) until the
  install was moved to a separate stage that starts from the lockfile.
- **All three workspace manifests are copied into the image, but only the
  server's dependencies are installed.** `bun install --frozen-lockfile`
  compares workspace *membership* against the lockfile, so omitting the Mini
  App's `package.json` reads as "the lockfile changed" and fails the build.
  `--filter '@pong/server'` then scopes the install, so React and Vite never
  enter the image. `.dockerignore` re-includes exactly that one file.
- **uWS's prebuilt binaries are pruned to the one this image loads.** It ships
  twenty (four Node ABIs × five platforms), ~114MB, of which exactly one is
  ever `require`d. The prune step asks Node for its own
  `platform`/`arch`/`versions.modules` so it stays correct on both arm64 and
  x64, and fails the build if the required binary is missing. Frees 107MB.
- Net effect: image 752MB → 544MB, `node_modules` 280MB → 131MB.
- **`TELEGRAM_REGISTER_WEBHOOK` exists so a laptop cannot steal production's
  updates.** `setWebhook` is global per bot token: a local server that
  registers itself silently takes every update away from the deployed one.
  Defaults on; `.env.example` sets it off.

## Storage and infrastructure

- **Room-creation rate limiting lives in Postgres**, not Redis. The brief
  forbids Redis at this size; the counter is touched once per room creation,
  not once per tick. A failed counter write returns "allowed" — the cap is an
  abuse control, not a correctness invariant, and it must not lock a user out
  because a database was cold.
- **Input traces are `jsonb`, quantised to 16-bit.** A match is under 30 kB, so
  object storage would add an integration for no benefit.
- **`rooms.id` is the public `<machine>-<code>`; `rooms.colyseus_room_id` is
  Colyseus'.** Kept separate so the invite link never changes shape if Colyseus
  changes its id format. The machine prefix is unused today (one machine) and
  exists so a second machine is a `fly-replay` header, not a migration.
- **Analytics are batched and fire-and-forget.** `recordEvent` cannot reject.
- **`/healthz` never touches the database.** A cold Neon compute takes seconds
  to wake, and a health check that waited on one would fail a deploy after a
  quiet night. Proven by a test that runs the whole server against an
  unreachable database.
- **Migrations use the DIRECT Neon connection string**, not the pooled one:
  pgbouncer in transaction mode cannot hold the session advisory lock a
  migration needs. `src/db/migrate.ts` warns if handed a pooled URL.

## Things deliberately NOT built

Per the brief's non-goals: no AI opponent, no random matchmaking, no global
rating or ELO, no crypto/TON/wallets, no tap-to-earn, no energy or lives, no
Stars payments, no admin panel, no tournaments, no in-game chat, no spectator
mode, no RTL.

Two seams are left open, and nothing more:

- `matches.origin` is `'invite' | 'pool'` and every row is tagged from day one,
  so a future global rating can be computed **exclusively** from pool matches
  without a backfill.
- `StateView` is unused — Pong has no hidden information — but the room is
  structured so per-client visibility is a change to one class. Hidden-
  information games are the stated reason the platform exists.

## The result card's centre mark is drawn, not an emoji

The brief asks for "an emoji" on the card. Rendering one produced a tofu box:
resvg sets text with whatever fonts the image carries, and an emoji font is
large and inconsistently supported. A card shared into a chat cannot risk that,
so the mark is two paddles and a ball drawn as SVG geometry — still wordless,
still travels across languages, and renders identically everywhere. Latin and
Cyrillic names render correctly from `fonts-dejavu-core`, which the Dockerfile
installs; without `fontconfig` and a font the card's text renders blank.

## Known gaps

- **`chat_instance` is unverified.** Stage 1 needs two Telegram accounts, two
  group chats, and a deployed page; it cannot be run from here. The probe is
  built (`?debug=initdata`) and the matrix is written. Chat leaderboards ship
  disabled.
- **Packet loss is simulated at the sender**, by skipping `input.send()` on
  ~8% of frames. That exercises the server's idle-input path but is not the
  same as losing datagrams in flight, and `COLYSEUS_LATENCY` is a fixed delay
  with no jitter. The two-phones-on-mobile-data acceptance test is still the
  one that counts.
- **`prepareShare` uploads the card by sending it to the sharing user and
  immediately deleting the message.** Telegram has no upload-without-send API.
  The user may briefly see a notification. A dedicated private channel as an
  upload sink would avoid this and is the usual production fix.
- **No load test.** One machine is claimed to hold hundreds of rooms; that
  number is from the brief, not measured here.
- **Inline mode is off on the bot.** `savePreparedInlineMessage` — the whole
  share flow — requires it. Run `/setinline` in BotFather before testing a
  share. Nothing in the code can detect this ahead of the first share attempt;
  it surfaces as a 400 from the Bot API, which `prepareShare` turns into
  `share_unavailable` rather than a crash.
- **The image is built and verified on arm64 only.** The uWS prune is
  arch-agnostic by construction, but a fly deploy targets x64 and has not been
  run.
