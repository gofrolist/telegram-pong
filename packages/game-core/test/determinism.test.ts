import { describe, expect, it } from 'vitest';
import {
  FIELD_W,
  PADDLE_HALF_W,
  PADDLE_MAX_SPEED,
  Phase,
  SCORE_TO_WIN,
  SIDE_BOTTOM,
  SIDE_TOP,
  TICK_DT,
  createWorld,
  nextFloat,
  seedFromString,
  startMatch,
  step,
  stepWithInput,
  worldSignature,
  type PongInput,
  type PongWorld,
  type Side,
} from '../src/index.js';

/**
 * A scripted input stream. Deliberately jagged — smooth inputs would let a
 * subtly non-deterministic simulation pass by never exercising the clamp.
 */
function scriptedInput(side: Side, tick: number): PongInput {
  const phase = side === SIDE_BOTTOM ? 0 : 37;
  const t = tick + phase;
  // A sawtooth with occasional far jumps, which the speed cap must absorb.
  const base = ((t * 13) % 100) + 1;
  const jump = t % 17 === 0 ? (t % 34 === 0 ? -500 : 900) : 0;
  return { targetX: base + jump };
}

function runMatch(seed: number, ticks: number): PongWorld {
  const world = createWorld(seed);
  startMatch(world, seed, SIDE_BOTTOM);
  for (let tick = 0; tick < ticks; tick++) {
    stepWithInput(world, SIDE_BOTTOM, scriptedInput(SIDE_BOTTOM, tick), TICK_DT);
    // The top player's input is folded in before the same tick advances, which
    // mirrors the server: both inputs are consumed, then the world steps once.
    world.top.targetX = scriptedInput(SIDE_TOP, tick).targetX;
  }
  return world;
}

describe('determinism', () => {
  it('produces an identical world from the same seed and inputs', () => {
    const a = runMatch(seedFromString('room-alpha'), 4000);
    const b = runMatch(seedFromString('room-alpha'), 4000);
    expect(worldSignature(b)).toBe(worldSignature(a));
  });

  it('produces the same trajectory tick-by-tick across two runs', () => {
    const seed = seedFromString('room-bravo');
    const first: string[] = [];
    const second: string[] = [];

    for (const sink of [first, second]) {
      const world = createWorld(seed);
      startMatch(world, seed, SIDE_TOP);
      for (let tick = 0; tick < 1500; tick++) {
        stepWithInput(world, SIDE_BOTTOM, scriptedInput(SIDE_BOTTOM, tick), TICK_DT);
        world.top.targetX = scriptedInput(SIDE_TOP, tick).targetX;
        sink.push(worldSignature(world));
      }
    }

    expect(second).toEqual(first);
  });

  it('diverges for different seeds', () => {
    const a = runMatch(seedFromString('room-alpha'), 2000);
    const b = runMatch(seedFromString('room-charlie'), 2000);
    expect(worldSignature(b)).not.toBe(worldSignature(a));
  });

  it('replaying a suffix from a snapshot reproduces the live world', () => {
    // This is precisely what rollback does: adopt server truth at tick N, then
    // re-apply the locally buffered inputs. If it did not match, every
    // correction would be visible as a stutter.
    const seed = seedFromString('room-delta');
    const live = createWorld(seed);
    startMatch(live, seed, SIDE_BOTTOM);

    const snapshotAt = 600;
    let snapshot: PongWorld | null = null;

    for (let tick = 0; tick < 900; tick++) {
      if (tick === snapshotAt) {
        snapshot = structuredClone(live);
      }
      stepWithInput(live, SIDE_BOTTOM, scriptedInput(SIDE_BOTTOM, tick), TICK_DT);
      world_setTop(live, tick);
    }

    expect(snapshot).not.toBeNull();
    const replay = snapshot!;
    for (let tick = snapshotAt; tick < 900; tick++) {
      stepWithInput(replay, SIDE_BOTTOM, scriptedInput(SIDE_BOTTOM, tick), TICK_DT);
      world_setTop(replay, tick);
    }

    expect(worldSignature(replay)).toBe(worldSignature(live));
  });

  it('never introduces a non-finite number over a long match', () => {
    const world = createWorld(seedFromString('room-echo'));
    startMatch(world, seedFromString('room-echo'), SIDE_BOTTOM);
    for (let tick = 0; tick < 20000; tick++) {
      stepWithInput(world, SIDE_BOTTOM, scriptedInput(SIDE_BOTTOM, tick), TICK_DT);
      world_setTop(world, tick);
      for (const value of worldSignature(world).split('|')) {
        expect(Number.isFinite(Number(value))).toBe(true);
      }
      if (world.meta.phase === Phase.ENDED) break;
    }
  });
});

function world_setTop(world: PongWorld, tick: number): void {
  world.top.targetX = scriptedInput(SIDE_TOP, tick).targetX;
}

