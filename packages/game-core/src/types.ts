/**
 * Structural interfaces for the Pong simulation.
 *
 * Every type here is declared as an *interface over plain numeric fields* and
 * never as a class. That is deliberate: the server's Colyseus `Schema`
 * instances and the client's materialised prediction world must BOTH satisfy
 * these shapes structurally, so that one single `step()` implementation runs
 * unmodified on both sides. Rollback reconciliation is only correct when both
 * sides execute byte-identical arithmetic.
 */

/** Which side of the field a player defends. 0 = bottom (near), 1 = top (far). */
export type Side = 0 | 1;

export const SIDE_BOTTOM: Side = 0;
export const SIDE_TOP: Side = 1;

/** Match lifecycle. Encoded as a number so it can live in a Schema `uint8`. */
export const Phase = {
  /** Room open, waiting for the second player to tap the invite. */
  WAITING: 0,
  /** Both present; a short countdown runs before the serve. */
  COUNTDOWN: 1,
  /** Ball in play. */
  PLAYING: 2,
  /** A player dropped; simulation frozen pending reconnection. */
  PAUSED: 3,
  /** Match over. */
  ENDED: 4,
} as const;
export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export const EndReason = {
  NONE: 0,
  /** Someone reached the score target. */
  SCORE: 1,
  /** Opponent failed to reconnect inside the grace window. */
  DISCONNECT: 2,
  /** A player explicitly left. */
  FORFEIT: 3,
} as const;
export type EndReasonValue = (typeof EndReason)[keyof typeof EndReason];

export interface BallLike {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Current scalar speed, in field units per second. */
  speed: number;
}

export interface PaddleLike {
  /** Authoritative centre X of the paddle. */
  x: number;
  /**
   * The player's most recently accepted *desired* X.
   *
   * The client never writes `x` directly — it writes `targetX`, and the
   * simulation moves `x` towards it under {@link PADDLE_MAX_SPEED}. This one
   * rule is the entire teleporting-paddle anti-cheat, and it lives here so
   * that client prediction and server truth agree by construction.
   */
  targetX: number;
}

/**
 * Scalar match state. On the server this is the root `Schema`; on the client
 * it is the materialised view of the same fields.
 */
export interface MetaLike {
  tick: number;
  phase: number;
  scoreBottom: number;
  scoreTop: number;
  /** Which side serves the next ball. */
  serveTo: number;
  /** Ticks remaining in the pre-serve countdown. */
  countdown: number;
  /** Paddle hits in the current rally (drives the "longest rally" stat). */
  rallyHits: number;
  /** Seeded PRNG state. Advancing it is part of the deterministic step. */
  rng: number;
  endReason: number;
}

/**
 * The complete simulated world.
 *
 * This is exactly the object handed to Colyseus' `SimReconciler` on the client
 * (as `Materialize<E>`) and assembled from the room's Schema on the server.
 */
export interface PongWorld {
  meta: MetaLike;
  ball: BallLike;
  /** Paddle defending the bottom edge. */
  bottom: PaddleLike;
  /** Paddle defending the top edge. */
  top: PaddleLike;
}

/**
 * The wire input, one per simulation tick.
 *
 * Flat primitives only — Colyseus' input encoder requires it. `targetX` is a
 * *desire*, not a position; see {@link PaddleLike.targetX}.
 */
export interface PongInput {
  targetX: number;
}

/** Everything the caller may hand a single step. */
export interface StepCommand {
  /** Which paddle this command steers, or `null` for a server-side full step. */
  side: Side;
  input: PongInput;
}
