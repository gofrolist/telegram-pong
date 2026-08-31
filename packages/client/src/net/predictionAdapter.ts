/**
 * The prediction adapter.
 *
 * Colyseus 0.18 is the last release before 1.0 and its prediction APIs are new
 * and still iterating. **Every call into them lives in this file.** Nothing
 * else in the client imports `Predict`, `SimReconciler`, `room.input()` or any
 * other netcode symbol, so a version bump is a change to one module rather
 * than a change scattered across every component that draws a ball.
 *
 * What the adapter provides, and nothing more:
 *   - `frame(desiredX, now)`, called once per animation frame with rAF's own
 *     timestamp: stages and sends the inputs due this frame, and advances the
 *     reconciler.
 *   - `read()`, a smoothed snapshot for the renderer.
 *
 * What it deliberately does NOT do: clock synchronisation, a snapshot buffer,
 * or a reconciliation loop. Those are the framework's, and hand-rolling them
 * alongside would produce two systems that disagree under exactly the network
 * conditions they exist to handle.
 */

import { Predict, type Room } from '@colyseus/sdk';
import {
  DIVERGENCE_TOLERANCE,
  PREDICTION_SMOOTH_MS,
  SIDE_BOTTOM,
  TICK_DT,
  TICK_MS,
  createWorld,
  sanitizeTargetX,
  stepWithInput,
  type MetaLike,
  type PongInput,
  type PongWorld,
  type Side,
} from '@pong/game-core';
// The SAME Schema classes the server replicates. A client-side copy that
// drifted from the server's would desync on exactly the field they disagree
// about, under load, in production.
import { $refId } from '@pong/game-core/net';
import type { Ball, MatchMeta, Paddle, PongState } from '@pong/game-core/net';

/** What the renderer needs, and only what it needs. */
export interface RenderSnapshot {
  ballX: number;
  ballY: number;
  bottomX: number;
  topX: number;
}

/**
 * What the reconciler knows about how well prediction is going.
 *
 * The two drift figures are the ones that separate the two very different
 * problems a wandering ball can have, and the SDK is explicit about how to
 * read them: a steady nonzero `ema` is divergence — the prediction is
 * persistently wrong and the ball is being rubber-banded — whereas a `peak`
 * spiking over a low `ema` is network jitter. Both near zero means the
 * prediction matched the server, and anything visibly wrong on screen is a
 * rendering problem rather than a netcode one.
 */
