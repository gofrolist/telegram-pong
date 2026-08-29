/**
 * Input-trace recording.
 *
 * The one cheat server authority cannot stop is a script that tracks the ball
 * perfectly: every input it sends is individually legal. It cannot be caught
 * in realtime — the only distinguishing signal is a *distribution* over
 * hundreds of ticks — so the tick's job is simply to remember, cheaply, and
 * the judging happens overnight in a separate job.
 *
 * Cost control: a Pong match is a few thousand ticks and four numbers per
 * tick. Stored as quantised 16-bit integers that is under 30 kB per match, so
 * this rides in a `jsonb` column rather than object storage. Nothing here
 * allocates per tick beyond pushing into pre-existing arrays.
 */

import { FIELD_H, FIELD_W } from '@pong/game-core';

/** Field units → 0..65535, so the trace stores integers rather than floats. */
function quantise(value: number, extent: number): number {
  const scaled = Math.round((value / extent) * 65535);
  if (!Number.isFinite(scaled)) return 0;
  if (scaled < 0) return 0;
  if (scaled > 65535) return 65535;
  return scaled;
}

export interface MatchTrace {
  tickRate: number;
  /** Quantised desired paddle X for the bottom player, one per recorded tick. */
  a: number[];
  /** Same, for the top player. */
  b: number[];
  /** The ball the players were reacting to. Reaction latency needs both. */
  ballX: number[];
  ballY: number[];
  /** Tick index of the first recorded sample, so gaps stay interpretable. */
  firstTick: number;
}

/**
 * Hard ceiling on recorded ticks.
 *
 * A pathological match — two players who refuse to score — must not grow a
 * row without bound. Twenty minutes at 30 Hz is well past any real Pong game.
 */
const MAX_SAMPLES = 30 * 60 * 20;

export class TraceRecorder {
  private readonly a: number[] = [];
  private readonly b: number[] = [];
  private readonly ballX: number[] = [];
  private readonly ballY: number[] = [];
  private firstTick = 0;

  constructor(private readonly tickRate: number) {}

  reset(): void {
    this.a.length = 0;
    this.b.length = 0;
    this.ballX.length = 0;
    this.ballY.length = 0;
    this.firstTick = 0;
  }

  record(tick: number, bottomTargetX: number, topTargetX: number, ballX: number, ballY: number): void {
    if (this.a.length >= MAX_SAMPLES) return;
    if (this.a.length === 0) this.firstTick = tick;
    this.a.push(quantise(bottomTargetX, FIELD_W));
    this.b.push(quantise(topTargetX, FIELD_W));
    this.ballX.push(quantise(ballX, FIELD_W));
    this.ballY.push(quantise(ballY, FIELD_H));
  }

  /** A copy safe to hand to the (async) writer while the room keeps running. */
  snapshot(): MatchTrace {
    return {
      tickRate: this.tickRate,
      a: this.a.slice(),
      b: this.b.slice(),
      ballX: this.ballX.slice(),
      ballY: this.ballY.slice(),
      firstTick: this.firstTick,
    };
  }
}
