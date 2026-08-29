/**
 * Replicated room state for Pong.
 *
 * The four world sub-schemas (`meta`, `ball`, `bottom`, `top`) are shaped so
 * that `PongState` structurally satisfies `PongWorld` from the simulation.
 * That is what lets the server's tick and the client's rollback replay call the
 * *same* `stepWithInput()` — no adapter, no second implementation, no drift.
 *
 * **Declared with the `schema()` builder rather than `@type()` decorators.**
 * This file is compiled by three different toolchains — `tsc` for the type
 * check, esbuild (via `tsx`) for the dev server, and Vite/Rollup for the Mini
 * App — and only `tsc` honours `experimentalDecorators`. The others emit
 * ES-standard decorators, which `@colyseus/schema` does not implement, and the
 * failure is a runtime `TypeError` at import rather than a compile error. The
 * builder has no such hazard: it is a plain function call, so every toolchain
 * produces identical behaviour. It also removes the `useDefineForClassFields`
 * footgun entirely, since there are no class fields to define.
 *
 * `StateView` is not used here — Pong has no hidden information. See
 * `docs/ASSUMPTIONS.md`: hidden-information games are the reason the platform
 * exists, and the seam should be obvious to whoever adds the second one.
 */

import { schema, t } from '@colyseus/schema';
import {
  BALL_START_SPEED,
  FIELD_H,
  FIELD_W,
  Phase,
  SIDE_BOTTOM,
  type BallLike,
  type MetaLike,
  type PaddleLike,
} from '../index.js';

export const Ball = schema(
  {
    x: t.float32().default(FIELD_W / 2),
    y: t.float32().default(FIELD_H / 2),
    vx: t.float32().default(0),
    vy: t.float32().default(0),
    /** Current scalar speed, in field units per second. */
    speed: t.float32().default(BALL_START_SPEED),
  },
  'Ball',
);
export type Ball = InstanceType<typeof Ball>;

export const Paddle = schema(
  {
    x: t.float32().default(FIELD_W / 2),
    /**
     * Replicated so the *opponent's* client can run the shared step for both
     * paddles during rollback. Without it, a replayed tick would have to guess
     * where the other paddle was heading and the ball would diverge.
     */
    targetX: t.float32().default(FIELD_W / 2),
  },
  'Paddle',
);
export type Paddle = InstanceType<typeof Paddle>;

export const MatchMeta = schema(
  {
    tick: t.uint32().default(0),
    phase: t.uint8().default(Phase.WAITING),
    scoreBottom: t.uint8().default(0),
    scoreTop: t.uint8().default(0),
    serveTo: t.uint8().default(SIDE_BOTTOM),
    countdown: t.uint16().default(0),
    rallyHits: t.uint16().default(0),
    /**
     * PRNG state. Replicated because it is part of the simulation: a client
     * that rolls back over a serve must redraw the identical direction.
     */
    rng: t.int32().default(0),
    endReason: t.uint8().default(0),
  },
  'MatchMeta',
);
export type MatchMeta = InstanceType<typeof MatchMeta>;

/** Presence and identity. Not part of the simulation. */
export const PlayerInfo = schema(
  {
    sessionId: t.string().default(''),
    /** Telegram user id as a string — it exceeds 2^32 and `uint32` would wrap. */
    userId: t.string().default(''),
    name: t.string().default(''),
    photoUrl: t.string().default(''),
    /** 0 = bottom, 1 = top. */
    side: t.uint8().default(SIDE_BOTTOM),
    connected: t.boolean().default(true),
    /**
     * Seconds left in the reconnection grace period, counted down for BOTH
     * players so the one still online sees why the match froze and for how
     * long. The authoritative timer is Colyseus' `allowReconnection`; this is
     * only its display.
     */
    reconnectSecondsLeft: t.uint16().default(0),
  },
  'PlayerInfo',
);
export type PlayerInfo = InstanceType<typeof PlayerInfo>;

export const PongState = schema(
  {
    meta: t.ref(MatchMeta),
    ball: t.ref(Ball),
    bottom: t.ref(Paddle),
    top: t.ref(Paddle),

    players: t.map(PlayerInfo),

    /** The room's public code, so the client can build an invite link. */
    roomCode: t.string().default(''),
    /** `invite` today. Tagged so a future pool can be separated cleanly. */
    origin: t.string().default('invite'),
    /** Set once the match has been written to the database. */
    matchId: t.string().default(''),
  },
  'PongState',
);
export type PongState = InstanceType<typeof PongState>;

/**
 * Compile-time proof that the replicated state really does satisfy the
 * simulation's interfaces.
 *
 * If someone renames a field or narrows a type on either side, this fails to
 * compile — which is far cheaper than discovering the mismatch as a desync in
 * production.
 */
type _AssertBall = Ball extends BallLike ? true : never;
type _AssertPaddle = Paddle extends PaddleLike ? true : never;
type _AssertMeta = MatchMeta extends MetaLike ? true : never;
const _assertions: [_AssertBall, _AssertPaddle, _AssertMeta] = [true, true, true];
void _assertions;
