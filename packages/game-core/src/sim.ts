/**
 * The Pong simulation. One implementation, run by both sides.
 *
 * Rules this file obeys, in order of importance:
 *
 *  1. **Deterministic.** Only `+ - * /`, comparison and `Math.sqrt` /
 *     `Math.imul` appear. No transcendental functions, no `Math.random`, no
 *     `Date.now`, no iteration over an unordered collection. Given the same
 *     starting world and the same inputs, every engine produces bit-identical
 *     output — which is what makes Colyseus' rollback silent instead of
 *     stuttery.
 *  2. **Fixed timestep.** `dt` is always the same value (`TICK_DT`). It is a
 *     parameter only so that a test can prove the simulation does not secretly
 *     depend on wall-clock time.
 *  3. **In-place.** The world is mutated, never reallocated. The client's
 *     reconciler replays dozens of ticks per correction; allocating a world
 *     per tick would garbage-collect mid-rally on a low-end phone.
 */

import {
  BALL_MAX_SPEED,
  BALL_RADIUS,
  BALL_SPEEDUP,
  BALL_START_SPEED,
  BOTTOM_PLANE_Y,
  BOUNCE_SKEW,
  COUNTDOWN_TICKS,
  FIELD_H,
  FIELD_W,
  FIRST_SERVE_COUNTDOWN_TICKS,
  MIN_VERTICAL_RATIO,
  PADDLE_HALF_W,
  PADDLE_MAX_SPEED,
  SCORE_TO_WIN,
  SERVE_DIRS,
  TOP_PLANE_Y,
} from './constants.js';
import { nextInt } from './rng.js';
import {
  EndReason,
  Phase,
  SIDE_BOTTOM,
  SIDE_TOP,
  type PongInput,
  type PongWorld,
  type PaddleLike,
  type Side,
} from './types.js';

/** Leftmost / rightmost legal paddle centre. */
const PADDLE_MIN_X = PADDLE_HALF_W;
const PADDLE_MAX_X = FIELD_W - PADDLE_HALF_W;

/** Half-width of the region in which a ball counts as struck. */
const CONTACT_HALF_W = PADDLE_HALF_W + BALL_RADIUS;

/** Upper bound on collision resolutions in a single tick. */
const MAX_SUBSTEPS = 8;

/**
 * Clamp an inbound desired X into the legal range and scrub non-finite values.
 *
 * ANTI-CHEAT / determinism: a `NaN` reaching `targetX` would propagate into
 * the paddle position, then into every bounce, and would never recover — and
 * `NaN` compares false against every bound, so it must be caught explicitly
 * rather than clamped.
 */
export function sanitizeTargetX(value: number): number {
  if (!Number.isFinite(value)) return FIELD_W / 2;
  if (value < PADDLE_MIN_X) return PADDLE_MIN_X;
  if (value > PADDLE_MAX_X) return PADDLE_MAX_X;
  return value;
}

/** Record a player's desired paddle position. Does not move the paddle. */
export function applyInput(world: PongWorld, side: Side, input: PongInput): void {
  const paddle = side === SIDE_BOTTOM ? world.bottom : world.top;
  paddle.targetX = sanitizeTargetX(input.targetX);
}

/**
 * Move a paddle towards its target under the hard speed cap.
 *
 * This is the teleport cheat's grave. The client runs the identical function
 * during prediction, so an honest player never sees a correction, while a
 * client that lies about its position simply watches its paddle slide at the
 * legal speed.
 */
function movePaddle(paddle: PaddleLike, dt: number): void {
  const maxDelta = PADDLE_MAX_SPEED * dt;
  const target = sanitizeTargetX(paddle.targetX);
  const delta = target - paddle.x;
  if (delta > maxDelta) {
    paddle.x += maxDelta;
  } else if (delta < -maxDelta) {
    paddle.x -= maxDelta;
  } else {
    paddle.x = target;
  }
  if (paddle.x < PADDLE_MIN_X) paddle.x = PADDLE_MIN_X;
  else if (paddle.x > PADDLE_MAX_X) paddle.x = PADDLE_MAX_X;
}

