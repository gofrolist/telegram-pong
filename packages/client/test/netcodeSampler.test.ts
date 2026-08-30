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
        ? { pending: 5, correction: 40, driftEma: 0.1, driftPeak: 40, reconcileSeq: frame }
        : { pending: 5, correction: 0.1, driftEma: 0.1, driftPeak: 0.2, reconcileSeq: frame },
    );
    const summary = spiky.summarize(end)!;

    // Low persistent drift...
    expect(summary.driftEmaMean).toBeLessThan(0.5);
    // ...with a peak far above it. That reads as jitter, not divergence.
    expect(summary.driftPeakMax).toBeGreaterThan(30);

    const diverging = new NetcodeSampler();
    const end2 = run(diverging, 10, (frame) => ({
      pending: 5,
      correction: 9,
      driftEma: 9,
      driftPeak: 10,
      reconcileSeq: frame,
    }));
    const summary2 = diverging.summarize(end2)!;

    // Here the persistent component IS the story.
    expect(summary2.driftEmaMean).toBeGreaterThan(8);
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
});
