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
  COUNTDOWN_TICKS,
  FIELD_H,
  FIELD_W,
  FIRST_SERVE_COUNTDOWN_TICKS,
  MIN_VERTICAL_RATIO,
  PADDLE_ARC_R,
  PADDLE_BULGE,
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

/**
 * The paddle's striking face is an arc, not a bar.
 *
 * Every number below is the same circle seen three ways. The face is the piece
 * of a circle of radius {@link PADDLE_ARC_R} that spans the paddle's width,
 * bulging towards the middle of the field; the arc's centre sits behind the
 * paddle, on the goal side.
 *
 * Solving the bounce against a circle rather than a plane is what makes the
 * return angle READABLE: the ball leaves along the surface normal at the point
 * it touched, and that point is on the curve the player can see. It is also
 * still exact and still deterministic — a segment against a circle is one
 * quadratic, and `Math.sqrt` is the one irrational operation IEEE-754 pins
 * down exactly, so it agrees bit-for-bit with the server.
 */
/** Y of the centre of the arc the bottom paddle's face is cut from. */
const BOTTOM_ARC_CY = BOTTOM_PLANE_Y - PADDLE_BULGE + PADDLE_ARC_R;
/** Y of the centre of the arc the top paddle's face is cut from. */
const TOP_ARC_CY = TOP_PLANE_Y + PADDLE_BULGE - PADDLE_ARC_R;
/** Distance from that centre at which a ball is exactly touching the face. */
const CONTACT_R = PADDLE_ARC_R + BALL_RADIUS;

/**
 * Half-width of the region in which a ball counts as struck.
 *
 * Derived from the arc rather than authored: a ball touching the very end of
 * the face has its centre pushed outwards along that end's normal, which puts
 * it `PADDLE_HALF_W * CONTACT_R / PADDLE_ARC_R` from the paddle's centre. That
 * is a shade under the flat paddle's `PADDLE_HALF_W + BALL_RADIUS`, because
 * the arc's ends are the part that recedes — the paddle really is slightly
 * less forgiving at the tips now, and it looks it.
 */
const CONTACT_HALF_W = (PADDLE_HALF_W * CONTACT_R) / PADDLE_ARC_R;

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
 * Send the ball back along the paddle face's normal at the point of contact.
 *
 * The ball is sitting exactly {@link CONTACT_R} from `arcCy` when this is
 * called — `advanceBall` has already stepped it to the moment of touch — so
 * the vector from the arc's centre through the ball IS the surface normal, and
 * normalising it is the entire bounce.
 *
 * The incoming direction is deliberately discarded. That is not an
 * approximation of a physical reflection, it is the opposite of one: a true
 * reflection makes the return angle a function of two things the player is
 * tracking separately, whereas this makes it a function of one thing they can
 * see — where on the curve they caught it. Hit the middle of the bulge and the
 * ball goes back the way it came; hit near an end, where the face has turned
 * away, and it cuts. The steepest cut the geometry allows is
 * `asin(PADDLE_HALF_W / PADDLE_ARC_R)` ≈ 40°.
 */
function bounceOffPaddle(world: PongWorld, paddle: PaddleLike, arcCy: number): void {
  const ball = world.ball;

  let speed = ball.speed * BALL_SPEEDUP;
  if (speed > BALL_MAX_SPEED) speed = BALL_MAX_SPEED;

  let dx = ball.x - paddle.x;
  let dy = ball.y - arcCy;
  let length = Math.sqrt(dx * dx + dy * dy);
  if (length > 0) {
    dx /= length;
    dy /= length;
  } else {
    // Unreachable from a real contact — the ball would have to be standing on
    // the arc's centre, well behind the face. Guarded anyway: a zero here
    // would divide a NaN into the velocity and there is no recovering a world
    // once the ball's direction is NaN.
    dx = 0;
    dy = arcCy > ball.y ? -1 : 1;
  }

  // Keep a floor under the vertical component so a rally cannot degenerate
  // into a ball creeping sideways along the paddle line. The arc cannot
  // currently produce one — see MIN_VERTICAL_RATIO.
  if (dy < 0 && dy > -MIN_VERTICAL_RATIO) dy = -MIN_VERTICAL_RATIO;
  else if (dy > 0 && dy < MIN_VERTICAL_RATIO) dy = MIN_VERTICAL_RATIO;
  length = Math.sqrt(dx * dx + dy * dy);
  dx /= length;
  dy /= length;

  ball.speed = speed;
  ball.vx = dx * speed;
  ball.vy = dy * speed;
  world.meta.rallyHits += 1;
}

