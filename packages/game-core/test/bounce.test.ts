/**
 * The paddle face is an arc, and the bounce is its normal.
 *
 * These tests deliberately re-derive the arc from the exported constants
 * rather than reaching for the simulation's own private copy. The whole point
 * of a curved paddle is that the surface the player *sees* is the surface the
 * ball leaves along, and the renderer derives its arc the same independent
 * way — so a test that borrowed `sim.ts`'s derivation could not tell the two
 * apart if one of them drifted.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_MAX_SPEED,
  BALL_RADIUS,
  BALL_SPEEDUP,
  BALL_START_SPEED,
  BOTTOM_PLANE_Y,
  FIELD_W,
  PADDLE_ARC_R,
  PADDLE_BULGE,
  PADDLE_HALF_W,
  Phase,
  SIDE_BOTTOM,
  TICK_DT,
  createWorld,
  startMatch,
  step,
  type PongWorld,
} from '../src/index.js';

/** Centre of the circle the bottom paddle's face is cut from. */
const ARC_CY = BOTTOM_PLANE_Y - PADDLE_BULGE + PADDLE_ARC_R;
/** Distance from that centre at which a ball is touching the face. */
const CONTACT_R = PADDLE_ARC_R + BALL_RADIUS;
/** Furthest a ball's centre can be from the paddle's and still be struck. */
const CATCH_HALF_W = (PADDLE_HALF_W * CONTACT_R) / PADDLE_ARC_R;

/** High enough above the paddle for a clean approach, low enough to be quick. */
const DROP_FROM_Y = 120;

/**
 * A world mid-rally, with the ball dropped straight down the column `ballX`
 * and the bottom paddle parked at `paddleX`.
 *
 * Dropping *vertically* is what makes these tests readable: the ball's x never
 * changes before it lands, so the contact offset is exactly `ballX - paddleX`
 * and the expected normal can be written down in closed form.
 */
function droppingBall(ballX: number, paddleX: number, speed = BALL_START_SPEED): PongWorld {
  const world = createWorld(1);
  startMatch(world, 1, SIDE_BOTTOM);
  world.meta.phase = Phase.PLAYING;
  world.bottom.x = paddleX;
  world.bottom.targetX = paddleX;
  world.top.x = FIELD_W / 2;
  world.top.targetX = FIELD_W / 2;
  world.ball.x = ballX;
  world.ball.y = DROP_FROM_Y;
  world.ball.vx = 0;
  world.ball.vy = speed;
  world.ball.speed = speed;
  return world;
}

interface Bounce {
  vx: number;
  vy: number;
  speed: number;
  /** Tick index the bounce landed on — a proxy for how high up it happened. */
  tick: number;
}

/** Step until the ball turns round, and report the state at that moment. */
function rallyOneBounce(world: PongWorld): Bounce {
  for (let tick = 0; tick < 400; tick++) {
    const before = world.meta.rallyHits;
    step(world, TICK_DT);
    if (world.meta.rallyHits > before) {
      return { vx: world.ball.vx, vy: world.ball.vy, speed: world.ball.speed, tick };
    }
  }
  throw new Error('the ball never reached the paddle');
}

