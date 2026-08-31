/**
 * Shared harness for driving a real match between two headless clients.
 *
 * A real server process, two real Colyseus connections, the real prediction
 * adapter. Nothing here is a mock: the point of this harness is to exercise
 * the parts that only misbehave when a network is in the middle of them, and
 * a mock of the network is a mock of the bug.
 *
 * Used by `test/prediction.integration.test.ts`, which asserts, and by
 * `harness/bots.ts`, which measures. They share this file so that the server
 * teardown below — which is subtle and expensive to get wrong — exists once.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@colyseus/sdk';
import { sign } from '@telegram-apps/init-data-node';
import { FIELD_W, SIDE_BOTTOM, SIDE_TOP, type Side } from '@pong/game-core';
import { PongState } from '@pong/game-core/net';

import { attachPrediction, type PredictionHandle } from '../src/net/predictionAdapter.js';

export const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS-ONLY';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export interface ServerOptions {
  port: number;
  /** One-way transport delay in ms, so the round trip is twice this. */
  oneWayLatencyMs: number;
}

/**
 * `COLYSEUS_LATENCY` is a ROUND TRIP, not a one-way delay.
 *
 * Colyseus halves it and applies half to each direction
 * (`applySimulatedLatency` in `@colyseus/core/Server`), so handing it a
 * one-way figure injects half the latency the caller asked for. This harness
 * did exactly that, and then labelled its rows with twice the flag — so every
 * latency in every report it has ever printed was 2x the truth, in the
 * direction that flatters the build. The `rtt ms` column exists so that a
 * mistake of this shape cannot survive a run: it is the client's own
 * measurement, and it has to track this number.
 */
function roundTripEnv(oneWayLatencyMs: number): string {
  return String(oneWayLatencyMs * 2);
}

export function baseUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function startServer({ port, oneWayLatencyMs }: ServerOptions): Promise<ChildProcess> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, '../../server/src/index.ts');

  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', entry], {
    // A process group of its own, so the whole tree can be torn down. See
    // `stopServer` for why that matters.
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: 'pong_test_bot',
      TELEGRAM_APP_NAME: 'pong',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-value-1234567890',
      PUBLIC_SERVER_URL: baseUrl(port),
      PUBLIC_CLIENT_URL: 'http://localhost:5173',
      // Unreachable on purpose: a match must not depend on the database.
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nowhere',
      SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
      // Colyseus' own transport-level delay, applied half in each direction.
      COLYSEUS_LATENCY: roundTripEnv(oneWayLatencyMs),
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

/**
 * Tear the server down, whole process group and all.
 *
 * A plain `child.kill()` is not enough here, and getting it wrong is
 * expensive: `uWebSockets` binds with `SO_REUSEPORT`, so a survivor keeps
 * holding the port, the next run's server binds the SAME port alongside it,
 * and the kernel round-robins connections between them. A client then creates
 * a room over HTTP on one server and opens its WebSocket against the other,
 * which has never heard of that room — and the run hangs for reasons that look
 * nothing like the cause.
 */
export async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try {
    // Negative pid = the whole process group, which `detached: true` created.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await sleep(300);
}

export function initDataFor(userId: number, name: string): string {
  return sign({ user: { id: userId, first_name: name, language_code: 'en' } }, BOT_TOKEN, new Date());
}

export async function authenticate(port: number, userId: number, name: string): Promise<string> {
  const response = await fetch(`${baseUrl(port)}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: initDataFor(userId, name) }),
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

export async function openRoom(port: number, token: string): Promise<string> {
  const response = await fetch(`${baseUrl(port)}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game: 'pong' }),
  });
  const body = (await response.json()) as { colyseusRoomId: string };
  return body.colyseusRoomId;
}

export interface Seat {
  room: Awaited<ReturnType<Client['joinById']>> & { state: PongState };
  side: Side;
  prediction: PredictionHandle;
}

export interface SeatOptions {
  /**
   * How long the host sits alone on the waiting screen before the guest
   * arrives, in milliseconds.
   *
   * NOT a detail. A host opens a room and waits for an invite to be tapped —
   * seconds at best, minutes in practice — and their client is already
   * running its frame loop and already sending an input every tick. Seating
   * both players in the same millisecond, which is what this harness did
   * originally, is the one arrangement in which that never happens, and it is
   * why the harness scored a clean sweep on the exact match a player reported
   * as unplayable. Default is a couple of seconds: long enough to be real,
   * short enough to keep a sweep quick.
   */
  hostWaitMs?: number;
  /** Correction easing window, in ms. Defaults to the client's own constant. */
  smoothMs?: number;
  /**
   * Teleport threshold in field units: corrections bigger than this POP
   * instead of easing. Undefined leaves it off, which is the shipped default.
   */
  snap?: number;
}

/** Two authenticated clients, seated in one room, both predicting. */
export async function seatTwoPlayers(
  port: number,
  users: readonly [{ id: number; name: string }, { id: number; name: string }],
  options: SeatOptions = {},
): Promise<[Seat, Seat]> {
  const hostWaitMs = options.hostWaitMs ?? 2000;
  const [tokenA, tokenB] = await Promise.all([
    authenticate(port, users[0].id, users[0].name),
    authenticate(port, users[1].id, users[1].name),
  ]);
  const roomId = await openRoom(port, tokenA);

  const clientA = new Client(baseUrl(port));
  const clientB = new Client(baseUrl(port));
  clientA.auth.token = tokenA;
  clientB.auth.token = tokenB;

  const roomA = await clientA.joinById<PongState>(roomId, { token: tokenA }, PongState);

  // The host's wait, played out rather than skipped: prediction attached and a
  // frame loop sending input, which is precisely what `MatchView` does from
  // the moment it mounts on the waiting screen.
  if (hostWaitMs > 0) {
    const waitingPrediction = await attachPrediction(roomA, SIDE_BOTTOM, {
      smoothMs: options.smoothMs,
      snap: options.snap,
    });
    const startedAt = performance.now();
    while (performance.now() - startedAt < hostWaitMs) {
      waitingPrediction.frame(FIELD_W / 2, performance.now());
      await sleep(16);
    }
    waitingPrediction.dispose();
  }

  const roomB = await clientB.joinById<PongState>(roomId, { token: tokenB }, PongState);

  // The seat is confirmed before the first state patch, so `players` is empty
  // at that moment and both clients would read themselves as the bottom.
  await waitFor(
    'both seats decoded',
    () => Boolean(roomA.state.players.get(roomA.sessionId) && roomB.state.players.get(roomB.sessionId)),
  );

  const sideA = roomA.state.players.get(roomA.sessionId)!.side === SIDE_TOP ? SIDE_TOP : SIDE_BOTTOM;
  const sideB = roomB.state.players.get(roomB.sessionId)!.side === SIDE_TOP ? SIDE_TOP : SIDE_BOTTOM;

  const tuning = { smoothMs: options.smoothMs, snap: options.snap };
  const [predictionA, predictionB] = await Promise.all([
    attachPrediction(roomA, sideA, tuning),
    attachPrediction(roomB, sideB, tuning),
  ]);

  return [
    { room: roomA as Seat['room'], side: sideA, prediction: predictionA },
    { room: roomB as Seat['room'], side: sideB, prediction: predictionB },
  ];
}