/**
 * Time within `limit` at which the ball first touches a paddle's arc, or -1.
 *
 * The swept test: the ball's centre travels a straight segment, and it touches
 * a face of radius {@link PADDLE_ARC_R} exactly when its centre reaches
 * {@link CONTACT_R} from that face's centre. One quadratic, solved for the
 * near root — the moment of *entry*, never the exit.
 *
 * Both early returns matter:
 *  - `c <= 0` means the ball is already inside the contact circle, and it does
 *    two jobs. On the substep straight after a bounce the ball is sitting on
 *    the surface to within a rounding error, and taking a root there would
 *    bounce it a second time and pin it to the paddle. Across ticks it is also
 *    what makes a MISS stay missed: `facesLive` only survives one tick, so a
 *    ball that went round the end of the face and is now inside the circle
 *    would otherwise be re-tested on the next tick and struck from behind.
 *  - `b >= 0` means the ball is moving away from the arc's centre, so there is
 *    nothing ahead of it to hit.
 *
 * The pair makes the paddle's tips stricter than the old flat bar's, which
 * would catch anything within `PADDLE_HALF_W + BALL_RADIUS` at the moment the
 * ball crossed the plane, however late the paddle arrived. Here, a ball that
 * enters the contact circle off the arc has — provably, for a ball with any
 * downward speed at all — passed below the rim of the face on its way in, so
 * it is level with the tips rather than in front of them. That is a real
 * change in feel at the very ends of the paddle, and it is the one the drawn
 * shape now promises.
 */
function arcImpactTime(
  ball: PongWorld['ball'],
  paddleX: number,
  arcCy: number,
  limit: number,
): number {
  const dx = ball.x - paddleX;
  const dy = ball.y - arcCy;

  const c = dx * dx + dy * dy - CONTACT_R * CONTACT_R;
  if (c <= 0) return -1;

  const b = 2 * (dx * ball.vx + dy * ball.vy);
  if (b >= 0) return -1;

  const a = ball.vx * ball.vx + ball.vy * ball.vy;
  if (a <= 0) return -1;

  const disc = b * b - 4 * a * c;
  if (disc <= 0) return -1;

  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t <= 0 || t > limit) return -1;
  return t;
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
  // Once the ball has gone past a paddle without being struck, stop testing
  // the faces: it is on its way to the goal line, and it is by then INSIDE the
  // contact circle it just went around, which the impact test would otherwise
  // keep re-solving.
  let facesLive = true;

  for (let guard = 0; guard < MAX_SUBSTEPS && remaining > 0; guard++) {
    const endX = ball.x + ball.vx * remaining;

    let toi = remaining;
    // 0 = no impact, 1 = side wall, 2 = bottom paddle face, 3 = top face.
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

    if (facesLive) {
      // Only the face the ball is flying at is worth solving; the one behind
      // it can only be reached by a ball that has already scored.
      if (ball.vy > 0) {
        const t = arcImpactTime(ball, world.bottom.x, BOTTOM_ARC_CY, toi);
        if (t >= 0) {
          toi = t;
          kind = 2;
        }
      } else if (ball.vy < 0) {
        const t = arcImpactTime(ball, world.top.x, TOP_ARC_CY, toi);
        if (t >= 0) {
          toi = t;
          kind = 3;
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
      const paddle = kind === 2 ? world.bottom : world.top;
      const arcCy = kind === 2 ? BOTTOM_ARC_CY : TOP_ARC_CY;
      const offset = ball.x - paddle.x;
      const distance = offset < 0 ? -offset : offset;
      if (distance <= CONTACT_HALF_W) {
        bounceOffPaddle(world, paddle, arcCy);
      } else {
        // Round the end of the face: the ball is level with the paddle but
        // outside it, on its way to the goal. Retiring the face here is what
        // stops the next substep re-solving the same contact circle it is now
        // sitting inside.
        facesLive = false;
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
