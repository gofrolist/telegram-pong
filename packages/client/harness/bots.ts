/**
 * Two bots play Pong; the run reports how the ball looked while they did.
 *
 *     bun run bots                       # the default latency sweep
 *     bun run bots --latency 0,75,150    # one-way ms, so RTT is twice each
 *     bun run bots --matches 2 --fps 60 --jitter 4 --out report.json
 *     bun run bots --host-wait 30            # host waits 30s for the invite
 *     bun run bots --paddle sweep            # measured bot moves flat out
 *
 * WHY THIS AND NOT THE INTEGRATION TEST. The test asserts that corrections
 * stay small, which is a claim about the SIMULATION agreeing with the server.
 * A ball can satisfy that completely and still look wrong, because what a
 * player sees is not the simulation — it is the interpolated read of it, one
 * `value()` per frame. The complaint that started this file was "it doesn't
 * move straight", and no correction-based assertion can express it.
 *
 * So the headline metric here is measured on the RENDERED path, not the
 * simulated one: while the ball is in open field, away from every wall and
 * paddle plane, its velocity is constant by definition of the game. Any change
 * in the drawn ball's velocity between two frames in that band is an artifact
 * of how it was drawn. Perfect rendering scores zero, and the score is
 * expressed as a fraction of the ball's own speed so it means the same thing
 * at every latency and speed.
 *
 * WHAT IT CANNOT SEE. This is Node: there is no vsync and no browser
 * scheduler, so frame times are synthesised (with jitter, deliberately). It
 * exercises the interpolation MATH under uneven frame spacing, which is where
 * a whole class of these bugs lives, but it is not a browser and it is not a
 * phone. A green run here does not retire the acceptance test on two real
 * devices.
 */

import { writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import {
  BALL_RADIUS,
  BALL_START_SPEED,
  FIELD_H,
  FIELD_W,
  PADDLE_HALF_W,
  PADDLE_INSET,
  Phase,
  SIDE_BOTTOM,
} from '@pong/game-core';

import { seatTwoPlayers, sleep, startServer, stopServer, waitFor, type Seat } from './support.js';

interface Options {
  latencies: number[];
  matches: number;
  fps: number;
  jitterMs: number;
  maxSeconds: number;
  /** Seconds the host waits alone before the guest joins. See `SeatOptions`. */
  hostWaitSeconds: number;
  /** How the measured bot steers its paddle. See {@link steerBot}. */
  paddle: PaddleMode;
  /** Correction easing window, ms. 0 uses the client's own constant. */
  smoothMs: number | undefined;
  snap: number | undefined;
  port: number;
  out: string | null;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    // A flag whose value is missing silently takes the NEXT FLAG as its value,
    // and `Number('--port')` is NaN — which then propagates into the smoothing
    // window, out through every position the reconciler draws, and lands in
    // the report as a column of zeros that reads exactly like a perfect run.
    // Refuse instead. This harness has now produced three separate misleading
    // results from unvalidated inputs; the pattern is the point.
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`${flag} needs a number, got "${raw}"`);
    return parsed;
  };
  return {
    // One-way delays. 0 is a sanity floor — anything wrong at 0ms is wrong in
    // the code, not in the network.
    latencies: (get('--latency') ?? '0,75,150').split(',').map((value) => {
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed)) throw new Error(`--latency needs numbers, got "${value}"`);
      return parsed;
    }),
    matches: num('--matches', 1),
    fps: num('--fps', 60),
    // Real frames are not evenly spaced. Feeding a perfectly regular clock
    // would hide exactly the bugs this is looking for.
    jitterMs: num('--jitter', 3),
    maxSeconds: num('--seconds', 45),
    // A host is never joined instantly in real life, and the wait is what fills
    // the server's input buffer. `--host-wait 0` restores the old behaviour.
    hostWaitSeconds: num('--host-wait', 3),
    paddle: (get('--paddle') ?? 'chase') as PaddleMode,
    smoothMs: get('--smooth') === undefined ? undefined : num('--smooth', 0),
    snap: get('--snap') === undefined ? undefined : num('--snap', 0),
    port: num('--port', 2603),
    out: get('--out') ?? null,
  };
}

