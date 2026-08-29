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
 *   - `frame(desiredX)`, called once per animation frame: stages and sends the
 *     inputs due this frame, and advances the reconciler.
 *   - `read()`, a smoothed snapshot for the renderer.
 *
 * What it deliberately does NOT do: clock synchronisation, a snapshot buffer,
 * or a reconciliation loop. Those are the framework's, and hand-rolling them
 * alongside would produce two systems that disagree under exactly the network
 * conditions they exist to handle.
 */

import { Predict, type Room } from '@colyseus/sdk';
import {
  TICK_DT,
  sanitizeTargetX,
  stepWithInput,
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

/** The replicated sub-schemas the simulation runs over. */
interface WorldRefs {
  meta: MatchMeta;
  ball: Ball;
  bottom: Paddle;
  top: Paddle;
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
   */
  frame(desiredTargetX: number): void;
  /** Smoothed positions for this frame. Safe to call after `frame`. */
  read(): RenderSnapshot;
  /** Diagnostics for the netcode HUD. */
  stats(): { pending: number; correction: number };
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
export async function attachPrediction(room: PongRoom, mySide: Side): Promise<PredictionHandle> {
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
   * instead absorbed by the server's `idle: true` input option, which repeats
   * a player's last command when a tick arrives with nothing new.
   */
  const input = room.input<PongInput>({ mode: 'reliable' });

  const state = room.state;

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
      meta: state.meta,
      ball: state.ball,
      bottom: state.bottom,
      top: state.top,
    },
    // Smoothing over roughly two ticks. Long enough that a correction is a
    // glide rather than a jump, short enough that the ball is never
    // meaningfully behind the truth at the moment it reaches a paddle.
    smoothMs: 65,
    step: (ctx, world, command) => {
      // The SAME function the server's fixed timestep calls. This identity is
      // the whole reason the backend is TypeScript.
      stepWithInput(world as unknown as PongWorld, mySide, command, ctx.dt || TICK_DT);
    },
  });

  return {
    frame(desiredTargetX: number): void {
      const target = sanitizeTargetX(desiredTargetX);

      // How many fixed input steps are due this frame. On a 120 Hz phone this
      // is usually 0 and occasionally 1; on a stuttering one it may be 2 or 3.
      const steps = predict.tick();
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

    stats() {
      return {
        pending: sim.pendingCount,
        correction: sim.lastCorrectionMag,
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
