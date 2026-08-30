/**
 * Two bots play Pong; the run reports how the ball looked while they did.
 *
 *     bun run bots                       # the default latency sweep
 *     bun run bots --latency 0,75,150    # one-way ms, so RTT is twice each
 *     bun run bots --matches 2 --fps 60 --jitter 4 --out report.json
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
  FIELD_H,
  FIELD_W,
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
  port: number;
  out: string | null;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    // One-way delays. 0 is a sanity floor — anything wrong at 0ms is wrong in
    // the code, not in the network.
    latencies: (get('--latency') ?? '0,75,150').split(',').map((value) => Number(value.trim())),
    matches: Number(get('--matches') ?? 1),
    fps: Number(get('--fps') ?? 60),
    // Real frames are not evenly spaced. Feeding a perfectly regular clock
    // would hide exactly the bugs this is looking for.
    jitterMs: Number(get('--jitter') ?? 3),
    maxSeconds: Number(get('--seconds') ?? 45),
    port: Number(get('--port') ?? 2603),
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
  pendingMean: number;
}

async function playOneMatch(port: number, options: Options, rttMs: number, seed: number): Promise<MatchReport> {
  const [a, b] = await seatTwoPlayers(port, [
    { id: 7000 + seed * 2, name: 'BotA' },
    { id: 7001 + seed * 2, name: 'BotB' },
  ]);

  await waitFor('match to leave WAITING', () => a.room.state.meta.phase !== Phase.WAITING);

  const wobble: number[] = [];
  const driftEma: number[] = [];
  const pending: number[] = [];
  let driftPeakMax = 0;
  let correctionMax = 0;
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

    // Both bots chase the ball, so rallies actually build and the ball crosses
    // paddle planes — the interesting case.
    a.prediction.frame(a.room.state.ball.x, now);
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
    pendingMean: round(mean(pending)),
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
    'corr max'.padStart(9),
    'pending'.padStart(8),
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
        r.correctionMax.toFixed(3).padStart(9),
        r.pendingMean.toFixed(2).padStart(8),
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