/**
 * The open field: far enough from every surface that the ball cannot be
 * bouncing. Inside this band a straight line is the only correct path, so
 * every deviation is the renderer's.
 */
const BAND = {
  minX: BALL_RADIUS * 3,
  maxX: FIELD_W - BALL_RADIUS * 3,
  minY: PADDLE_INSET + BALL_RADIUS * 4,
  maxY: FIELD_H - PADDLE_INSET - BALL_RADIUS * 4,
};

function inOpenField(x: number, y: number): boolean {
  return x > BAND.minX && x < BAND.maxX && y > BAND.minY && y < BAND.maxY;
}

/**
 * How much the measured bot moves its paddle.
 *
 * A deliberate axis, not a preference. A player reported that *the more they
 * moved their bat, the more the ball jumped* — so paddle motion has to be
 * something the harness can turn up and down, or that claim cannot be
 * reproduced or refuted. The mechanism it exercises: when the unacked queue
 * outgrows the SDK's replay ring, the OLDEST unacked inputs age out and
 * rollback skips them. Skipping an input is harmless when it says the same
 * thing as its neighbours (a still paddle) and costs up to one tick of paddle
 * travel when it does not, so a moving paddle turns a queue-length bug into a
 * mispredicted bounce.
 */
type PaddleMode = 'chase' | 'still' | 'sweep';

/** Where the measured bot wants its paddle this frame, in field units. */
function steerBot(mode: PaddleMode, ballX: number, now: number): number {
  switch (mode) {
    // Parked in the middle. Every input carries the same target, so an input
    // the reconciler drops is an input that did not matter.
    case 'still':
      return FIELD_W / 2;
    // A new destination several times a second, ball or no ball: the upper
    // bound on how wrong a stale input stream can be.
    //
    // APERIODIC on purpose. The first version of this was a 2s square wave,
    // which aliased almost exactly against the 2.07s input delay it was meant
    // to expose: the server's stale target kept landing one whole period back,
    // i.e. on the same value, and the broken build scored BETTER than the
    // fixed one. A periodic probe cannot measure a delay near its own period.
    case 'sweep': {
      const slot = Math.floor(now / 220);
      const hash = Math.imul(slot ^ 0x9e3779b9, 0x85ebca6b) >>> 8;
      return PADDLE_HALF_W + ((hash % 1000) / 1000) * (FIELD_W - 2 * PADDLE_HALF_W);
    }
    default:
      return ballX;
  }
}

interface MatchReport {
  latencyRttMs: number;
  seconds: number;
  frames: number;
  rallyHits: number;
  score: string;
  /** Change in the DRAWN ball's velocity between frames, as a fraction of its
   *  own speed, in open field. 0 is a perfectly straight render. */
  wobbleMean: number;
  wobbleP95: number;
  wobbleMax: number;
  /** From the reconciler: persistent drift, and the worst single correction. */
  driftEmaMean: number;
  driftPeakMax: number;
  correctionMax: number;
  /** Correction split by what it was ON. `oppPaddle` is nonzero by design;
   *  `selfPaddle` must stay ~0; `ballPos`/`ballVel` are what the player sees. */
  ballCorrP95: number;
  ballCorrMax: number;
  ballVelCorrMax: number;
  selfPaddleCorrMax: number;
  oppPaddleCorrMax: number;
  /**
   * Where the ball was when a bounce was mispredicted badly enough to reverse
   * it (a velocity correction over half the start speed).
   *
   * The whole question, since the own-paddle correction is flat zero: a
   * reversal near the FAR plane is the opponent's paddle, whose inputs this
   * client cannot know; one near the NEAR plane would be a bug, because that
   * bounce depends only on our own paddle and the incoming ball.
   */
  reversalsFarHalf: number;
  reversalsNearHalf: number;
  /** How far ahead of confirmed server truth the drawn world ran, in ms. This
   *  is the gap between watching the ball go past and the score changing. */
  leadMsMean: number;
  /**
   * How far the server's idea of the measured bot's desired paddle X trails
   * the one it last asked for, in FIELD UNITS (the field is 100 wide).
   *
   * The direct read on "the more I move my bat, the worse the ball behaves".
   * The client predicts the bounce off the paddle it is drawing; the server
   * bounces off the paddle its own input stream has reached. This is the gap
   * between those two, and it is zero for a player who holds still no matter
   * how far behind the input stream is — which is exactly why the complaint
   * is phrased in terms of movement.
   */
  targetLagMean: number;
  targetLagP95: number;
  pendingMean: number;
  /** Worst unacked queue. Past the SDK's 64-entry replay ring, rollback
   *  silently skips inputs and the prediction can no longer be correct — so
   *  this is a pass/fail number, not a trend. */
  pendingMax: number;
}