export interface NetcodeStats {
  /**
   * Unacknowledged inputs. Times the tick interval, this is the round trip —
   * but only while it stays inside the SDK's replay ring (64 entries at this
   * input rate). Above that the oldest unacked inputs age out and rollback
   * silently skips them, so a `pending` pinned near 64 is not a slow link, it
   * is a prediction that has stopped working. See `PongRoom`'s netcode note.
   */
  pending: number;
  /**
   * Size of the most recent correction, in field units: the worst |delta|
   * across the ball's and both paddles' positions and velocities. Match meta
   * is excluded from the pose on purpose — see {@link WorldRefs}.
   */
  correction: number;
  /** Persistent drift. Steady and nonzero means divergence. */
  driftEma: number;
  /** Recent decaying max. A spike over a low `ema` means jitter. */
  driftPeak: number;
  /** Increments once per reconcile; differences count reconciles. */
  reconcileSeq: number;
  /**
   * Correction on the ball's POSITION, in field units. THE number behind "the
   * ball jumps": it is how far the ball moved sideways when the server
   * disagreed, on a field 100 wide.
   */
  ballCorrection: number;
  /**
   * Correction on the ball's VELOCITY. A mispredicted BOUNCE lands here first
   * and is up to twice the ball's speed, so a big number here with a small
   * `ballCorrection` means the ball was sent the wrong way and has not
   * travelled far yet.
   */
  ballVelCorrection: number;
  /**
   * Correction on the local player's own paddle. Should be ~0 forever: the
   * client runs the same `movePaddle` over the same inputs the server
   * consumed. Anything else is a genuine desync — wrong dt, wrong constants,
   * or an input the server never applied.
   */
  selfPaddleCorrection: number;
  /**
   * Correction on the OPPONENT's paddle. Nonzero by construction, and not a
   * bug on its own: the client never sees their inputs, so it can only carry
   * their last replicated target forward. It matters only when the ball
   * reaches that paddle during the replay window, which is when it turns into
   * a mispredicted bounce.
   */
  oppPaddleCorrection: number;
  /**
   * How far ahead of confirmed server truth the drawn world is, in ms.
   *
   * Prediction is *supposed* to run ahead — that is what hides the round trip
   * — but only by about one. This number is what a player feels as "the score
   * is late": the ball is drawn from the predicted world and the score from
   * the replicated one, so the moment you watch the ball go past your paddle
   * is exactly this far ahead of the moment the score changes. At a healthy
   * 200ms nobody notices; at 2s it reads as the game not having registered
   * the point.
   */
  leadMs: number;
  /**
   * The LINK's own round trip, in ms, smoothed — the SDK's measurement, taken
   * by correlating the server-echoed input seq with the client's send times.
   *
   * The one number that reads {@link pending} correctly. Unacked inputs are
   * two things added together: the round trip, which is the network's and
   * which prediction exists to hide, and a BACKLOG, which is ours and which
   * nothing drains — the server consumes one input per tick and the client
   * sends one per tick, so a queue that gets deep stays deep for the rest of
   * the match. `pending - rtt / TICK_MS` separates them, and without it a
   * field report cannot tell a slow link from a queue we built ourselves.
   *
   * Read it as the round trip PLUS up to one patch interval: the ack rides a
   * patch, so the sample is quantised by the 33ms broadcast cadence. The bot
   * harness measures a floor of ~74ms against an injected 0, and tracks an
   * injected 200 to within 2ms above that.
   */
  rttMs: number;
  /**
   * Interarrival jitter on the patch stream (RFC 3550), in ms. ~0 on a steady
   * link at any latency, so it separates "far away" from "unstable".
   */
  jitterMs: number;
}

/**
 * The world handed to the reconciler.
 *
 * `ball`, `bottom` and `top` are the decoded schema instances, which the SDK
 * auto-binds: it mirrors their scalars, re-adopts them from the server on
 * every ack, and — the part that matters here — turns every numeric field into
 * a smoothed *render pose* field.
 *
 * `meta` is deliberately NOT one of them. It is nested under a plain wrapper,
 * which is the SDK's documented way of keeping a decoded instance opaque, and
 * adopted by hand in {@link adoptMeta}. Bound, its nine scalars would become
 * pose fields too — and the reconciler reports drift and correction as the
 * worst |delta| across ALL pose fields. `meta.rng` is a 32-bit PRNG state that
 * jumps by ~2^31 on every serve, so it buried the ball: the first field report
 * off a real phone read `correctionMax: 2463401483` for a ball that lives in a
 * 100x180 field. Keeping meta opaque costs one hand-written adopt and makes
 * the correction figure mean "how far the ball jumped", which is the number
 * the report exists to carry.
 */
interface WorldRefs {
  meta: { scalars: MetaLike };
  ball: Ball;
  bottom: Paddle;
  top: Paddle;
}

/**
 * Pose-field groups, for reading a correction as something other than one
 * undifferentiated number.
 *
 * The reconciler reports drift as the worst |delta| across every pose field,
 * which cannot distinguish "the ball teleported" from "the opponent moved
 * their paddle and I could not have known". Those need completely different
 * responses, so they are counted separately.
 */
const BALL_POSITION_FIELDS = ['ball.x', 'ball.y'] as const;
const BALL_VELOCITY_FIELDS = ['ball.vx', 'ball.vy', 'ball.speed'] as const;
const BOTTOM_PADDLE_FIELDS = ['bottom.x', 'bottom.targetX'] as const;
const TOP_PADDLE_FIELDS = ['top.x', 'top.targetX'] as const;

