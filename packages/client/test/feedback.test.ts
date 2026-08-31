/**
 * Match feedback: the cue decay, and the early/late bookkeeping.
 *
 * Both halves are worth pinning. The decay because it is the only thing
 * standing between a struck paddle and a paddle that stays lit — there is no
 * clear-the-flag path anywhere in the module, by design, so if the curve ever
 * stops reaching zero nothing else will notice. The tally because it is
 * telemetry: it is read once, at the end of a match, on a device nobody is
 * holding, and a miscount there is indistinguishable from a netcode change.
 */

import { describe, expect, it } from 'vitest';

import { SIDE_BOTTOM, SIDE_TOP } from '@pong/game-core';

import { MatchFeedback, type Haptics } from '../src/game/feedback.js';

/** A clock the test drives by hand, and a haptics device that only records. */
function harness(mySide = SIDE_BOTTOM) {
  let now = 1000;
  const struck: boolean[] = [];
  const scored: boolean[] = [];
  const haptics: Haptics = {
    ballStruck: (mine) => struck.push(mine),
    pointScored: (mine) => scored.push(mine),
  };
  const feedback = new MatchFeedback(mySide, { haptics, now: () => now });
  return {
    feedback,
    struck,
    scored,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('MatchFeedback', () => {
  it('lights only the paddle that was struck', () => {
    const { feedback } = harness();

    feedback.hit(SIDE_TOP, true);

    const frame = feedback.read();
    expect(frame.topFlash).toBe(1);
    expect(frame.bottomFlash).toBe(0);
  });

  it('decays a hit to nothing, and stays there', () => {
    const { feedback, advance } = harness();

    feedback.hit(SIDE_BOTTOM, true);
    expect(feedback.read().bottomFlash).toBe(1);

    // Mid-window: dimmer, but still alight.
    advance(90);
    const mid = feedback.read().bottomFlash;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    // Past the window, and long past it. The second check is the one that
    // matters: nothing resets these, so a curve that goes negative or wraps
    // would only ever be caught here.
    advance(200);
    expect(feedback.read().bottomFlash).toBe(0);
    advance(60_000);
    expect(feedback.read().bottomFlash).toBe(0);
  });

  it('buzzes harder for your own paddle than for theirs', () => {
    const { feedback, struck } = harness(SIDE_BOTTOM);

    feedback.hit(SIDE_BOTTOM, true);
    feedback.hit(SIDE_TOP, true);

    expect(struck).toEqual([true, false]);
  });

  it('tints the point wash by who scored', () => {
    const { feedback, scored } = harness(SIDE_BOTTOM);

    feedback.point(SIDE_BOTTOM, true);
    expect(feedback.read().pointFlashMine).toBe(true);
    expect(scored).toEqual([true]);

    feedback.point(SIDE_TOP, false);
    expect(feedback.read().pointFlashMine).toBe(false);
    expect(scored).toEqual([true, false]);
  });

  it('retracts a rejected point immediately', () => {
    const { feedback } = harness();

    feedback.point(SIDE_BOTTOM, true);
    expect(feedback.read().pointFlash).toBeGreaterThan(0);

    feedback.pointRejected();
    expect(feedback.read().pointFlash).toBe(0);
  });

  it('separates cues that arrived early from cues that had to wait', () => {
    const { feedback } = harness();

    feedback.hit(SIDE_BOTTOM, true);
    feedback.hit(SIDE_TOP, false);
    feedback.hit(SIDE_TOP, false);
    feedback.point(SIDE_BOTTOM, true);
    feedback.point(SIDE_TOP, false);
    feedback.pointRejected();

    expect(feedback.summary()).toEqual({
      predictedHits: 1,
      lateHits: 2,
      predictedPoints: 1,
      latePoints: 1,
      rejectedPoints: 1,
    });
  });

  it('reports a quiet frame as fully quiet', () => {
    const { feedback, advance } = harness();

    feedback.hit(SIDE_BOTTOM, true);
    feedback.point(SIDE_TOP, true);
    advance(1000);

    expect(feedback.read()).toEqual({
      bottomFlash: 0,
      topFlash: 0,
      pointFlash: 0,
      pointFlashMine: false,
    });
  });
});
