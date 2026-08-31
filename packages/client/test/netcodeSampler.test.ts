/**
 * The netcode summary's arithmetic.
 *
 * Worth testing precisely because nothing downstream can check it: these
 * numbers land in a table and are then read as fact. A percentile that is
 * quietly wrong does not fail anything — it sends someone tuning the wrong
 * knob, which is more expensive than a crash.
 */

import { describe, expect, it } from 'vitest';

import { NetcodeSampler } from '../src/net/netcodeSampler.js';

/** Drive the sampler at 60fps for `seconds`, with `stats` per frame. */
function run(
  sampler: NetcodeSampler,
  seconds: number,
  stats: (frame: number) => Parameters<NetcodeSampler['frame']>[1] extends () => infer S ? S : never,
): number {
  const frames = Math.round(seconds * 60);
  let now = 1000;
  for (let i = 0; i <= frames; i++) {
    sampler.frame(now, () => stats(i));
    now += 1000 / 60;
  }
  return now;
}

const steady = (over: Partial<Record<string, number>> = {}) => () => ({
  pending: 5,
  correction: 1,
  driftEma: 0.5,
  driftPeak: 2,
  reconcileSeq: 0,
  ballCorrection: 0.2,
  ballVelCorrection: 1,
  selfPaddleCorrection: 0,
  oppPaddleCorrection: 0.4,
  leadMs: 170,
  rttMs: 120,
  jitterMs: 4,
  ...over,
});

describe('NetcodeSampler', () => {
  it('refuses to summarize a match too short to say anything about', () => {
    const sampler = new NetcodeSampler();
    const end = run(sampler, 0.5, steady());
    // Half a second at 4Hz is two samples; the floor is eight.
    expect(sampler.summarize(end)).toBeNull();
  });

  it('reports fps from frames actually rendered', () => {
    const sampler = new NetcodeSampler();
    const end = run(sampler, 10, steady());
    const summary = sampler.summarize(end)!;

    expect(summary).not.toBeNull();
    expect(summary.fps).toBeGreaterThan(58);
    expect(summary.fps).toBeLessThan(62);
    // 10s at 4Hz, less the first frame which only starts the clock.
    expect(summary.samples).toBeGreaterThanOrEqual(38);
  });

  it('separates a persistent drift from a one-off spike', () => {
    // The distinction the whole report exists to make: a steady ema means the
    // prediction is diverging, a lone peak means the network hiccuped.
    const spiky = new NetcodeSampler();
    const end = run(spiky, 10, (frame) =>
      frame === 300
        ? steady({ correction: 40, driftEma: 0.1, driftPeak: 40, reconcileSeq: frame })()
        : steady({ correction: 0.1, driftEma: 0.1, driftPeak: 0.2, reconcileSeq: frame })(),
    );
    const summary = spiky.summarize(end)!;

    // Low persistent drift...
    expect(summary.driftEmaMean).toBeLessThan(0.5);
    // ...with a peak far above it. That reads as jitter, not divergence.
    expect(summary.driftPeakMax).toBeGreaterThan(30);

    const diverging = new NetcodeSampler();
    const end2 = run(diverging, 10, (frame) =>
      steady({ correction: 9, driftEma: 9, driftPeak: 10, reconcileSeq: frame })(),
    );
    const summary2 = diverging.summarize(end2)!;

    // Here the persistent component IS the story.
    expect(summary2.driftEmaMean).toBeGreaterThan(8);
  });

  it('reports the lead the player actually feels as score lag', () => {
    // 69 unacked inputs at 30 Hz is what a real phone reported: the ball is
    // drawn 2.3 seconds ahead of the score, which is not a subtle artifact.
    const sampler = new NetcodeSampler();
    const end = run(sampler, 10, steady({ leadMs: 69 * (1000 / 30) }));
    const summary = sampler.summarize(end)!;

    expect(summary.leadMsMean).toBeGreaterThan(2000);
    expect(summary.leadMsP95).toBeGreaterThan(2000);

    const healthy = new NetcodeSampler();
    const end2 = run(healthy, 10, steady({ leadMs: 6 * (1000 / 30) }));
    expect(healthy.summarize(end2)!.leadMsMean).toBeLessThan(250);
  });

  it('does not count a backgrounded app as a dropped frame', () => {
    // Telegram suspends rAF when the app is closed. Counting the gap on resume
    // would report a multi-second stutter that never happened, and one such
    // row poisons the p95 of every honest one.
    const sampler = new NetcodeSampler();
    let now = 1000;
    for (let i = 0; i < 200; i++) {
      sampler.frame(now, steady());
      now += 1000 / 60;
    }
    now += 30_000; // app closed for thirty seconds
    for (let i = 0; i < 200; i++) {
      sampler.frame(now, steady());
      now += 1000 / 60;
    }

    expect(sampler.summarize(now)!.frameMaxMs).toBeLessThan(100);
  });

  it('splits the correction by what it was on, so a reversal is not read as a teleport', () => {
    // `correctionMax` is the worst delta across a pose that mixes positions
    // with velocities, so a mispredicted bounce reports ~2x the ball's speed
    // and looks, in a table, like a ball crossing the field. The split is what
    // says it was `ball.vx`, and that the local paddle stayed exact.
    const sampler = new NetcodeSampler();
    const end = run(
      sampler,
      10,
      steady({ correction: 184, ballCorrection: 2.1, ballVelCorrection: 184, oppPaddleCorrection: 6 }),
    );
    const summary = sampler.summarize(end)!;

    expect(summary.correctionMax).toBeCloseTo(184);
    expect(summary.ballVelCorrMax).toBeCloseTo(184);
    expect(summary.ballCorrMax).toBeCloseTo(2.1);
    expect(summary.oppPaddleCorrMax).toBeCloseTo(6);
    // The one that must stay at zero: our own paddle replays our own inputs.
    expect(summary.selfPaddleCorrMax).toBe(0);
  });

  it('reads the link separately from the queue', () => {
    // Unacked inputs are the round trip PLUS any backlog, and only the first is
    // the network's. 15 pending on a 120ms link is ~11 inputs of queue that
    // nothing will drain; the same 15 on a 480ms link is just distance.
    const sampler = new NetcodeSampler();
    const end = run(sampler, 10, steady({ pending: 15, rttMs: 120, jitterMs: 7 }));
    const summary = sampler.summarize(end)!;

    expect(summary.rttMean).toBeCloseTo(120);
    expect(summary.rttP95).toBeCloseTo(120);
    expect(summary.jitterMean).toBeCloseTo(7);
    expect(summary.pendingMean).toBeCloseTo(15);
  });

  it('does not average in the clock\'s "no sample yet" zero', () => {
    // `smoothedRtt()` reads 0 until its first RTT-valid sample lands. Treating
    // that as a 0ms link would report a fast connection for a match that was
    // too short to measure one.
    const sampler = new NetcodeSampler();
    const end = run(sampler, 10, (frame) => steady({ rttMs: frame < 300 ? 0 : 200 })());
    const summary = sampler.summarize(end)!;

    expect(summary.rttMean).toBeCloseTo(200);
  });
});