/** Worst absolute correction across `fields`. */
function worstOf(corrections: Record<string, number>, fields: readonly string[]): number {
  let worst = 0;
  for (const field of fields) {
    const value = corrections[field];
    if (value === undefined) continue;
    const magnitude = value < 0 ? -value : value;
    if (magnitude > worst) worst = magnitude;
  }
  return worst;
}

/** Copy the server's authoritative meta over the predicted mirror. */
function adoptMeta(into: MetaLike, from: MatchMeta): void {
  into.tick = from.tick;
  into.phase = from.phase;
  into.scoreBottom = from.scoreBottom;
  into.scoreTop = from.scoreTop;
  into.serveTo = from.serveTo;
  into.countdown = from.countdown;
  into.rallyHits = from.rallyHits;
  into.rng = from.rng;
  into.endReason = from.endReason;
}

/**
 * The SDK infers the state type directly from a Schema type argument, so
 * `Room<PongState>` gives `room.state: PongState`. The input type is supplied
 * explicitly at the `room.input()` call, since it is not reachable from the
 * state class.
 */
export type PongRoom = Room<PongState>;

export interface PredictionHandle {
  /**
   * Advance one animation frame.
   *
   * `desiredTargetX` is where the player's finger is, in field units. It is a
   * *desire*: the shared simulation moves the paddle towards it under the
   * speed cap, identically here and on the server, so an honest client sees
   * no correction at all.
   *
   * `now` MUST be the timestamp `requestAnimationFrame` passed its callback,
   * not a reading taken inside it — see the note on `predict.tick` below.
   */
  frame(desiredTargetX: number, now: number): void;
  /** Smoothed positions for this frame. Safe to call after `frame`. */
  read(): RenderSnapshot;
  /** Diagnostics for the overlay and for the end-of-match netcode summary. */
  stats(): NetcodeStats;
  dispose(): void;
}

/**
 * Attach prediction to a joined room.
 *
 * `mySide` decides which paddle the local input steers. Both players see
 * themselves at the bottom of their own screen; the mirroring happens in the
 * renderer, never in the simulation, because a mirrored simulation would not
 * be the same simulation.
 */
export interface PredictionOptions {
  /** Correction easing window. Defaults to {@link PREDICTION_SMOOTH_MS}. */
  smoothMs?: number;
  /**
   * Teleport threshold, in field units. A reconcile whose worst per-field
   * correction exceeds it POPS to server truth instead of easing out over
   * `smoothMs`.
   *
   * Off by default. Exposed so the bot harness can sweep it — see the README
   * on what the far paddle costs.
   */
  snap?: number;
}

