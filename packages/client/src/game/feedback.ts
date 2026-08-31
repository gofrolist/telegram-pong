/**
 * Match feedback: the haptic and the flash behind a paddle hit and a point.
 *
 * This is the consumer of the prediction adapter's event channels, and it
 * exists as its own module for the reason the adapter's header gives: nothing
 * outside `net/predictionAdapter.ts` may touch the Colyseus prediction API, so
 * the netcode hands discrete events to a plain sink and this is the plain sink.
 * It knows nothing about rooms, reconcilers or acks.
 *
 * **All state here is transient by construction.** Every cue is a timestamp
 * plus a decay, which means there is nothing to reset between points, nothing
 * to leak when a match ends, and — the part that matters — a cue that turns
 * out to have been mispredicted has already faded on its own by the time the
 * server disagrees. That is why the retraction path ({@link
 * MatchFeedback.pointRejected}) can afford to be as small as it is.
 */

import { SIDE_BOTTOM, type Side } from '@pong/game-core';

import { hapticBallStruck, hapticPointScored } from '../telegram.js';

/**
 * How long a struck paddle glows, in ms.
 *
 * Short on purpose. At the ball's top speed a rally hit is 1.5s from the next
 * one, so this is nowhere near colliding with itself — the limit is the other
 * end, where a glow that outlasts the eye's sense of the impact stops reading
 * as "that paddle hit it" and starts reading as "that paddle is lit up".
 */
const HIT_FLASH_MS = 180;

/**
 * How long the field washes over after a point, in ms.
 *
 * Longer than a hit because it is the only thing marking the moment: the score
 * numerals are drawn faint behind the play (see the renderer) and the ball has
 * already been parked at the centre by the time anyone looks up.
 */
const POINT_FLASH_MS = 450;

/** What the renderer needs from a frame of feedback, and only that. */
export interface FeedbackFrame {
  /** 0..1 glow on the paddle defending the BOTTOM of the field. */
  bottomFlash: number;
  /** 0..1 glow on the paddle defending the TOP of the field. */
  topFlash: number;
  /** 0..1 wash over the whole field after a point. */
  pointFlash: number;
  /** Whether the point being washed was the local player's. Tints the wash. */
  pointFlashMine: boolean;
}

const NO_FEEDBACK: FeedbackFrame = {
  bottomFlash: 0,
  topFlash: 0,
  pointFlash: 0,
  pointFlashMine: false,
};

/**
 * How many cues arrived early versus late, over one match.
 *
 * This is the far-plane misprediction rate *as the player felt it*, which is
 * not quite what the correction figures measure: a correction is how far the
 * world moved, whereas `lateHits` counts the times the game could not tell you
 * something until the server said so. It rides home in the end-of-match
 * netcode sample beside the corrections, because a build that quietly stopped
 * predicting would look identical in every other column.
 */
export interface FeedbackCounts extends Record<string, number> {
  /** Cues delivered at the predicted moment, ~one round trip early. */
  predictedHits: number;
  predictedPoints: number;
  /** Cues that had to wait for the server, because nothing was predicted. */
  lateHits: number;
  latePoints: number;
  /** Predicted points the server then declined to confirm. */
  rejectedPoints: number;
}

/** The physical half, injected so a test can run without a Telegram host. */
export interface Haptics {
  ballStruck(mine: boolean): void;
  pointScored(mine: boolean): void;
}

const telegramHaptics: Haptics = {
  ballStruck: hapticBallStruck,
  pointScored: hapticPointScored,
};

export interface MatchFeedbackOptions {
  haptics?: Haptics;
  /** Monotonic clock. Shares an origin with the rAF timestamp in the browser. */
  now?: () => number;
}

/**
 * Decay curve for a cue: 1 at the moment it fired, 0 once its window is up.
 *
 * Squared rather than linear, so the cue is brightest for the first instant
 * and spends most of its life nearly gone. A linear fade on a 180ms glow reads
 * as a paddle that lights up and *stays* lit for a beat.
 */
function intensity(firedAt: number, now: number, windowMs: number): number {
  if (firedAt === 0) return 0;
  const t = (now - firedAt) / windowMs;
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const remaining = 1 - t;
  return remaining * remaining;
}

/**
 * Turns the netcode's discrete events into something a player can feel and
 * see. Implements the adapter's event sink; see `MatchEventSink` there for
 * what `predicted` means on each call.
 */
export class MatchFeedback {
  private readonly mySide: Side;
  private readonly haptics: Haptics;
  private readonly now: () => number;

  private bottomHitAt = 0;
  private topHitAt = 0;
  private pointAt = 0;
  private pointMine = false;

  private readonly counts: FeedbackCounts = {
    predictedHits: 0,
    predictedPoints: 0,
    lateHits: 0,
    latePoints: 0,
    rejectedPoints: 0,
  };

  constructor(mySide: Side, options: MatchFeedbackOptions = {}) {
    this.mySide = mySide;
    this.haptics = options.haptics ?? telegramHaptics;
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * A paddle struck the ball. `side` names the paddle in FIELD coordinates —
   * the renderer owns the mirroring, and handing it a screen-relative side
   * here would mean two places that both think they know which end is yours.
   */
  hit(side: Side, predicted: boolean): void {
    const at = this.now();
    if (side === SIDE_BOTTOM) this.bottomHitAt = at;
    else this.topHitAt = at;

    if (predicted) this.counts.predictedHits += 1;
    else this.counts.lateHits += 1;

    this.haptics.ballStruck(side === this.mySide);
  }

  /** A point landed. `scorer` is the side that gained it, in field terms. */
  point(scorer: Side, predicted: boolean): void {
    this.pointAt = this.now();
    this.pointMine = scorer === this.mySide;

    if (predicted) this.counts.predictedPoints += 1;
    else this.counts.latePoints += 1;

    this.haptics.pointScored(this.pointMine);
  }

  /**
   * A predicted point did not happen — a paddle saved it after all.
   *
   * The wash is retracted; the buzz cannot be, and is deliberately not
   * apologised for with a second one — a corrective buzz would just be a
   * second wrong signal on top of the first.
   *
   * This is a BELOW-the-cliff path only. Above
   * `EVENT_PREDICTION_RTT_CEILING_MS` no point is predicted at either plane,
   * so none can be rejected; a nonzero `rejectedPoints` on a slow link means
   * the gate is not doing what it says. Under the cliff the usual source is a
   * far-plane point (one of MINE) that the opponent's paddle turned out to
   * reach, and it is rare there — that is the latency band where the harness
   * measures zero mispredicted far reversals, not a band where it measures
   * few.
   */
  pointRejected(): void {
    this.pointAt = 0;
    this.counts.rejectedPoints += 1;
  }

  /** The cues currently alive. Called once per rendered frame. */
  read(): FeedbackFrame {
    const now = this.now();
    const bottomFlash = intensity(this.bottomHitAt, now, HIT_FLASH_MS);
    const topFlash = intensity(this.topHitAt, now, HIT_FLASH_MS);
    const pointFlash = intensity(this.pointAt, now, POINT_FLASH_MS);

    // The common case by a wide margin — a rally spends nearly all of its
    // frames with nothing alive — so hand back the shared empty frame rather
    // than allocating one per frame at 120fps.
    if (bottomFlash === 0 && topFlash === 0 && pointFlash === 0) return NO_FEEDBACK;

    return { bottomFlash, topFlash, pointFlash, pointFlashMine: this.pointMine };
  }

  /** Early-versus-late tally for the end-of-match netcode sample. */
  summary(): FeedbackCounts {
    return { ...this.counts };
  }
}
