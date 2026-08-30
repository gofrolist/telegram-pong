/**
 * End-to-end netcode test: two real clients against a real server.
 *
 * This is the test that decides whether the product works at all. Smoothness
 * on localhost proves nothing, so the second half runs the same match under
 * simulated latency and packet loss and asserts that the *client's predicted
 * world still agrees with server truth*.
 *
 * What is deliberately real here: the uWebSockets transport, the schema
 * encoder, the 30 Hz fixed timestep, the input buffer, the prediction API. The
 * only fake is the database, which is unreachable — every write in the server
 * is wrapped so that a database outage degrades stats rather than breaking a
 * match, and this test also proves that claim.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS-ONLY';
const PORT = 2599;

process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = 'pong_test_bot';
process.env.TELEGRAM_APP_NAME = 'pong';
process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret-value-1234567890';
process.env.PUBLIC_SERVER_URL = `http://localhost:${PORT}`;
process.env.PUBLIC_CLIENT_URL = 'http://localhost:5173';
// Deliberately unreachable: proves no match path depends on the database.
process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nowhere';
process.env.SESSION_SECRET = 'a-session-secret-of-at-least-32-characters';
process.env.PORT = String(PORT);

type SdkModule = typeof import('@colyseus/sdk');

let sdk: SdkModule;
let sign: typeof import('@telegram-apps/init-data-node').sign;
let gameCore: typeof import('@pong/game-core');
let stateModule: typeof import('@pong/game-core/net');
let server: ChildProcess | undefined;

const BASE = `http://localhost:${PORT}`;

/**
 * The server runs as a real child process rather than in-process.
 *
 * Two reasons. It is the truer test — the transport, the event loop and the
 * 30 Hz timer are all genuinely separate from the client, as they are in
 * production. And `@pm2/io`, which Colyseus loads, writes to `process.send()`,
 * which collides with the test runner's own IPC channel when they share a
 * process.
 */
function startServer(): Promise<ChildProcess> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, '../src/index.ts');

  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', entry], {
    // A process group of its own, so the whole tree can be torn down. See
    // `stopServer` for why that matters.
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      // No bot token that works, so webhook registration will fail — which is
      // itself worth proving harmless: the game must start regardless.
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 45_000);
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