export async function attachPrediction(
  room: PongRoom,
  mySide: Side,
  options: PredictionOptions = {},
): Promise<PredictionHandle> {
  const smoothMs = options.smoothMs ?? PREDICTION_SMOOTH_MS;
  const snap = options.snap;
  // The reconciler binds to the *decoded* schema instances, which only exist
  // once the first state patch has been applied — before that, `room.state`
  // holds locally auto-instantiated placeholders with no ref id, and the SDK
  // rejects them with a pointed error rather than silently predicting into
  // objects the server will never update.
  await waitForDecodedState(room);

  const predict = Predict.get(room);

  /**
   * The input handle is the ONLY thing that stages and sends.
   *
   * `reliable`, not `unreliable`: the unreliable mode packs redundant copies
   * of recent inputs into one datagram, which needs a transport with a
   * datagram channel. Every WebSocket transport — including the uWebSockets
   * one this server uses — has none, so asking for `unreliable` gets the
   * redundancy silently dropped and a warning logged on every client. Loss is
   * instead absorbed by the server holding the last target on a tick that
   * arrives empty, which costs it nothing: see `PongRoom.inputs`.
   */
  const input = room.input<PongInput>({ mode: 'reliable' });

  const state = room.state;

  /**
   * The `PongWorld` the shared step runs over, allocated ONCE.
   *
   * `step` is called dozens of times per correction, so it may not allocate:
   * this object is rebound to the reconciler's mirrors on each call rather
   * than rebuilt. Its `meta` is the predicted meta itself — the same object
   * the world below hands the reconciler as opaque scratch.
   */
  // Which paddle is mine decides how a correction on it should be read: mine
  // must stay at zero, theirs cannot.
  const selfFields = mySide === SIDE_BOTTOM ? BOTTOM_PADDLE_FIELDS : TOP_PADDLE_FIELDS;
  const oppFields = mySide === SIDE_BOTTOM ? TOP_PADDLE_FIELDS : BOTTOM_PADDLE_FIELDS;

  const view: PongWorld = createWorld(0);
  // Seed it now. The bound entries are mirrored from decoded truth by the
  // constructor; an opaque part is not, and `adopt` first runs on the first
  // ack — so without this the predicted world would sit in WAITING (and
  // simulate nothing) for the patch or two before that ack lands.
  adoptMeta(view.meta, state.meta);

  /**
   * One reconciler over the whole world rather than one per entity.
   *
   * Pong is a shared-world game: the ball's next position depends on both
   * paddles, so a per-entity reconciler would replay my paddle correctly and
   * still get the ball wrong. `sim()` replays the entire world through the
   * same `stepWithInput` the server runs.
   */
  const sim = predict.sim<PongInput, Record<string, number>, WorldRefs>({
    input,
    world: {
      meta: { scalars: view.meta },
      ball: state.ball,
      bottom: state.bottom,
      top: state.top,
    },
    smoothMs,
    // Undefined leaves it off, which is the SDK default: every correction
    // eases. See PredictionOptions.snap.
    snap,
    /**
     * Setting this is what makes drift and correction get COMPUTED at all.
     *
     * The SDK skips every scrap of that bookkeeping unless a tolerance is set
     * or its debug bundle is loaded — reasonably, since a production build
     * that reads neither should not pay for it. But this build reads both: the
     * end-of-match summary sends these numbers home from every device, and
     * without a tolerance they were being sent as a hard-coded zero by anyone
     * who had not turned the overlay on. A whole class of report therefore
     * said "the prediction is perfect" when nothing had been measured, and the
     * integration test asserting `correction < 0.5` was passing on a value
     * that was never written.
     *
     * The number itself is the console-warning threshold, throttled to one a
     * second. Set above the drift the OPPONENT'S paddle contributes on its own
     * — which is unavoidable, since their inputs are not knowable here — so a
     * warning means something we can actually act on.
     */
    warnOnDivergence: DIVERGENCE_TOLERANCE,
    // The bound entries re-seed themselves from the server on every ack; this
    // covers the one part that is opaque on purpose.
    adopt: (world) => {
      adoptMeta(world.meta.scalars, state.meta);
    },
    step: (ctx, world, command) => {
      // Rebind, don't rebuild: `world.ball` and friends are the reconciler's
      // scratch mirrors, and they are the same objects on every call.
      view.ball = world.ball;
      view.bottom = world.bottom;
      view.top = world.top;
      // The SAME function the server's fixed timestep calls, with the same
      // arguments. This identity is the whole reason the backend is
      // TypeScript, and an earlier attempt to break it deliberately — having
      // the client decline to predict the opponent's bounce — measured worse
      // and was reverted. See README, "What the far paddle costs".
      stepWithInput(view, mySide, command, ctx.dt || TICK_DT);
    },
  });

  return {
    frame(desiredTargetX: number, now: number): void {
      const target = sanitizeTargetX(desiredTargetX);

      // How many fixed input steps are due this frame. On a 120 Hz phone this
      // is usually 0 and occasionally 1; on a stuttering one it may be 2 or 3.
      //
      // `now` is the rAF timestamp, and passing it is not optional. Omitted,
      // it defaults to `performance.now()` read inside the callback, which folds JS
      // scheduling jitter into the frame dt: the render interpolation then
      // advances unevenly and the ball reads as drifting off a straight line
      // rather than stuttering outright. The rAF timestamp is vsync-aligned
      // and evenly spaced, which is exactly what the interpolation assumes.
      const steps = predict.tick(now);
      for (let i = 0; i < steps; i++) {
        input.data.targetX = target;
        input.send();
      }
    },

    read(): RenderSnapshot {
      return {
        ballX: sim.value('ball.x'),
        ballY: sim.value('ball.y'),
        bottomX: sim.value('bottom.x'),
        topX: sim.value('top.x'),
      };
    },

    stats(): NetcodeStats {
      return {
        pending: sim.pendingCount,
        correction: sim.lastCorrectionMag,
        driftEma: sim.drift.ema,
        driftPeak: sim.drift.peak,
        reconcileSeq: sim.reconcileSeq,
        ballCorrection: worstOf(sim.lastCorrection, BALL_POSITION_FIELDS),
        ballVelCorrection: worstOf(sim.lastCorrection, BALL_VELOCITY_FIELDS),
        selfPaddleCorrection: worstOf(sim.lastCorrection, selfFields),
        oppPaddleCorrection: worstOf(sim.lastCorrection, oppFields),
        // Predicted tick minus replicated tick. `view.meta` IS the predicted
        // meta, and `state.meta` is the newest the server has confirmed.
        leadMs: (view.meta.tick - state.meta.tick) * TICK_MS,
        // Both come from the room clock the SDK already maintains off the
        // TIMED prefix on every patch — including the heartbeat patch a room
        // with input sends when nothing changed, so they keep updating on the
        // waiting screen. Reading them costs a property access.
        rttMs: room.clock.smoothedRtt(),
        jitterMs: room.clock.jitter(),
      };
    },

    dispose(): void {
      sim.dispose();
      predict.dispose();
    },
  };
}

