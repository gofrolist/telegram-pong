/**
 * Stage 5: prediction, rollback and interpolation under a bad network.
 *
 * This is the stage that decides whether the product works at all, so it is
 * tested against a real server process with **150ms of simulated round-trip
 * latency** and with a fraction of the client's inputs deliberately dropped.
 * Smoothness on localhost proves nothing.
 *
 * The assertions are about *corrections*, not about smoothness — smoothness is
 * what a correction-free stream looks like:
 *
 *  1. The local paddle must never be corrected. The client and the server run
 *     the identical speed-capped `movePaddle`, so an honest client's
 *     prediction is not an approximation of the truth, it *is* the truth
 *     arriving early. Any correction here means the two simulations diverged.
 *  2. The predicted ball must stay close to server truth across a rally,
 *     including through paddle bounces — the moment where a diverging
 *     simulation shows up as a visible snap.
 *
 * What this does NOT cover: real packet loss and jitter on a mobile radio.
 * `COLYSEUS_LATENCY` is a fixed one-way delay, and dropping inputs at the
 * sender is not the same as losing them in flight. The acceptance test on two
 * phones on mobile data is still the one that counts; see the README.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@colyseus/sdk';
import { sign } from '@telegram-apps/init-data-node';
import {
  BALL_MAX_SPEED,
  FIELD_W,
  PADDLE_MAX_SPEED,
  Phase,
  SIDE_BOTTOM,
  SIDE_TOP,
  type Side,
} from '@pong/game-core';
import { PongState } from '@pong/game-core/net';

import { attachPrediction } from '../src/net/predictionAdapter.js';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS-ONLY';
const PORT = 2601;
const BASE = `http://localhost:${PORT}`;

/** One-way delay, so the round trip is 150ms. */
const ONE_WAY_LATENCY_MS = 75;

let server: ChildProcess | undefined;

