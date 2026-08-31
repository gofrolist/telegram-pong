/**
 * Arrow keys, for the desktop clients — `tdesktop` and the browser — where
 * there is no finger to rest on the field.
 *
 * The whole of the problem is an impedance mismatch. A key is a DIRECTION held
 * for a while; the wire carries an absolute POSITION, because that is what
 * makes the server's speed cap an anti-cheat rather than a suggestion (see
 * `movePaddle` in `game-core/sim.ts`). So a held key has to be integrated into
 * a target, and the two constants that integration is written around are both
 * about the moment the key comes UP:
 *
 *  - it travels at exactly `PADDLE_MAX_SPEED`, the speed the server would
 *    clamp it to anyway, so the target never runs ahead of the paddle it
 *    describes and letting go stops the paddle on the spot rather than at the
 *    end of a glide it had already been told to make;
 *  - it is clamped to the paddle's legal range, because a target left parked
 *    40 units inside a wall is 200ms of pressing the other way that does
 *    visibly nothing.
 *
 * Kept out of `MatchView` so it can be tested without a room, a canvas and a
 * frame loop — the same reason `MatchFeedback` lives next door.
 */

import { PADDLE_MAX_SPEED, sanitizeTargetX } from '@pong/game-core';

/**
 * Longest frame gap the integration will honour, in seconds.
 *
 * A tab backgrounded with a key held gets one enormous `dt` on the way back;
 * uncapped, that single frame flings the paddle into the wall.
 */
const MAX_STEP_SECONDS = 0.1;

/** Screen-space direction a key asks for, or 0 if it is not one of ours. */
function directionOf(key: string): number {
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return 0;
}

export class PaddleKeyboard {
  /** Screen directions currently held, most recently pressed last. */
  private readonly held: number[] = [];
  /** Whether the next step should start from the paddle rather than the target. */
  private seed = false;

  /**
   * @returns whether this was one of ours, and so whether the browser's own
   * handling of it — scrolling the page — should be prevented.
   */
  keyDown(key: string, repeat: boolean): boolean {
    const direction = directionOf(key);
    if (direction === 0) return false;
    // Claimed before the repeat check: the auto-repeats scroll the page too.
    if (repeat) return true;
    if (this.held.length === 0) this.seed = true;
    if (!this.held.includes(direction)) this.held.push(direction);
    return true;
  }

  keyUp(key: string): boolean {
    const direction = directionOf(key);
    if (direction === 0) return false;
    // Releasing one of two held keys hands the paddle back to the other,
    // which is what a player pressing left mid-right-press is asking for.
    const at = this.held.indexOf(direction);
    if (at >= 0) this.held.splice(at, 1);
    return true;
  }

  /**
   * Forget everything held.
   *
   * A window that loses focus stops delivering `keyup`, and a paddle that was
   * travelling when it went would travel until it hit the wall.
   */
  releaseAll(): void {
    this.held.length = 0;
  }

  /** Which way the paddle is being asked to go on screen: -1, 0 or +1. */
  get direction(): number {
    return this.held.length > 0 ? this.held[this.held.length - 1]! : 0;
  }

  /**
   * Advance the desired paddle position by one frame.
   *
   * @param targetX  the current desired position, in field units.
   * @param paddleX  where the paddle actually is. Read only on the first frame
   *   of a fresh press, so a key struck after a pointer drag begins its travel
   *   from the paddle rather than from wherever the finger left the target.
   * @param dtSeconds  time since the previous frame.
   * @param mirrored  true for the top player, whose view is flipped: their
   *   left is the field's right, the same inversion `pointerToFieldX` applies
   *   to a touch.
   * @returns the new desired position; `targetX` unchanged when nothing is held.
   */
  step(targetX: number, paddleX: number, dtSeconds: number, mirrored: boolean): number {
    const direction = this.direction;
    if (direction === 0) return targetX;

    let from = targetX;
    if (this.seed) {
      from = paddleX;
      this.seed = false;
    }

    const fieldDirection = mirrored ? -direction : direction;
    const dt = dtSeconds > MAX_STEP_SECONDS ? MAX_STEP_SECONDS : dtSeconds;
    return sanitizeTargetX(from + PADDLE_MAX_SPEED * dt * fieldDirection);
  }
}