/** Park the ball at centre with no velocity, between points. */
function parkBall(world: PongWorld): void {
  world.ball.x = FIELD_W / 2;
  world.ball.y = FIELD_H / 2;
  world.ball.vx = 0;
  world.ball.vy = 0;
  world.ball.speed = BALL_START_SPEED;
}

/**
 * Launch the ball towards `meta.serveTo`.
 *
 * Consumes exactly one PRNG draw. Because `meta.rng` is part of the world,
 * a rollback that replays this tick draws the same direction again.
 */
function serve(world: PongWorld): void {
  const [rng, index] = nextInt(world.meta.rng, SERVE_DIRS.length);
  world.meta.rng = rng;

  const dir = SERVE_DIRS[index] ?? SERVE_DIRS[0]!;
  // `serveTo` is the side the ball flies towards: the player who just scored
  // has to defend the next serve, which keeps a losing streak from snowballing.
  const towardsBottom = world.meta.serveTo === SIDE_BOTTOM;

  world.ball.x = FIELD_W / 2;
  world.ball.y = FIELD_H / 2;
  world.ball.speed = BALL_START_SPEED;
  world.ball.vx = dir[0] * BALL_START_SPEED;
  world.ball.vy = (towardsBottom ? dir[1] : -dir[1]) * BALL_START_SPEED;
  world.meta.rallyHits = 0;
}

/**
 * Reflect the ball off a paddle, skewing the angle by the contact offset.
 *
 * `planeSide` is the side that owns the paddle; the ball leaves along -Y for
 * the bottom paddle and +Y for the top one.
 */
function bounceOffPaddle(world: PongWorld, side: Side, paddle: PaddleLike): void {
  const offset = world.ball.x - paddle.x;
  let normalised = offset / CONTACT_HALF_W;
  if (normalised < -1) normalised = -1;
  else if (normalised > 1) normalised = 1;

  let speed = world.ball.speed * BALL_SPEEDUP;
  if (speed > BALL_MAX_SPEED) speed = BALL_MAX_SPEED;

  let dx = normalised * BOUNCE_SKEW;
  let dy = side === SIDE_BOTTOM ? -1 : 1;

  let length = Math.sqrt(dx * dx + dy * dy);
  dx /= length;
  dy /= length;

  // Keep a floor under the vertical component so a rally cannot degenerate
  // into a ball creeping sideways along the paddle line.
  if (dy < 0 && dy > -MIN_VERTICAL_RATIO) dy = -MIN_VERTICAL_RATIO;
  else if (dy > 0 && dy < MIN_VERTICAL_RATIO) dy = MIN_VERTICAL_RATIO;
  length = Math.sqrt(dx * dx + dy * dy);
  dx /= length;
  dy /= length;

  world.ball.speed = speed;
  world.ball.vx = dx * speed;
  world.ball.vy = dy * speed;
  world.meta.rallyHits += 1;
}

/**
 * Advance the ball by `dt`, resolving collisions in time order.
 *
 * Swept, not discrete: at 30 Hz and top speed the ball covers over twice the
 * paddle thickness per tick, so a naive overlap test would let it tunnel
 * through a paddle. We solve for the earliest time of impact, advance exactly
 * that far, resolve, and continue with the remaining time.
 */