function startServer(): Promise<ChildProcess> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, '../../server/src/index.ts');

  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', entry], {
    // A process group of its own, so the whole tree can be torn down. See
    // `stopServer` for why that matters.
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: 'pong_test_bot',
      TELEGRAM_APP_NAME: 'pong',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-value-1234567890',
      PUBLIC_SERVER_URL: BASE,
      PUBLIC_CLIENT_URL: 'http://localhost:5173',
      // Unreachable on purpose: a match must not depend on the database.
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nowhere',
      SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
      // Colyseus' own transport-level delay, applied in both directions.
      COLYSEUS_LATENCY: String(ONE_WAY_LATENCY_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 45_000);
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Listening on')) {
        clearTimeout(timeout);
        resolvePromise(child);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early (${code}):\n${output}`));
    });
  });
}

function initDataFor(userId: number, name: string): string {
  return sign({ user: { id: userId, first_name: name, language_code: 'en' } }, BOT_TOKEN, new Date());
}

async function authenticate(userId: number, name: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: initDataFor(userId, name) }),
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function openRoom(token: string): Promise<string> {
  const response = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game: 'pong' }),
  });
  const body = (await response.json()) as { colyseusRoomId: string };
  return body.colyseusRoomId;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(async () => {
  server = await startServer();
  await sleep(500);
}, 60_000);

/**
 * Tear the server down, whole process group and all.
 *
 * A plain `child.kill()` is not enough here, and getting it wrong is
 * expensive: `uWebSockets` binds with `SO_REUSEPORT`, so a survivor keeps
 * holding the port, the next run's server binds the SAME port alongside it,
 * and the kernel round-robins connections between them. A client then creates
 * a room over HTTP on one server and opens its WebSocket against the other,
 * which has never heard of that room — and the test hangs for reasons that
 * look nothing like the cause.
 */
async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try {
    // Negative pid = the whole process group, which `detached: true` created.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 300));
}

afterAll(async () => {
  await stopServer(server);
});

describe('prediction under 150ms RTT', () => {
  it('keeps the local paddle correction-free and the ball close to truth', async () => {
    const tokenA = await authenticate(5001, 'Ada');
    const tokenB = await authenticate(5002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new Client(BASE);
    const clientB = new Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;

    const roomA = await clientA.joinById(roomId, { token: tokenA }, PongState);
    const roomB = await clientB.joinById(roomId, { token: tokenB }, PongState);

    await waitFor('both seated', () => roomA.state.players.size === 2);

    const sideA: Side = roomA.state.players.get(roomA.sessionId)?.side === SIDE_TOP ? SIDE_TOP : SIDE_BOTTOM;
    const sideB: Side = sideA === SIDE_BOTTOM ? SIDE_TOP : SIDE_BOTTOM;

    const predictionA = await attachPrediction(roomA, sideA);
    const predictionB = await attachPrediction(roomB, sideB);

    await waitFor('serve', () => roomA.state.meta.phase === Phase.PLAYING);

    const paddleErrors: number[] = [];
    const ballErrors: number[] = [];
    const corrections: number[] = [];
    let frames = 0;
    let droppedInputs = 0;

    // Drive both clients at roughly 60 fps for ~8 seconds of real play.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && roomA.state.meta.phase !== Phase.ENDED) {
      frames++;

      // Both players chase the ball, so a rally builds and the ball actually
      // crosses paddle planes — the interesting case for divergence.
      const targetA = roomA.state.ball.x;
      const targetB = roomB.state.ball.x;

      // Drop roughly one input in twelve, to exercise the server's `idle: true`
      // repeat-last-command path rather than letting the paddle stall.
      if (frames % 12 === 0) {
        droppedInputs++;
      } else {
        predictionA.frame(targetA);
        predictionB.frame(targetB);
      }

      const predicted = predictionA.read();
      const truth = roomA.state;
      const myPaddleTruth = sideA === SIDE_BOTTOM ? truth.bottom.x : truth.top.x;
      const myPaddlePredicted = sideA === SIDE_BOTTOM ? predicted.bottomX : predicted.topX;

      if (truth.meta.phase === Phase.PLAYING) {
        paddleErrors.push(Math.abs(myPaddlePredicted - myPaddleTruth));
        ballErrors.push(Math.hypot(predicted.ballX - truth.ball.x, predicted.ballY - truth.ball.y));
        corrections.push(predictionA.stats().correction);
      }

      await sleep(16);
    }

    expect(frames).toBeGreaterThan(100);
    expect(droppedInputs).toBeGreaterThan(5);
    expect(paddleErrors.length).toBeGreaterThan(50);

    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const p95 = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    };

    // Reported so a regression shows *how far* it drifted, not just that it did.
    console.log(
      `[netcode] rtt=${ONE_WAY_LATENCY_MS * 2}ms frames=${frames} dropped=${droppedInputs} ` +
        `paddle mean=${mean(paddleErrors).toFixed(3)} p95=${p95(paddleErrors).toFixed(3)} ` +
        `ball mean=${mean(ballErrors).toFixed(2)} p95=${p95(ballErrors).toFixed(2)} ` +
        `maxCorrection=${Math.max(...corrections).toFixed(3)} rally=${roomA.state.meta.rallyHits}`,
    );

    // THE assertion. `lastCorrectionMag` is how far the reconciler had to move
    // the world when server truth arrived and disagreed with the replay. Zero
    // means the client and the server computed bit-identical worlds from the
    // same inputs — which is what makes the ball smooth, and what a
    // non-deterministic simulation could not achieve at any latency.
    //
    // Everything else in this test is a sanity bound; this is the claim.
    expect(Math.max(...corrections)).toBeLessThan(0.5);

    // The gaps measured above are prediction *lead*, not error: the predicted
    // world is roughly one round trip ahead of the replicated one, which is
    // the entire point. They are bounded by how far each thing can physically
    // travel in that time, which is what these two assertions check.
    //
    // A paddle capped at PADDLE_MAX_SPEED covers at most
    // PADDLE_MAX_SPEED * RTT units in a round trip.
    const rttSeconds = (ONE_WAY_LATENCY_MS * 2) / 1000;
    expect(p95(paddleErrors)).toBeLessThan(PADDLE_MAX_SPEED * rttSeconds);

    // The ball tops out at BALL_MAX_SPEED, and never crosses more than a
    // fraction of the field in one round trip.
    expect(p95(ballErrors)).toBeLessThan(BALL_MAX_SPEED * rttSeconds);
    expect(p95(ballErrors)).toBeLessThan(FIELD_W * 0.3);

    // And the rally actually happened — otherwise the numbers above would be
    // measuring a stationary ball.
    expect(roomA.state.meta.rallyHits + roomA.state.meta.scoreBottom + roomA.state.meta.scoreTop)
      .toBeGreaterThan(0);

    predictionA.dispose();
    predictionB.dispose();
    await roomA.leave(true);
    await roomB.leave(true);
  }, 120_000);
});

describe('side assignment', () => {
  /**
   * Regression: both clients used to conclude they were the bottom player.
   *
   * `joinById` resolves when the seat is confirmed, which is strictly before
   * the first state patch — so `state.players` is still empty at that instant.
   * Reading our own `PlayerInfo` there returned `undefined`, the code fell back
   * to `SIDE_BOTTOM`, and the top player got an unmirrored field, an inverted
   * pointer mapping, swapped scores, a wrong win flag, and prediction driving
   * the opponent's paddle. Everything still *ran*, which is why no other test
   * caught it.
   */
  it('gives the two players opposite ends, and not before the state decodes', async () => {
    const tokenA = await authenticate(6001, 'Ada');
    const tokenB = await authenticate(6002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new Client(BASE);
    const clientB = new Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;

    const roomA = await clientA.joinById(roomId, { token: tokenA }, PongState);
    // The precondition that made the bug possible. If a future SDK resolves
    // `joinById` only after the first patch, this assertion is the thing that
    // tells us the workaround is no longer load-bearing.
    expect(roomA.state.players.get(roomA.sessionId)).toBeUndefined();

    const roomB = await clientB.joinById(roomId, { token: tokenB }, PongState);

    await waitFor(
      'both PlayerInfos decoded on both clients',
      () =>
        roomA.state.players.get(roomA.sessionId) !== undefined &&
        roomB.state.players.get(roomB.sessionId) !== undefined,
    );

    const sideA = roomA.state.players.get(roomA.sessionId)!.side;
    const sideB = roomB.state.players.get(roomB.sessionId)!.side;

    expect(new Set([sideA, sideB])).toEqual(new Set([SIDE_BOTTOM, SIDE_TOP]));
    // The host opened the room, so the host defends the bottom — the near edge
    // on their own screen before any mirroring is applied.
    expect(sideA).toBe(SIDE_BOTTOM);
    expect(sideB).toBe(SIDE_TOP);

    // And each client agrees with the other about who is where.
    expect(roomB.state.players.get(roomA.sessionId)!.side).toBe(sideA);
    expect(roomA.state.players.get(roomB.sessionId)!.side).toBe(sideB);

    await roomA.leave(true);
    await roomB.leave(true);
  }, 60_000);
});
