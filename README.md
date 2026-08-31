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
  server/      Colyseus rooms, bot, HTTP API, and the built Mini App
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
   `t.me/<bot>/<app>`. Set the Web App URL to the **server's** own origin
   (`https://<app>.fly.dev/`) — one deployment serves the app and the socket.
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
| `PUBLIC_CLIENT_URL` | **Optional.** Defaults to `PUBLIC_SERVER_URL`, which is right whenever the server serves the app. Set it only for a client on a different origin — Vite's dev server, or a tunnel. |
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

### Git hooks

```sh
brew install pre-commit   # or: pipx install pre-commit
pre-commit install
```

Every commit then runs gitleaks, whitespace and JSON/YAML checks, actionlint
over `.github/`, ruff over `tools/`, `tsc` across all three packages, the
game-core suite, and a `--frozen-lockfile --dry-run` check that `bun.lock`
still matches the manifests. The whole thing is a couple of seconds; the server
and client suites are deliberately left to CI, where their ~35s is affordable.

The same hooks run as the `pre-commit` job in CI (minus the three that are
already jobs of their own), because a local hook is one `--no-verify` away from
never having run — and a leaked bot token is not fixable by a later commit.

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

`PUBLIC_CLIENT_URL` matters here and only here: locally the app is on Vite and
the server is somewhere else, which is the one arrangement that needs the CORS
allowlist to know a second origin. In production it is left unset.

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

### Two bots, and a number for "it feels laggy"

```sh
bun run --filter @pong/client bots                     # 0 / 150 / 300ms RTT
bun run --filter @pong/client bots --latency 150 --matches 3 --out report.json
```

Spawns a real server, seats two headless clients that chase the ball, and
plays. The headline column is **wobble**: the frame-to-frame change in the
*drawn* ball's velocity while it is in open field, as a fraction of its own
speed. In open field the ball travels in a straight line by definition, so any
change there is an artifact of how it was drawn, and a perfect render scores
zero.

That metric exists because the integration test cannot express the complaint
that produced it. The test asserts that *corrections* stay small — a claim
about the simulation agreeing with the server — and a ball can satisfy it
completely while still looking wrong, because what a player sees is not the
simulation but the interpolated read of it.

**Check the instrument before believing it.** The first version of this
harness accumulated its frame clock instead of anchoring it to wall time,
which drifted 0.33ms per frame against the patch stream and produced a
convincing 21% p95 wobble that was entirely its own. Anchored, the same run
reports 0.0000.

**And check what it is not doing.** The same harness swept clean across every
latency while a real match was unplayable, because it seated both players in
the same millisecond — the one arrangement in which nobody ever waits on the
invite screen, and so the one arrangement in which the server's input buffer
never overflowed. `--host-wait` (default 3s) now plays that wait out, and the
`pend max` column reports the worst unacked queue: past the SDK's 64-entry
replay ring, rollback silently skips inputs and the prediction cannot be
correct no matter what the wobble says. With the host's wait modelled, the
buggy build scored 0.82 p95 wobble against 0.002 for the fixed one.

Four more columns, each answering a complaint the wobble figure could not:

- **`rtt ms`** — the round trip as the *client's own clock* measures it, beside
  the `rtt` this run injected. The two have to track, and for months they did
  not: the harness fed `COLYSEUS_LATENCY` a one-way delay when Colyseus reads
  it as a round trip, so every published figure was taken at half its stated
  latency. This column is the guard. The same number now rides home in the
  field summary, where it is the only way to read `pending` correctly — unacked
  inputs are the round trip PLUS a backlog, and only one of those is the
  network's fault.
- **`lead ms`** — how far ahead of confirmed server truth the drawn world runs.
  The ball is drawn from the predicted world and the score from the replicated
  one, so this IS the delay between watching the ball go past your paddle and
  the point appearing. ~170ms is invisible; the broken build ran at 2070ms,
  which a player reported as "the score is lagging".
- **`tgtlag~` / `tgt p95`** — how far the server's idea of your desired paddle
  X trails the one you just asked for, in field units. Zero for a player who
  holds still *however far behind the input stream is*, which is why the same
  bug gets reported as "it only goes wrong when I move".
- **`--paddle still|chase|sweep`** — how much the measured bot moves. Paddle
  motion is the axis those complaints are phrased in, so it has to be one the
  harness can turn.