describe('the curved paddle face', () => {
  it('sends a centre hit straight back', () => {
    const hit = rallyOneBounce(droppingBall(50, 50));
    expect(hit.vx).toBeCloseTo(0, 9);
    expect(hit.vy).toBeLessThan(0);
  });

  it('returns the ball along the arc normal at the point of contact', () => {
    // The claim the whole design rests on. A ball touching the face at
    // horizontal offset `o` has its centre `o` across and `sqrt(R² - o²)`
    // above the arc's centre, so the outgoing unit vector is exactly that,
    // divided by the contact radius. Nothing about the INCOMING direction
    // appears — which is what makes the return readable off the curve.
    for (const offset of [-12, -10, -6, -2, 0, 3, 7, 11, 12]) {
      const hit = rallyOneBounce(droppingBall(50 + offset, 50));

      const normalX = offset / CONTACT_R;
      const normalY = -Math.sqrt(1 - normalX * normalX);

      expect(hit.vx / hit.speed).toBeCloseTo(normalX, 9);
      expect(hit.vy / hit.speed).toBeCloseTo(normalY, 9);
      // Always back up the field, never on through the paddle.
      expect(hit.vy).toBeLessThan(0);
    }
  });

  it('cuts harder the further from the middle the ball lands', () => {
    // Monotonic, which is what makes it a skill rather than a lottery.
    let previous = -1;
    for (const offset of [0, 2, 4, 6, 8, 10, 12]) {
      const hit = rallyOneBounce(droppingBall(50 + offset, 50));
      const cut = Math.abs(hit.vx / hit.speed);
      expect(cut).toBeGreaterThan(previous);
      previous = cut;
    }
    // The extreme is the arc's own end: sin(asin(PADDLE_HALF_W / PADDLE_ARC_R)).
    expect(previous).toBeLessThanOrEqual(PADDLE_HALF_W / PADDLE_ARC_R + 1e-9);
  });

  it('is convex: a centre hit is intercepted before an edge hit', () => {
    // Proves the bulge is in the COLLISION and not only in the drawing. Both
    // balls fall down the same field at the same speed from the same height,
    // so an earlier tick means a contact higher up the field — and the middle
    // of the face is the part that reaches out.
    //
    // Deliberately slow: at the ball's real speed one tick is 2 field units,
    // which is close enough to the bulge itself to make the comparison a
    // rounding argument rather than a measurement.
    const centre = rallyOneBounce(droppingBall(50, 50, 20));
    const edge = rallyOneBounce(droppingBall(60, 50, 20));
    expect(centre.tick).toBeLessThan(edge.tick);
  });

  it('lets a ball past the end of the face rather than catching it flat', () => {
    // Just outside the reach of the arc's end. A flat paddle of the same
    // half-width plus a ball radius would still have returned this one.
    const world = droppingBall(50 + CATCH_HALF_W + 0.5, 50);
    for (let tick = 0; tick < 400; tick++) {
      step(world, TICK_DT);
      if (world.meta.scoreTop > 0) break;
    }
    expect(world.meta.rallyHits).toBe(0);
    expect(world.meta.scoreTop).toBe(1);
  });

  it('catches a ball just inside the end of the face', () => {
    // The other side of the same edge, so the test above is pinning a boundary
    // rather than just asserting that far-away balls are missed.
    const hit = rallyOneBounce(droppingBall(50 + CATCH_HALF_W - 0.5, 50));
    expect(hit.vy).toBeLessThan(0);
  });

  it('never gets stuck to the paddle it just bounced off', () => {
    // A contact circle re-solved on the substep after a hit would pin the ball
    // to the face, or bounce it twice inside one tick.
    const world = droppingBall(53, 50);
    rallyOneBounce(world);
    const hitsAtBounce = world.meta.rallyHits;
    for (let tick = 0; tick < 10; tick++) step(world, TICK_DT);
    expect(world.meta.rallyHits).toBe(hitsAtBounce);
    expect(world.ball.y).toBeLessThan(ARC_CY - CONTACT_R);
  });
});

describe('the rally speed ramp', () => {
  /** Pin both paddles under the ball so a rally simply continues. */
  function trackBall(world: PongWorld): void {
    const x = clampPaddle(world.ball.x);
    world.bottom.x = x;
    world.bottom.targetX = x;
    world.top.x = x;
    world.top.targetX = x;
  }

  it('multiplies the ball speed by BALL_SPEEDUP on every hit', () => {
    const world = droppingBall(50, 50);
    let expected = BALL_START_SPEED;

    for (let hit = 0; hit < 4; hit++) {
      for (let tick = 0; tick < 400; tick++) {
        const before = world.meta.rallyHits;
        trackBall(world);
        step(world, TICK_DT);
        if (world.meta.rallyHits > before) break;
      }
      expected = Math.min(expected * BALL_SPEEDUP, BALL_MAX_SPEED);
      expect(world.ball.speed).toBeCloseTo(expected, 6);
    }
  });

  it('reaches the cap inside a single rally, and stops there', () => {
    const world = droppingBall(50, 50);
    for (let tick = 0; tick < 4000; tick++) {
      trackBall(world);
      step(world, TICK_DT);
      expect(world.ball.speed).toBeLessThanOrEqual(BALL_MAX_SPEED + 1e-9);
    }
    // The ramp has to be spendable inside one rally, or it is a difficulty
    // curve nobody ever meets.
    expect(world.meta.rallyHits).toBeGreaterThan(10);
    expect(world.ball.speed).toBeCloseTo(BALL_MAX_SPEED, 6);
    // …and reaching it must not have let the ball through a tracking paddle.
    expect(world.meta.scoreBottom).toBe(0);
    expect(world.meta.scoreTop).toBe(0);
  });

  it('reaches the cap within ten hits, and is faster than the old ramp throughout', () => {
    // The number that decides whether the ramp is felt. Guards the pairing of
    // BALL_SPEEDUP with BALL_MAX_SPEED: either one retuned alone can quietly
    // push the cap back out of reach of a real rally.
    let speed = BALL_START_SPEED;
    let hits = 0;
    while (speed < BALL_MAX_SPEED && hits < 100) {
      speed = Math.min(speed * BALL_SPEEDUP, BALL_MAX_SPEED);
      hits += 1;
    }
    expect(hits).toBeLessThanOrEqual(10);

    // The ceiling came DOWN when the ramp got steeper, which only works
    // because the pair is faster than the old one everywhere a rally actually
    // lives. Guard that: six hits used to buy 30%, and must now buy more.
    let sixHits = BALL_START_SPEED;
    for (let hit = 0; hit < 6; hit++) sixHits = Math.min(sixHits * BALL_SPEEDUP, BALL_MAX_SPEED);
    expect(sixHits / BALL_START_SPEED).toBeGreaterThan(1.45);
  });
});

function clampPaddle(x: number): number {
  if (x < PADDLE_HALF_W) return PADDLE_HALF_W;
  if (x > FIELD_W - PADDLE_HALF_W) return FIELD_W - PADDLE_HALF_W;
  return x;
}