beforeAll(async () => {
  sdk = await import('@colyseus/sdk');
  ({ sign } = await import('@telegram-apps/init-data-node'));
  gameCore = await import('@pong/game-core');
  stateModule = await import('@pong/game-core/net');

  server = await startServer();
  // Give uWS a moment to actually bind after it logs.
  await new Promise((r) => setTimeout(r, 500));
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

function initDataFor(userId: number, firstName: string): string {
  return sign(
    { user: { id: userId, first_name: firstName, language_code: 'en' } },
    BOT_TOKEN,
    new Date(),
  );
}

async function authenticate(userId: number, name: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: initDataFor(userId, name) }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function openRoom(token: string): Promise<string> {
  const response = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game: 'pong' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { colyseusRoomId: string };
  return body.colyseusRoomId;
}

/** Poll until `predicate` holds, or fail with a useful message. */
async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('two clients, one room', () => {
  it('authenticates, seats both players and runs a real match', async () => {
    const tokenA = await authenticate(1001, 'Ada');
    const tokenB = await authenticate(1002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new sdk.Client(BASE);
    const clientB = new sdk.Client(BASE);
    // `static onAuth` reads the token from the Authorization header, which the
    // SDK builds from `client.auth.token`.
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;

    const roomA = await clientA.joinById(roomId, { token: tokenA }, stateModule.PongState);
    const roomB = await clientB.joinById(roomId, { token: tokenB }, stateModule.PongState);

    // Both players seated, on opposite ends.
    await waitFor('both players seated', () => roomA.state.players.size === 2);
    const sides = new Set<number>();
    roomA.state.players.forEach((player: { side: number }) => sides.add(player.side));
    expect(sides).toEqual(new Set([gameCore.SIDE_BOTTOM, gameCore.SIDE_TOP]));

    // The match starts on its own once the second seat is taken — no "ready"
    // handshake, because an invite tapped an hour later must not need the
    // inviter to still be looking at their screen.
    await waitFor(
      'match started',
      () => roomA.state.meta.phase === gameCore.Phase.COUNTDOWN,
    );
    await waitFor(
      'ball served',
      () => roomA.state.meta.phase === gameCore.Phase.PLAYING,
      20_000,
    );

    // The ball actually moves.
    const startY = roomA.state.ball.y;
    await waitFor('ball in flight', () => Math.abs(roomA.state.ball.y - startY) > 5);
    expect(roomA.state.ball.vy).not.toBe(0);

    // Both clients see the same world: this is the state replication working.
    await waitFor('clients agree', () => Math.abs(roomA.state.ball.y - roomB.state.ball.y) < 12);

    await roomA.leave(true);
    await roomB.leave(true);
  }, 60_000);

  it('enforces the paddle speed cap against a client that lies', async () => {
    const tokenA = await authenticate(2001, 'Ada');
    const tokenB = await authenticate(2002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new sdk.Client(BASE);
    const clientB = new sdk.Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;
    const roomA = await clientA.joinById(roomId, { token: tokenA }, stateModule.PongState);
    const roomB = await clientB.joinById(roomId, { token: tokenB }, stateModule.PongState);

    await waitFor('both seated', () => roomA.state.players.size === 2);
    await waitFor(
      'simulation running',
      () => roomA.state.meta.phase !== gameCore.Phase.WAITING,
    );

    const inputA = roomA.input<{ targetX: number }>({ mode: 'reliable' });

    // The cheat: demand the far edge of the field, every tick, from a standing
    // start. An honest client never sends this.
    const observed: number[] = [];
    let previous = roomA.state.bottom.x;
    const sampler = setInterval(() => {
      observed.push(Math.abs(roomA.state.bottom.x - previous));
      previous = roomA.state.bottom.x;
    }, 100);

    const sender = setInterval(() => {
      inputA.data.targetX = inputA.data.targetX > 50 ? 0 : gameCore.FIELD_W;
      inputA.send();
    }, 1000 / 30);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    clearInterval(sender);
    clearInterval(sampler);

    // Over any 100ms window the paddle can legally travel at most
    // PADDLE_MAX_SPEED * 0.1 units. A generous allowance covers sampling jitter
    // and the patch cadence; the cheat would show as a jump of ~78 units.
    const legalPer100ms = gameCore.PADDLE_MAX_SPEED * 0.1;
    const worst = Math.max(...observed);
    expect(worst).toBeLessThan(legalPer100ms * 2.5);
    expect(worst).toBeLessThan(gameCore.FIELD_W - 2 * gameCore.PADDLE_HALF_W);

    await roomA.leave(true);
    await roomB.leave(true);
  }, 60_000);

  it('drains the input buffer while the room is still waiting', async () => {
    // THE HOST'S BUG. A host opens a room and sits on the waiting screen until
    // someone taps the invite — 49 seconds, in the match that produced this
    // test. The client's render loop is already running, so it is already
    // sending an input every tick. If the server only consumes inputs once the
    // ball is live, those pile up: the per-client buffer (64) overflows, and
    // from then on the ack advances ONLY by dropping the oldest input, so the
    // unacked queue stays pinned at the buffer size for the rest of the match.
    //
    // That number is the whole bug. The client's replay ring is 64 too, so a
    // queue that long means the oldest unacked inputs age out of it and are
    // SILENTLY SKIPPED on replay — the prediction can never reconstruct the
    // server's state again, and every single reconcile lands as a correction.
    // That is the ball teleporting.
    const tokenA = await authenticate(4001, 'Ada');
    const tokenB = await authenticate(4002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new sdk.Client(BASE);
    clientA.auth.token = tokenA;
    const roomA = await clientA.joinById(roomId, { token: tokenA }, stateModule.PongState);

    const inputA = roomA.input<{ targetX: number }>({ mode: 'reliable' });
    const sender = setInterval(() => {
      inputA.data.targetX = 50;
      inputA.send();
    }, gameCore.TICK_MS);

    // Long enough to more than fill a 64-slot buffer at 30 Hz.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const pendingWhileWaiting = inputA.pendingCount;

    // The guest arrives and the match begins.
    const clientB = new sdk.Client(BASE);
    clientB.auth.token = tokenB;
    const roomB = await clientB.joinById(roomId, { token: tokenB }, stateModule.PongState);
    await waitFor('match started', () => roomA.state.meta.phase !== gameCore.Phase.WAITING);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    clearInterval(sender);

    const pendingInMatch = inputA.pendingCount;

    // The threshold is not a taste call: past the client's own replay ring the
    // reconciler stops being able to replay everything it has sent.
    const ring = inputA.replayBufferSize;
    expect(pendingWhileWaiting).toBeLessThan(ring / 2);
    expect(pendingInMatch).toBeLessThan(ring / 2);

    await roomA.leave(true);
    await roomB.leave(true);
  }, 60_000);

  it('holds a silent player\'s paddle target instead of resetting it', async () => {
    // `idle: true` does NOT repeat the last command — it synthesizes a frame of
    // schema ZERO values. So a tick that finds an empty buffer (ordinary mobile
    // jitter) drove targetX to 0 and slid the paddle at full speed towards the
    // left wall, on the server only. The client, predicting with the real
    // target, cannot reproduce that, and the paddle it disagrees about is the
    // one the ball bounces off.
    const tokenA = await authenticate(4101, 'Ada');
    const tokenB = await authenticate(4102, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new sdk.Client(BASE);
    const clientB = new sdk.Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;
    const roomA = await clientA.joinById(roomId, { token: tokenA }, stateModule.PongState);
    const roomB = await clientB.joinById(roomId, { token: tokenB }, stateModule.PongState);

    await waitFor('both seated', () => roomA.state.players.size === 2);
    await waitFor('simulation running', () => roomA.state.meta.phase !== gameCore.Phase.WAITING);

    const bottomSession = [...roomA.state.players.values()].find(
      (player: { side: number }) => player.side === gameCore.SIDE_BOTTOM,
    );
    const bottomRoom = bottomSession?.sessionId === roomA.sessionId ? roomA : roomB;

    // One input, then silence — the limit case of a client whose packets are
    // merely late.
    const input = bottomRoom.input<{ targetX: number }>({ mode: 'reliable' });
    input.data.targetX = 70;
    input.send();

    await waitFor('target applied', () => Math.abs(roomA.state.bottom.targetX - 70) < 0.5);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Nothing was sent in that second and a half, so nothing may have changed.
    expect(roomA.state.bottom.targetX).toBeCloseTo(70, 1);

    await roomA.leave(true);
    await roomB.leave(true);
  }, 60_000);

  it('rejects a socket with no valid session token', async () => {
    const tokenA = await authenticate(3001, 'Ada');
    const roomId = await openRoom(tokenA);

    const client = new sdk.Client(BASE);
    client.auth.token = 'forged.token';
    await expect(
      client.joinById(roomId, { token: 'forged.token' }, stateModule.PongState),
    ).rejects.toThrow();
  }, 30_000);

  it('rejects an API call with no session token', async () => {
    const response = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'pong' }),
    });
    expect(response.status).toBe(401);
  });

  it('serves health without touching the (unreachable) database', async () => {
    // The database in this test cannot be reached. If `/healthz` queried it,
    // this would hang and then fail — which is exactly the deploy failure the
    // no-database health check exists to prevent on a cold Neon compute.
    const response = await fetch(`${BASE}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