**Check the instrument, again.** `sweep` was first written as a 2s square wave,
which aliased almost exactly against the 2.07s input delay it existed to
expose — the stale target kept landing one whole period back, on the same
value, and the *broken* build scored better than the fixed one. It is
aperiodic now. A periodic probe cannot measure a delay near its own period.

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
  DATABASE_URL=... SESSION_SECRET=...
fly deploy
```

`fly.toml` sets `min_machines_running = 1` and `auto_stop_machines = false`.
**Do not change either.** A Colyseus room lives in the memory of one machine;
if fly stops it, every open invite and every live match dies with it — and an
invite tapped an hour later has to still be there.

### The Mini App

There is no second deployment. The Dockerfile builds `packages/client` and
copies the bundle into the image, and the server serves it from `/` — the same
origin as `/api` and the WebSocket.

That is a deliberate trade. A CDN would win the first paint, but every rally is
bound to the fly region regardless, so the CDN would win the one request that
matters least while every `/api` call paid a cross-origin preflight to
Frankfurt. Same-origin also removes the CORS allowlist as a thing that can be
misconfigured, and makes the client and the server one versioned artifact:
there is no window in which a cached client talks to a server whose API moved.

`packages/server/src/http/staticClient.ts` owns what a static host would
otherwise configure — `no-cache` on `index.html`, `immutable` on the hashed
assets under `/assets/`, and `frame-ancestors` limited to telegram.org.
Telegram's webview caches aggressively enough that without that first pairing a
deploy can stay invisible for hours.

The build bakes in no server hostname: with `VITE_SERVER_URL` unset the client
calls `window.location.origin`, so the image is not tied to the domain it is
served from. Setting `VITE_SERVER_URL` at build time still points it elsewhere,
which is what `bun run dev:client` does.

### CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:
typecheck, the three test suites (one runner per package — the integration
tests assert against wall clock and go flaky when they share two cores), the
full build, and a Docker build that boots the image, curls `/healthz`, and
checks that `/` serves the Mini App shell with a reachable bundle. The
aggregate job is named `CI`; point branch protection at that one.

### Shipping to fly

Deploys are cut by publishing a GitHub Release — a push to `main` deploys
nothing:

```sh
gh release create v0.1.1 --generate-notes
```

`.github/workflows/fly-deploy.yml` then refuses to run unless `CI` was green
for that commit, builds the image, pushes it to fly's registry, runs
`build/db/migrate.js` **from inside that exact image**, deploys it by content
digest with `--ha=false`, and finally checks both that `/healthz` answers and
that the log says the Telegram webhook was registered — the second one matters
because a failed registration is deliberately non-fatal, so without the check a
deaf bot deploys green.

Two repository secrets are required:

| secret | value |
| --- | --- |
| `FLY_API_TOKEN` | `fly tokens create deploy -a telegram-pong` |
| `MIGRATION_DATABASE_URL` | Neon's **direct** connection string (not `-pooler`) |

The gate is deliberate rather than fussy: the app is one machine holding every
room in memory, so each deploy ends the live matches and drops the invites that
have not been tapped yet.

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

### What the far paddle costs

Prediction can only be exact about inputs the client has. It has its own, so the
local paddle and every bounce off it are predicted perfectly — measured at a
correction of **0.000** and zero mispredicted reversals, at every latency
tested. It has nothing for the opponent's, whose paddle is only ever as current
as the last patch.

That gap is geometry, and it has a number. The opponent's paddle crosses its own
12.3-unit contact zone in `12.3 / 190 = 65ms` of one-way latency. Past that,
whether the ball is coming back is genuinely unknowable on this device, and
predicting it is a coin flip that the server overturns one round trip later:

```
 rtt | wobble~ | ball corr max | mispredicted reversals / 30s
   0 |  0.0003 |          1.14 |  0
  60 |  0.0004 |          0.79 |  0
  87 |  0.0021 |          2.15 |  0     <- clean, under the 129ms cliff
 150 |  0.0332 |         58.08 | 18     <- over it
 207 |  0.1377 |         64.42 | 19