/**
 * Resolve once the room's state has been decoded at least once.
 *
 * `joinById` resolves as soon as the seat is confirmed, which is strictly
 * earlier than the arrival of the first state patch — and on a 150ms link,
 * meaningfully earlier.
 */
function waitForDecodedState(room: PongRoom): Promise<void> {
  if (isDecoded(room)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    // Poll rather than relying on a single `onStateChange`: the sub-schemas
    // may be decoded across more than one patch, so the first change is not a
    // guarantee that all four refs have landed.
    //
    // Bounded, because a room that errors or is left before its first patch
    // would otherwise leave this interval running at 16ms for the life of the
    // page — one leaked timer per mount, and the caller's promise never
    // settles so its `.catch` never runs either.
    const deadline = Date.now() + DECODE_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (isDecoded(room)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('state_never_decoded'));
      }
    }, 16);
  });
}

/**
 * How long to wait for the first full state patch before giving up.
 *
 * Generous: this covers a cold join on a bad mobile link, not a fast path.
 */
const DECODE_TIMEOUT_MS = 15_000;

function isDecoded(room: PongRoom): boolean {
  const state = room.state as unknown as Partial<WorldRefs> | undefined;
  if (!state?.meta || !state.ball || !state.bottom || !state.top) return false;
  // Only a decoded instance carries a ref id. A `t.ref()` field is
  // auto-instantiated locally when the client constructs its state, so the
  // objects exist well before the decoder has put the server's versions there
  // — and binding the reconciler to those placeholders predicts into objects
  // the server will never update.
  return (
    hasRefId(state.meta) && hasRefId(state.ball) && hasRefId(state.bottom) && hasRefId(state.top)
  );
}

function hasRefId(instance: object): boolean {
  return (instance as Record<symbol, unknown>)[$refId] !== undefined;
}