describe('seeded prng', () => {
  it('is a pure function of its state word', () => {
    const [s1, f1] = nextFloat(12345);
    const [s2, f2] = nextFloat(12345);
    expect(s2).toBe(s1);
    expect(f2).toBe(f1);
  });

  it('stays inside [0, 1)', () => {
    let state = seedFromString('prng');
    for (let i = 0; i < 100000; i++) {
      const [next, value] = nextFloat(state);
      state = next;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('paddle speed cap', () => {
  const MAX_PER_TICK = PADDLE_MAX_SPEED * TICK_DT;

  it('never moves a paddle further than the cap in one tick', () => {
    const world = createWorld(1);
    startMatch(world, 1, SIDE_BOTTOM);

    // Ask for the far edge from a standing start, every tick, forever.
    let previous = world.bottom.x;
    for (let tick = 0; tick < 500; tick++) {
      const targetX = tick % 2 === 0 ? FIELD_W * 10 : -FIELD_W * 10;
      stepWithInput(world, SIDE_BOTTOM, { targetX }, TICK_DT);
      const travelled = Math.abs(world.bottom.x - previous);
      expect(travelled).toBeLessThanOrEqual(MAX_PER_TICK + 1e-9);
      previous = world.bottom.x;
    }
  });

  it('cannot teleport across the field, however extreme the request', () => {
    const world = createWorld(2);
    startMatch(world, 2, SIDE_BOTTOM);
    world.bottom.x = PADDLE_HALF_W;
    world.bottom.targetX = PADDLE_HALF_W;

    stepWithInput(world, SIDE_BOTTOM, { targetX: FIELD_W - PADDLE_HALF_W }, TICK_DT);

    expect(world.bottom.x).toBeCloseTo(PADDLE_HALF_W + MAX_PER_TICK, 9);
    expect(world.bottom.x).toBeLessThan(FIELD_W - PADDLE_HALF_W);
  });

  it('keeps the paddle inside the field', () => {
    const world = createWorld(3);
    startMatch(world, 3, SIDE_BOTTOM);
    for (let tick = 0; tick < 200; tick++) {
      stepWithInput(world, SIDE_BOTTOM, { targetX: -9999 }, TICK_DT);
      expect(world.bottom.x).toBeGreaterThanOrEqual(PADDLE_HALF_W);
    }
    for (let tick = 0; tick < 400; tick++) {
      stepWithInput(world, SIDE_BOTTOM, { targetX: 9999 }, TICK_DT);
      expect(world.bottom.x).toBeLessThanOrEqual(FIELD_W - PADDLE_HALF_W);
    }
  });

  it('scrubs non-finite input rather than poisoning the world', () => {
    const world = createWorld(4);
    startMatch(world, 4, SIDE_BOTTOM);
    stepWithInput(world, SIDE_BOTTOM, { targetX: Number.NaN }, TICK_DT);
    stepWithInput(world, SIDE_BOTTOM, { targetX: Number.POSITIVE_INFINITY }, TICK_DT);
    stepWithInput(world, SIDE_BOTTOM, { targetX: Number.NEGATIVE_INFINITY }, TICK_DT);
    expect(Number.isFinite(world.bottom.x)).toBe(true);
    expect(Number.isFinite(world.bottom.targetX)).toBe(true);
  });
});

describe('match rules', () => {
  it('freezes while waiting or paused', () => {
    const world = createWorld(5);
    startMatch(world, 5, SIDE_BOTTOM);
    world.meta.phase = Phase.PAUSED;
    const before = worldSignature(world);
    for (let i = 0; i < 100; i++) step(world, TICK_DT);
    expect(worldSignature(world)).toBe(before);
  });

  it('ends at the score target and stops advancing', () => {
    const world = createWorld(6);
    startMatch(world, 6, SIDE_BOTTOM);
    world.meta.scoreBottom = SCORE_TO_WIN - 1;

    // Park the top paddle far from the ball so the bottom player wins a point.
    world.top.x = PADDLE_HALF_W;
    world.top.targetX = PADDLE_HALF_W;

    let guard = 0;
    while (world.meta.phase !== Phase.ENDED && guard++ < 10000) {
      // Bottom tracks the ball perfectly; top does not move.
      stepWithInput(world, SIDE_BOTTOM, { targetX: world.ball.x }, TICK_DT);
      world.top.targetX = PADDLE_HALF_W;
    }

    expect(world.meta.phase).toBe(Phase.ENDED);
    expect(world.meta.scoreBottom).toBe(SCORE_TO_WIN);

    const frozen = worldSignature(world);
    for (let i = 0; i < 50; i++) step(world, TICK_DT);
    expect(worldSignature(world)).toBe(frozen);
  });

  it('never lets the ball tunnel through a tracking paddle', () => {
    const world = createWorld(7);
    startMatch(world, 7, SIDE_BOTTOM);

    for (let tick = 0; tick < 30000; tick++) {
      // Both paddles track the ball exactly, so no point should ever be scored.
      stepWithInput(world, SIDE_BOTTOM, { targetX: world.ball.x }, TICK_DT);
      world.top.targetX = world.ball.x;
      world.top.x = world.ball.x < PADDLE_HALF_W ? PADDLE_HALF_W : world.ball.x;
      world.bottom.x = world.ball.x < PADDLE_HALF_W ? PADDLE_HALF_W : world.ball.x;
      if (world.bottom.x > FIELD_W - PADDLE_HALF_W) world.bottom.x = FIELD_W - PADDLE_HALF_W;
      if (world.top.x > FIELD_W - PADDLE_HALF_W) world.top.x = FIELD_W - PADDLE_HALF_W;
    }

    expect(world.meta.scoreBottom).toBe(0);
    expect(world.meta.scoreTop).toBe(0);
    expect(world.meta.rallyHits).toBeGreaterThan(50);
  });
});