```

**These RTTs were relabelled on 2026-08-30 and the old ones are wrong.** The
harness handed `COLYSEUS_LATENCY` a one-way delay, and Colyseus reads that
variable as a *round trip* — so every run injected half the latency its report
claimed, and this table used to say 174 where the link was really 87. The
measurements themselves are unaffected; only the axis was. The fix is in
`harness/support.ts`, and the harness now prints the client's own `rtt ms`
beside the injected one so the two can never silently disagree again. Note
that the corrected axis puts the measured cliff either side of the 129ms the
geometry predicts, which the doubled one did not.

**The harness report's two RTT columns are still not the same quantity, and
the gap is about 110ms.** `rtt` is what the harness injects; `rtt ms` is what
`room.clock` measures on the client. Across 24 baseline matches on
2026-08-31 they ran 150 → 259, 200 → 305, 270 → 396. The excess is pipeline,
not link: `room.clock` times an INPUT round trip — send to ack — so the sample
carries the wait for the next 30Hz tick, the ack's ride back out on the next
patch, and every input still queued unacked ahead of the one being timed. The
first two are one 33ms interval each at worst and do not add up to 110; the
standing queue is the rest of it, which is why a bot match at **0ms** injected
latency already measures `rtt` ~74 against a `pendingMean` of 2.2-2.6 (see
Instrumentation). It matters in two places. The
geometry cliff — including `EVENT_PREDICTION_RTT_CEILING_MS` — is derived as a
pure network-staleness figure but compared at runtime against
`room.clock.smoothedRtt()`, so the event gate engages roughly 110ms earlier
than its own derivation implies. And a production `rttMean` of 271-297ms is
something closer to 160-190ms of actual network round trip. Neither is wrong
to measure; they are just two different numbers wearing one name.

Every one of those reversals is at the FAR plane; on the shipped constants the
near plane has never produced one, and the single exception ever measured came
from the wider-paddle experiment below. Two fixes were tried and measured, and
both were reverted:

- **Refusing to predict the far bounce** (hold the ball at the plane and wait to
  be told). Caps the worst positional error, 64 → 20, but adds a pause-and-release
  to every rally: wobble got 6x worse. The ball being occasionally wrong beats the
  ball being reliably jerky.
- **Retuning the correction easing.** `smoothMs` 65 is already the optimum;
  0 (snap) and 200 (long ease) both measured worse on drawn-ball smoothness.
- **A `snap` threshold** — the SDK's teleport cutoff, which pops a correction
  bigger than N instead of easing it out, so a mispredicted reversal is one cut
  rather than 65ms of the ball curving the wrong way. Swept off/8/15/100 over
  ten 30s bot matches per arm (`bun run bots --snap N`). Two findings, and the
  second is why it is not shipped:

  *Small thresholds do nothing,* because the smoothed pose mixes position and
  velocity fields and `snap` is all-or-nothing across them. A bounce corrects
  `ball.vx` by 100-230 units/s, so a threshold of 8 or 15 is tripped by nearly
  every reconcile and degenerates into `smoothMs: 0` — already known worse.
  Measured: median wobble 0.0082 off, 0.0126 at 8, 0.0084 at 15, none of it
  significant (Mann-Whitney |z| < 0.9). The SDK's sizing advice, "above
  `maxSpeed x patch interval`", silently assumes a position-only pose.

  *A threshold above the velocity noise floor helps at 87ms and hurts at
  150ms.* At 100 the effect at 87ms is a variance collapse rather than a shift
  — mean 0.0145 -> 0.0055, worst match 0.0465 -> 0.0068, four matches in ten
  over 0.015 -> none (variance ratio F(9,9) = 142). But at 150ms the same
  setting measured **4.5x worse**, 0.0109 -> 0.0488, with complete separation
  between the arms (Mann-Whitney z = -3.36; the best snap match was worse than
  the worst non-snap one). The reason is the trade itself: `snap` swaps a rare
  smooth-but-wrong glide for a hard cut, and at 150ms mispredictions stop being
  rare, so the ball pops constantly. A tuning that helps where the game is
  already fine and hurts where it is not is backwards, so it stays off.

  One caveat on the metric, since it flatters `snap`: wobble is sampled only in
  open field, and the pop lands at the far paddle (outside the band) while the
  glide's tail extends into it. The 87ms improvement is therefore an upper
  bound, and whether the cut itself reads badly is a question for eyes, not for
  this harness. `--snap` is wired through the harness so the sweep is
  repeatable; production leaves it unset.

**The wider, slower paddle was tried on 2026-08-31 and MEASURED — it does not
work.** This section used to say a wider, slower paddle moved the cliff to
277ms and was "7-10x smoother at 150-207ms", offered as a design decision
nobody had taken. It has now been taken, measured, and reverted, and the old
claim was wrong twice over.

*The 277 was arithmetic on a paddle that no longer exists.* It read
`(PADDLE_HALF_W + BALL_RADIUS) / speed` = `18 / 130`, which is the FLAT
paddle's contact zone. The face is an arc, so the real half-width is
`PADDLE_HALF_W * (PADDLE_ARC_R + BALL_RADIUS) / PADDLE_ARC_R` (`sim.ts`), and
the honest figure for 16/130 is 17.28 units and a **266ms** cliff. That
formula reproduces today's 129 exactly (`11 * 19 / 17 = 12.29`, `/190 = 65ms`
one-way), which is how it was caught.

*And the cliff did not move at all.* Eight 45s bot matches per cell,
`PADDLE_HALF_W` 11→16, `PADDLE_ARC_R` 17→25 (the ratio holds the 40° extreme
return angle; left at 17 the arc would have been `asin(16/17)` = 70°, ends
facing sideways), `PADDLE_MAX_SPEED` 190→130:

```
 rtt |  rev far / 45s  |     wobble~     | points / match
     |  base    16/130 |  base    16/130 |  base   16/130
 150 |  28.6 ->   25.5 | 0.0229 -> 0.0494| 3.0 ->    1.9
 200 |  29.4 ->   32.1 | 0.0226 -> 0.0418| 4.1 ->    2.2
 270 |  26.1 ->   20.0 | 0.0505 -> 0.0519| 8.0 ->    2.9
