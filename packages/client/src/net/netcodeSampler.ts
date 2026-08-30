/**
 * The end-of-match netcode summary.
 *
 * A netcode problem is only diagnosable from the device that has it, and the
 * device that has it is a phone in Telegram's webview with no developer tools.
 * The overlay solves that for a session you are personally holding; this
 * solves it for every session you are not — which is the more important half,
 * because the players this game is built for are 150ms closer to the server
 * than the person debugging it, and their experience is the one in question.
 *
 * **One row per player per match, not one per frame.** At 60 fps a rally would
 * be thousands of rows to store an answer that is read as an aggregate anyway.
 * Samples are taken a few times a second into a bounded buffer and reduced to
 * percentiles when the match ends.
 */

import type { NetcodeStats } from './predictionAdapter.js';

/** Samples per second. Fast enough to catch a spike, slow enough to be free. */
const SAMPLE_HZ = 4;
const SAMPLE_INTERVAL_MS = 1000 / SAMPLE_HZ;

/**
 * Cap on retained samples — about ten minutes at 4 Hz, comfortably longer than
 * any match. Past it the buffer stops growing rather than evicting: a match
 * that runs this long is pathological, and the early samples describe the
 * pathology better than the late ones would.
 */
const MAX_SAMPLES = 2400;

export interface NetcodeSummary extends Record<string, number> {
  /** How many samples the figures below are computed from. */
  samples: number;
  /** Rendered frames per second, as actually achieved on the device. */
  fps: number;
  /** Worst frame interval seen, in ms. A stutter shows up here and nowhere else. */
  frameMaxMs: number;
  /** Unacked inputs: mean and p95. Times ~33ms, the round trip. */
  pendingMean: number;
  pendingP95: number;
  /** Persistent drift. Steady and nonzero means the prediction is diverging. */
  driftEmaMean: number;
  driftEmaP95: number;
  /** Recent decaying max. Spikes over a low ema mean jitter, not divergence. */
  driftPeakMax: number;
  /** Correction sizes, in field units — the visible "jump" when one lands. */
  correctionP95: number;
  correctionMax: number;
  /** Reconciles per second, for reading the numbers above in context. */
  reconcilesPerSec: number;
}

export class NetcodeSampler {
  private readonly pending: number[] = [];
  private readonly driftEma: number[] = [];
  private readonly correction: number[] = [];
  private driftPeakMax = 0;
  private correctionMax = 0;

  private frames = 0;
  private frameMaxMs = 0;
  private lastFrameAt = 0;

  private firstReconcileSeq: number | null = null;
  private lastReconcileSeq = 0;

  private startedAt = 0;
  private lastSampleAt = 0;

  /**
   * Call once per rendered frame, with rAF's timestamp.
   *
   * Maxima are tracked on EVERY frame; the percentile buffers are filled at
   * `SAMPLE_HZ`. That split is not an optimisation, it is the point: a
   * correction spike lasts one frame, and at 4 Hz roughly fourteen frames in
   * fifteen are not looked at — so a peak-only-on-sample design misses
   * precisely the event this report exists to catch. Maxima cost one compare
   * each, which is affordable per frame; retaining every sample for
   * percentiles is not.
   */
  frame(now: number, read: () => NetcodeStats): void {
    if (this.startedAt === 0) {
      this.startedAt = now;
      this.lastSampleAt = now;
      this.lastFrameAt = now;
      return;
    }

    this.frames++;
    const delta = now - this.lastFrameAt;
    // Ignore the first frame after a backgrounded tab resumes: rAF stops while
    // hidden, so the gap measures Telegram being closed, not a dropped frame.
    if (delta < 1000 && delta > this.frameMaxMs) this.frameMaxMs = delta;
    this.lastFrameAt = now;

    const stats = read();

    // Every frame: the extremes, which are single-frame events.
    if (stats.driftPeak > this.driftPeakMax) this.driftPeakMax = stats.driftPeak;
    if (stats.correction > this.correctionMax) this.correctionMax = stats.correction;
    this.firstReconcileSeq ??= stats.reconcileSeq;
    this.lastReconcileSeq = stats.reconcileSeq;

    // At SAMPLE_HZ: the distributions, which are bounded by what we retain.
    if (now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return;
    this.lastSampleAt = now;
    if (this.pending.length >= MAX_SAMPLES) return;

    this.pending.push(stats.pending);
    this.driftEma.push(stats.driftEma);
    this.correction.push(stats.correction);
  }

  /**
   * Reduce to the summary, or `null` when there is not enough to say anything.
   *
   * A handful of samples from a match that ended on a disconnect would be
   * noise indistinguishable from signal once it is a row in a table, so it is
   * better not to write the row.
   */
  summarize(now: number): NetcodeSummary | null {
    const elapsedSec = (now - this.startedAt) / 1000;
    if (this.pending.length < 8 || elapsedSec <= 0) return null;

    const reconciles = this.firstReconcileSeq === null
      ? 0
      : this.lastReconcileSeq - this.firstReconcileSeq;

    return {
      samples: this.pending.length,
      fps: round(this.frames / elapsedSec),
      frameMaxMs: round(this.frameMaxMs),
      pendingMean: round(mean(this.pending)),
      pendingP95: round(p95(this.pending)),
      driftEmaMean: round(mean(this.driftEma)),
      driftEmaP95: round(p95(this.driftEma)),
      driftPeakMax: round(this.driftPeakMax),
      correctionP95: round(p95(this.correction)),
      correctionMax: round(this.correctionMax),
      reconcilesPerSec: round(reconciles / elapsedSec),
    };
  }
}

/** Two decimals. These are field units and milliseconds; more is false precision. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[index] ?? 0;
}