async function playOneMatch(port: number, options: Options, rttMs: number, seed: number): Promise<MatchReport> {
  const [a, b] = await seatTwoPlayers(
    port,
    [
      { id: 7000 + seed * 2, name: 'BotA' },
      { id: 7001 + seed * 2, name: 'BotB' },
    ],
    {
      hostWaitMs: options.hostWaitSeconds * 1000,
      smoothMs: options.smoothMs,
      snap: options.snap,
    },
  );

  await waitFor('match to leave WAITING', () => a.room.state.meta.phase !== Phase.WAITING);

  const wobble: number[] = [];
  const driftEma: number[] = [];
  const pending: number[] = [];
  const leadMs: number[] = [];
  const targetLag: number[] = [];
  let driftPeakMax = 0;
  let correctionMax = 0;
  let pendingMax = 0;
  const ballCorr: number[] = [];
  let ballCorrMax = 0;
  let ballVelCorrMax = 0;
  let selfPaddleCorrMax = 0;
  let oppPaddleCorrMax = 0;
  let reversalsFarHalf = 0;
  let reversalsNearHalf = 0;
  let frames = 0;

  const frameMs = 1000 / options.fps;
  // The frame clock is anchored to the real monotonic clock, not accumulated
  // from a nominal frame length. An accumulator drifts against wall time —
  // 0.33ms per frame at 60fps against a 17ms sleep — while state patches keep
  // arriving on wall time, so the sim's step budget and the patch stream
  // slowly disagree. That is a property of the harness, not of the client, and
  // it would show up in the measurement as if it were one. rAF's timestamps
  // are wall-aligned; these are too.
  const clockBase = performance.now();
  let now = 0;
  let prevX = 0;
  let prevY = 0;
  let prevVx = 0;
  let prevVy = 0;
  let prevDt = 0;
  let havePrev = false;
  /** Velocity readings so far. Two are needed before a CHANGE in one exists. */
  let velocitySamples = 0;

  const startedAt = Date.now();
  const deadline = startedAt + options.maxSeconds * 1000;
  // A serve teleports the ball back to the centre. That is the game moving it,
  // not the renderer, so the history is dropped whenever the score changes.
  let lastScore = '';

  while (Date.now() < deadline && a.room.state.meta.phase !== Phase.ENDED) {
    frames++;
    // Jitter is added ON TOP of real elapsed time, because a real frame clock
    // has jitter and uniform spacing is the one condition under which a dt bug
    // cannot show itself.
    const previousNow = now;
    now = performance.now() - clockBase + (Math.random() * 2 - 1) * options.jitterMs;
    const dt = now - previousNow;
    if (dt <= 0) continue;

    // `b` always chases, so rallies build and the ball keeps crossing paddle
    // planes — the interesting case. `a` is the one being measured, and how
    // much it moves is the variable under test.
    const wantedX = steerBot(options.paddle, a.room.state.ball.x, now);
    a.prediction.frame(wantedX, now);
    b.prediction.frame(b.room.state.ball.x, now);

    const drawn = a.prediction.read();
    const stats = a.prediction.stats();

    const score = `${a.room.state.meta.scoreBottom}-${a.room.state.meta.scoreTop}`;
    if (score !== lastScore) {
      lastScore = score;
      havePrev = false;
      velocitySamples = 0;
    }

    if (a.room.state.meta.phase === Phase.PLAYING) {
      driftEma.push(stats.driftEma);
      pending.push(stats.pending);
      leadMs.push(stats.leadMs);
      // What the server currently believes this bot is asking for, against
      // what it just asked for.
      const serverTarget =
        a.side === SIDE_BOTTOM ? a.room.state.bottom.targetX : a.room.state.top.targetX;
      targetLag.push(Math.abs(wantedX - serverTarget));
      if (stats.pending > pendingMax) pendingMax = stats.pending;
      ballCorr.push(stats.ballCorrection);
      if (stats.ballCorrection > ballCorrMax) ballCorrMax = stats.ballCorrection;
      if (stats.ballVelCorrection > ballVelCorrMax) ballVelCorrMax = stats.ballVelCorrection;
      if (stats.selfPaddleCorrection > selfPaddleCorrMax) selfPaddleCorrMax = stats.selfPaddleCorrection;
      if (stats.oppPaddleCorrection > oppPaddleCorrMax) oppPaddleCorrMax = stats.oppPaddleCorrection;
      // Attribute each reversal to a half of the field. `a` defends the
      // bottom, so the far plane is the top one.
      if (stats.ballVelCorrection > BALL_START_SPEED / 2) {
        if (a.room.state.ball.y < FIELD_H / 2) reversalsFarHalf++;
        else reversalsNearHalf++;
      }
      if (stats.driftPeak > driftPeakMax) driftPeakMax = stats.driftPeak;
      if (stats.correction > correctionMax) correctionMax = stats.correction;

      const dtSec = dt / 1000;
      const vx = havePrev ? (drawn.ballX - prevX) / dtSec : 0;
      const vy = havePrev ? (drawn.ballY - prevY) / dtSec : 0;

      if (havePrev) velocitySamples++;

      // THREE frames of history, not two. Two give one velocity, and the
      // change in a velocity needs a previous velocity to change from —
      // comparing the first reading against a zero-initialised one
      // manufactures a spurious full-speed spike, which is exactly the shape
      // of the artifact this metric exists to detect. Both positions must also
      // be in open field: a sample straddling a bounce measures the game, not
      // the renderer.
      if (
        havePrev &&
        velocitySamples >= 2 &&
        prevDt > 0 &&
        inOpenField(drawn.ballX, drawn.ballY) &&
        inOpenField(prevX, prevY)
      ) {
        const speed = Math.hypot(vx, vy);
        if (speed > 1) {
          const delta = Math.hypot(vx - prevVx, vy - prevVy);
          wobble.push(delta / speed);
        }
      }

      prevVx = vx;
      prevVy = vy;
      prevX = drawn.ballX;
      prevY = drawn.ballY;
      prevDt = dtSec;
      havePrev = true;
    }

    await sleep(Math.max(1, Math.round(frameMs)));
  }

  const seconds = (Date.now() - startedAt) / 1000;
  const meta = a.room.state.meta;
  const report: MatchReport = {
    latencyRttMs: rttMs,
    seconds: round(seconds),
    frames,
    rallyHits: meta.rallyHits,
    score: `${meta.scoreBottom}-${meta.scoreTop}`,
    wobbleMean: round(mean(wobble)),
    wobbleP95: round(p95(wobble)),
    wobbleMax: round(Math.max(0, ...wobble)),
    driftEmaMean: round(mean(driftEma)),
    driftPeakMax: round(driftPeakMax),
    correctionMax: round(correctionMax),
    ballCorrP95: round(p95(ballCorr)),
    ballCorrMax: round(ballCorrMax),
    ballVelCorrMax: round(ballVelCorrMax),
    selfPaddleCorrMax: round(selfPaddleCorrMax),
    oppPaddleCorrMax: round(oppPaddleCorrMax),
    reversalsFarHalf,
    reversalsNearHalf,
    leadMsMean: round(mean(leadMs)),
    targetLagMean: round(mean(targetLag)),
    targetLagP95: round(p95(targetLag)),
    pendingMean: round(mean(pending)),
    pendingMax,
  };

  for (const seat of [a, b] as Seat[]) {
    seat.prediction.dispose();
    await seat.room.leave(true).catch(() => {});
  }
  // The server needs a beat to release the seats before the next match.
  await sleep(500);

  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const reports: MatchReport[] = [];
  let seed = 0;

  for (const oneWay of options.latencies) {
    let server: ChildProcess | undefined;
    try {
      // A server per latency: `COLYSEUS_LATENCY` is read at boot.
      server = await startServer({ port: options.port, oneWayLatencyMs: oneWay });
      await sleep(500);
      for (let i = 0; i < options.matches; i++) {
        reports.push(await playOneMatch(options.port, options, oneWay * 2, seed++));
      }
    } finally {
      await stopServer(server);
    }
  }

  const header = [
    'rtt'.padStart(5),
    'sec'.padStart(6),
    'rally'.padStart(6),
    'score'.padStart(6),
    'wobble~'.padStart(8),
    'wob p95'.padStart(8),
    'wob max'.padStart(8),
    'drift~'.padStart(7),
    'peak'.padStart(7),
    'ballC p95'.padStart(10),
    'ballC max'.padStart(10),
    'ballV max'.padStart(10),
    'selfP max'.padStart(10),
    ' oppP max'.padStart(10),
    'rev far'.padStart(8),
    'rev near'.padStart(9),
    'lead ms'.padStart(8),
    'tgtlag~'.padStart(8),
    'tgt p95'.padStart(8),
    'pending'.padStart(8),
    'pend max'.padStart(9),
  ].join(' ');
  console.log(`\n${header}\n${'-'.repeat(header.length)}`);
  for (const r of reports) {
    console.log(
      [
        String(r.latencyRttMs).padStart(5),
        r.seconds.toFixed(1).padStart(6),
        String(r.rallyHits).padStart(6),
        r.score.padStart(6),
        r.wobbleMean.toFixed(4).padStart(8),
        r.wobbleP95.toFixed(4).padStart(8),
        r.wobbleMax.toFixed(4).padStart(8),
        r.driftEmaMean.toFixed(3).padStart(7),
        r.driftPeakMax.toFixed(3).padStart(7),
        r.ballCorrP95.toFixed(3).padStart(10),
        r.ballCorrMax.toFixed(2).padStart(10),
        r.ballVelCorrMax.toFixed(2).padStart(10),
        r.selfPaddleCorrMax.toFixed(3).padStart(10),
        r.oppPaddleCorrMax.toFixed(2).padStart(10),
        String(r.reversalsFarHalf).padStart(8),
        String(r.reversalsNearHalf).padStart(9),
        r.leadMsMean.toFixed(0).padStart(8),
        r.targetLagMean.toFixed(1).padStart(8),
        r.targetLagP95.toFixed(1).padStart(8),
        r.pendingMean.toFixed(2).padStart(8),
        String(r.pendingMax).padStart(9),
      ].join(' '),
    );
  }
  console.log(
    '\nwobble = frame-to-frame change in the DRAWN ball velocity, in open field,\n' +
      'as a fraction of its own speed. 0 is a perfectly straight render.\n',
  );

  if (options.out) {
    writeFileSync(options.out, JSON.stringify({ generatedAt: new Date().toISOString(), options, reports }, null, 2));
    console.log(`report written to ${options.out}\n`);
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