function advanceBall(world: PongWorld, dt: number): void {
  const ball = world.ball;
  let remaining = dt;
  // Once the ball has passed a paddle plane without being struck, stop testing
  // the planes: it is on its way to the goal line and must not re-trigger a
  // zero-length impact at the plane it is sitting exactly on.
  let planesLive = true;

  for (let guard = 0; guard < MAX_SUBSTEPS && remaining > 0; guard++) {
    const endX = ball.x + ball.vx * remaining;
    const endY = ball.y + ball.vy * remaining;

    let toi = remaining;
    // 0 = no impact, 1 = side wall, 2 = bottom paddle plane, 3 = top plane.
    let kind = 0;

    if (ball.vx < 0) {
      if (endX < BALL_RADIUS) {
        const t = (BALL_RADIUS - ball.x) / ball.vx;
        if (t < toi) {
          toi = t;
          kind = 1;
        }
      }
    } else if (ball.vx > 0) {
      const limit = FIELD_W - BALL_RADIUS;
      if (endX > limit) {
        const t = (limit - ball.x) / ball.vx;
        if (t < toi) {
          toi = t;
          kind = 1;
        }
      }
    }

    if (planesLive) {
      if (ball.vy > 0) {
        const limit = BOTTOM_PLANE_Y - BALL_RADIUS;
        if (ball.y <= limit && endY > limit) {
          const t = (limit - ball.y) / ball.vy;
          if (t < toi) {
            toi = t;
            kind = 2;
          }
        }
      } else if (ball.vy < 0) {
        const limit = TOP_PLANE_Y + BALL_RADIUS;
        if (ball.y >= limit && endY < limit) {
          const t = (limit - ball.y) / ball.vy;
          if (t < toi) {
            toi = t;
            kind = 3;
          }
        }
      }
    }

    ball.x += ball.vx * toi;
    ball.y += ball.vy * toi;
    remaining -= toi;

    if (kind === 1) {
      ball.vx = -ball.vx;
      if (ball.x < BALL_RADIUS) ball.x = BALL_RADIUS;
      else if (ball.x > FIELD_W - BALL_RADIUS) ball.x = FIELD_W - BALL_RADIUS;
    } else if (kind === 2 || kind === 3) {
      const side: Side = kind === 2 ? SIDE_BOTTOM : SIDE_TOP;
      const paddle = kind === 2 ? world.bottom : world.top;
      const offset = ball.x - paddle.x;
      const distance = offset < 0 ? -offset : offset;
      if (distance <= CONTACT_HALF_W) {
        bounceOffPaddle(world, side, paddle);
      } else {
        planesLive = false;
      }
    } else {
      break;
    }
  }
}

/** Award a point to `scorer` and set up the next serve, or end the match. */
function concede(world: PongWorld, scorer: Side): void {
  if (scorer === SIDE_BOTTOM) world.meta.scoreBottom += 1;
  else world.meta.scoreTop += 1;

  const scorerPoints = scorer === SIDE_BOTTOM ? world.meta.scoreBottom : world.meta.scoreTop;
  parkBall(world);

  if (scorerPoints >= SCORE_TO_WIN) {
    world.meta.phase = Phase.ENDED;
    world.meta.endReason = EndReason.SCORE;
    world.meta.countdown = 0;
    return;
  }

  world.meta.serveTo = scorer;
  world.meta.phase = Phase.COUNTDOWN;
  world.meta.countdown = COUNTDOWN_TICKS;
}

/**
 * Advance the world by exactly one fixed step.
 *
 * `dt` must be {@link TICK_DT}; it is passed rather than imported purely so a
 * determinism test can vary it deliberately.
 */
export function step(world: PongWorld, dt: number): void {
  const meta = world.meta;

  // A waiting, paused or finished room does not advance. Freezing here — and
  // not at the caller — means the client's rollback replays the freeze too.
  if (meta.phase !== Phase.PLAYING && meta.phase !== Phase.COUNTDOWN) return;

  meta.tick += 1;

  // Paddles track during the countdown as well; letting a player line up
  // before the serve is what makes the countdown feel like part of the game.
  movePaddle(world.bottom, dt);
  movePaddle(world.top, dt);

  if (meta.phase === Phase.COUNTDOWN) {
    meta.countdown -= 1;
    if (meta.countdown <= 0) {
      meta.countdown = 0;
      meta.phase = Phase.PLAYING;
      serve(world);
    }
    return;
  }

  advanceBall(world, dt);

  if (world.ball.y > FIELD_H + BALL_RADIUS) {
    // The bottom player let it past: the top player scores.
    concede(world, SIDE_TOP);
  } else if (world.ball.y < -BALL_RADIUS) {
    concede(world, SIDE_BOTTOM);
  }
}