```

A cliff moved from 129 to 266 should have collapsed the 150 and 200 rows
towards zero. They did not move. What did move is the headline metric, the
wrong way: drawn-ball wobble roughly doubled at both, and matches took one and
a half to nearly three times as long to reach seven points (points/match 3.0 →
1.9, 4.1 → 2.2, 8.0 → 2.9).

The mechanism is the one this section already describes, read forwards. A
paddle spanning a third of the field stops rallies ending — mean rally length
went 5.4 → 10.2 hits at 150ms — and a longer rally is a rally that spends more
of itself near `BALL_MAX_SPEED`, because `BALL_SPEEDUP` compounds per hit. A
quicker ball gives the opponent less time to reach the interception, so their
paddle is still *moving* when it arrives, and a moving far paddle is precisely
what cannot be predicted. The geometry bought a 2.05x longer crossing time and
the ball speed spent it. **Top speed is the lever; paddle size is not.**

A first-ever nonzero `rev near` also appeared (7, in one match of eight at
270ms) — worth knowing if the idea is ever revisited, because the near plane
had produced zero in every run before it.

So the trade is not "smoother ball against worse feel". It is worse ball AND
worse feel, and it stays untaken for a better reason than taste.

**The trade runs the other way too, and it is mostly about ball speed.** When the
rally speed-up was steepened so players could feel it, the first attempt
(`BALL_SPEEDUP` 1.045 → 1.09, ceiling left at 132) measured 16.5 mispredicted far
reversals per 30s at 87ms RTT against the old build's 4.0, with ball correction
29.6 against 2.4 — a cliff dragged down from ~150ms to under 87ms. The cause is
the same geometry read forwards: a quicker ball gives the opponent less time to
reach the interception, so their paddle is still *moving* when it arrives, and a
moving far paddle is exactly what this client cannot predict.

The fix was to lower the ceiling as the ramp got steeper — 1.07 with a 115 cap,
which measured 4.3 reversals and 2.4 correction, level with the old build. That
pairing is *faster* than the old one at every hit count a rally actually reaches
(81 units/s by the fourth hit against 74, 114 by the ninth against 92); only the
number it converges on came down, and 132 was never reached in play anyway. Top
speed, not acceleration, is what the far paddle charges for.

### Predicted events

Everything continuous — where the ball is, where the paddles are — comes off
the reconciled world and is drawn straight from it. What that world cannot
carry is the *moment* something happened: a bounce is a sign change the eye has
to infer, and a point is a numeral ticking over behind the play. Those ride
Colyseus 0.18's optimistic event channels (`predict.defineEvent`), ported from
the official [air-hockey demo], which is where this pattern was taken from.

A channel is declared once, predicted from inside the reconciler step with
`ctx.predict(...)`, and settled against the server. Two properties are what
make it worth using rather than diffing replicated state:

- **`ctx.predict` is live-only by construction.** A rollback replay re-derives
  the same bounce a dozen times per correction and every one of those is
  silently skipped, so the cue fires exactly once. A state diff would need its
  own dedupe, and would get it wrong on the reconcile.
- **Settlement is anchored to the ack stream, not to a clock.** An entry
  rejects only once the server has processed past the tick that predicted it
  without saying anything. No RTT estimate, and nothing that false-rejects
  because the link got slow.

Both channels settle off replicated state rather than a new broadcast, so the
server is untouched: a point confirms when `meta.scoreBottom`/`scoreTop`
increases, a hit when `meta.rallyHits` does. `confirm()` returning zero means
the server saw an event this client never predicted, and the cue is played then
instead, flagged as the late one.

**Above the cliff, the far paddle's hits and *every* point wait for the
server; the near paddle's hits do not.** This is the same ~129ms figure from
the section above, read as a policy instead of a description, and it is the
one place this build deliberately diverges from the demo it copied. The ball
keeps being predicted through the opponent's paddle either way — declining to
do that was measured and reverted. What is gated is the discrete *feedback*,
because the two fail differently: a ball that curves the wrong way for 65ms
eases itself out, and a haptic buzz for a point the far paddle turns out to
have saved cannot be taken back. So the ball takes the bet and the buzz does
not, and above the cliff the withheld cue simply arrives with the server's
word for it.

**Points are gated at both planes, and that is not the obvious line.** A point
of mine is the far paddle's business and gating it needs no argument. A point
of *theirs* — the ball going past my own paddle — looks like it should be safe,
because my paddle is driven by my own inputs and reconciles to zero error. It
is not: the ball arriving at my plane came off *their* paddle, so above the
cliff it carries that bounce's error all the way down the field (~29 units,
measured below) and can be predicted to sail past a paddle it actually hit.
Predicting it bought ~one RTT of earliness and paid for it with a warning
buzz, an opponent-tinted wash, and a retraction ~333ms later when the
channel's grace expired. Above the cliff, the score now only ever moves on the
server's word.

Near-plane *hits* stay predicted at every latency, inheriting the same error
and occasionally wrong in the same way. The asymmetry is deliberate: a hit is
a light tap, and a wrong one costs a phantom tap or a late tap, against a
point's buzz-plus-wash-plus-retraction — and that tap is what keeps the paddle
feeling connected to the hand exactly where the link is worst. It is also why
the hit channel has no reject path: nothing on it is loud enough to be worth
taking back.

**The score numerals stay authoritative.** The demo hides its puck and
celebrates optimistically; this does not, for the same asymmetry. A wrong buzz
is a signal the player has already felt and forgotten; a score that reads 4-3
and then goes back to 3-3 is a signal they are still looking at. At a healthy
lead the numeral trails the cue by the `lead ms` column, ~170ms, which that
column has always described as invisible.

Measured by `prediction.integration.test.ts` at 150ms RTT — past the cliff, so
both regimes are exercised in one rally:

```
3892ms hit near predicted | 6164ms hit far LATE
7818ms hit near predicted | 10031ms hit far LATE
```

One cue per hit and no more: the near-plane pair predicted, the far-plane pair
withheld and delivered on the server's word. What the test asserts is that
something fired, that at least one cue was predicted (a build whose
`ctx.predict` never ran would otherwise pass), and — the one that matters —
that the delivered count matches the server's hit count within one in-flight
prediction. A confirm that failed to settle its pending entry would report the
same hit twice, once early and once late, which is a double buzz in the
player's hand and shows up in no other column of any report.

**It does NOT assert that every near-plane hit is predicted, and the reason is
worth keeping.** That assertion was written first, on the strength of
`selfPaddleCorrection` being 0.000 in every run, and it failed about one run in
five. Our own paddle being exact does not make the CONTACT exact: above the
cliff the far bounce is a coin flip and its error rides the ball all the way
down the field, so the ball can arrive at our own paddle ~29 units from where
the server has it and be predicted to sail past something it actually hit. The
near cue then arrives late too. That is the far paddle being measured twice,
not a near-plane regression, and an assertion that calls it one is an
instrument fault of the kind this README already has a section about.

`predictedHits` / `lateHits` / `rejectedPoints` ride home in the end-of-match
netcode sample. They are the misprediction rate *as the player felt it*, which
the correction columns do not capture: a build that quietly stopped predicting
events would look identical in every one of them. `rejectedPoints` should now
be zero on any match played above the cliff — nothing is predicted up there to
reject — so a nonzero one on a slow link is the gate failing, not the network.

[air-hockey demo]: https://github.com/colyseus/air-hockey-demo

### Controls

Finger tracking along the field; the paddle follows X. Not buttons. Vertical
orientation, paddles top and bottom, because phone screens are narrow. Arrow
keys are the desktop equivalent, and go through the same target — see below.

**The paddle is kept out from under the finger steering it.** Two independent
moves, because one of them is free and the other is not. `PADDLE_INSET` (18
units) is replicated geometry and costs both players rally length, so it buys
the guaranteed part of the clearance; the renderer then spends the *letterbox* —
the dead band left over when a 100x180 field is fitted to a taller screen — on
the same problem, biasing the field upwards by up to 56px rather than centring
it. That part is per-device slack that was previously thrown away, and the
simulation never sees it.

**The paddle's striking face is a convex arc, not a bar.** The ball leaves along
the surface normal at the point it touched, so the return angle is something a
player reads off the curve in front of them rather than something they have to
learn: hit the middle of the bulge and it goes back the way it came, hit towards
an end, where the face has turned away, and it cuts — up to `asin(11/17)` ≈ 40°.
The incoming direction is deliberately discarded; a true reflection would make
the return a function of two things the player is tracking separately. What is
drawn is exactly what is solved against — the renderer strokes the arc at
`PADDLE_ARC_R - PADDLE_THICKNESS / 2` so the bar's outer edge lands on the
contact radius — because a curved paddle whose curve is decorative is worse than
a flat one.

The client sends a **desired** paddle position and the server moves the paddle
under a hard speed cap. That one rule eliminates the teleporting-paddle cheat,
and it lives in `game-core` so client prediction and server truth agree by
construction — an honest client never sees a correction on its own paddle.

`touch-action: none` plus `disableVerticalSwipes()` is what stops a downward
drag from scrolling the page or pulling the Mini App closed mid-rally.

**Arrow keys on the desktop clients**, where there is no finger to rest on the
field. A key is a direction and the wire carries a position, so the client
integrates one into the other: holding an arrow walks the target sideways at
exactly `PADDLE_MAX_SPEED` — the speed the server would clamp it to anyway — and
clamps it to the paddle's legal range. Both halves are about the release. A
target that ran ahead of the paddle would keep it gliding after the key came up,
and one left parked inside a wall would make the first 200ms of the next press
do nothing. The paddle's left is the *player's* left on both sides: the top
player's view is mirrored, so their key direction is negated on the way in, the
same way `pointerToFieldX` un-mirrors a touch.

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

`netcode_sample` is one row per player per match (see
`client/src/net/netcodeSampler.ts`). Read it in this order:

- **`rttMean` first, then `pendingMean`.** Unacked inputs are the round trip
  *plus* any backlog, and only the first is the network's: the server consumes
  one input per tick and the client sends one per tick, so a queue that gets
  deep stays deep for the rest of the match. `pendingMean - rttMean / 33.3` is
  the backlog. Neither figure floors at zero, and the gap is much wider than
  one patch: `rttMean` is an INPUT round trip, so it carries the tick wait, the
  ack's patch, and whatever queue is standing — measured at roughly **110ms**
  above the injected link (see "What the far paddle costs"), and a bot match at
  0ms injected latency measures `rtt` ~74, `pending` 2.2-2.6 and `leadMs`
  74-86. Subtract that before reading `rttMean` as a network figure.
- **`leadMsMean` is what the player feels as a late score**, and how far past
  the far-paddle cliff (~129ms RTT) the match ran.
- **The correction split, not `correctionMax`.** The pose mixes positions with
  velocities, so a mispredicted bounce reports up to twice the ball's speed and
  reads like a teleport. `ballVelCorrMax` says it was a reversal,
  `ballCorrMax` says how far the ball actually moved, and `selfPaddleCorrMax`
  must stay ~0 — anything else is a real desync.
- `driftEma*` and `driftPeakMax` are computed on every device, not only the
  ones with the overlay on — that is what `warnOnDivergence` buys, and rows
  written before it was set report a hard-coded zero.