/**
 * Apply one player's input and advance one step.
 *
 * This is the exact function handed to the client's `SimReconciler` and run by
 * the server's fixed-timestep loop. The opponent's paddle is *not* driven by a
 * command here: it moves towards whatever `targetX` the world currently holds,
 * which on the client is the last value the server replicated. That makes the
 * two sides agree on the parts that matter (my paddle, the ball) without the
 * client needing to know the opponent's unsent inputs.
 */
export function stepWithInput(
  world: PongWorld,
  side: Side,
  input: PongInput | null | undefined,
  dt: number,
): void {
  if (input) applyInput(world, side, input);
  step(world, dt);
}

/** Allocate a plain-object world. Used by tests and by the client's mirror. */
export function createWorld(seed: number): PongWorld {
  return {
    meta: {
      tick: 0,
      phase: Phase.WAITING,
      scoreBottom: 0,
      scoreTop: 0,
      serveTo: SIDE_BOTTOM,
      countdown: 0,
      rallyHits: 0,
      rng: seed | 0,
      endReason: EndReason.NONE,
    },
    ball: {
      x: FIELD_W / 2,
      y: FIELD_H / 2,
      vx: 0,
      vy: 0,
      speed: BALL_START_SPEED,
    },
    bottom: { x: FIELD_W / 2, targetX: FIELD_W / 2 },
    top: { x: FIELD_W / 2, targetX: FIELD_W / 2 },
  };
}

/**
 * Put a world into its opening position. Safe to call on a Schema-backed
 * world, which is why it assigns every field rather than replacing objects.
 */
export function startMatch(world: PongWorld, seed: number, firstServeTo: Side): void {
  world.meta.tick = 0;
  world.meta.phase = Phase.COUNTDOWN;
  world.meta.scoreBottom = 0;
  world.meta.scoreTop = 0;
  world.meta.serveTo = firstServeTo;
  world.meta.countdown = FIRST_SERVE_COUNTDOWN_TICKS;
  world.meta.rallyHits = 0;
  world.meta.rng = seed | 0;
  world.meta.endReason = EndReason.NONE;
  world.bottom.x = FIELD_W / 2;
  world.bottom.targetX = FIELD_W / 2;
  world.top.x = FIELD_W / 2;
  world.top.targetX = FIELD_W / 2;
  parkBall(world);
}

/** Copy every scalar of `from` into `into`. Used to reseed a client world. */
export function copyWorld(into: PongWorld, from: PongWorld): void {
  into.meta.tick = from.meta.tick;
  into.meta.phase = from.meta.phase;
  into.meta.scoreBottom = from.meta.scoreBottom;
  into.meta.scoreTop = from.meta.scoreTop;
  into.meta.serveTo = from.meta.serveTo;
  into.meta.countdown = from.meta.countdown;
  into.meta.rallyHits = from.meta.rallyHits;
  into.meta.rng = from.meta.rng;
  into.meta.endReason = from.meta.endReason;
  into.ball.x = from.ball.x;
  into.ball.y = from.ball.y;
  into.ball.vx = from.ball.vx;
  into.ball.vy = from.ball.vy;
  into.ball.speed = from.ball.speed;
  into.bottom.x = from.bottom.x;
  into.bottom.targetX = from.bottom.targetX;
  into.top.x = from.top.x;
  into.top.targetX = from.top.targetX;
}

/** A stable digest of the whole world, for determinism assertions. */
export function worldSignature(world: PongWorld): string {
  const m = world.meta;
  const b = world.ball;
  return [
    m.tick,
    m.phase,
    m.scoreBottom,
    m.scoreTop,
    m.serveTo,
    m.countdown,
    m.rallyHits,
    m.rng,
    m.endReason,
    b.x,
    b.y,
    b.vx,
    b.vy,
    b.speed,
    world.bottom.x,
    world.bottom.targetX,
    world.top.x,
    world.top.targetX,
  ].join('|');
}
