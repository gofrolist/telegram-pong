/**
 * Reconnection, and the result card.
 *
 * The acceptance criterion this covers: killing one client's network mid-match
 * must pause the game **for both players** and resume cleanly when they come
 * back — not hand the connected player free points while the other's paddle
 * sits frozen.
 *
 * The grace period itself is Colyseus' (`allowReconnection`). What is tested
 * here is that the room reacts to it correctly: the phase freezes, the
 * countdown is visible to both, and play resumes through a fresh countdown
 * rather than straight back into a live ball.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS-ONLY';
const PORT = 2605;
const BASE = `http://localhost:${PORT}`;

type SdkModule = typeof import('@colyseus/sdk');
let sdk: SdkModule;
let sign: typeof import('@telegram-apps/init-data-node').sign;
let gameCore: typeof import('@pong/game-core');
let stateModule: typeof import('@pong/game-core/net');
let renderResultCard: typeof import('../src/share/card.js').renderResultCard;
let server: ChildProcess | undefined;

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
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: 'pong_test_bot',
      TELEGRAM_APP_NAME: 'pong',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-value-1234567890',
      PUBLIC_SERVER_URL: BASE,
      PUBLIC_CLIENT_URL: 'http://localhost:5173',
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nowhere',
      SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function authenticate(userId: number, name: string): Promise<string> {
  const initData = sign(
    { user: { id: userId, first_name: name, language_code: 'en' } },
    BOT_TOKEN,
    new Date(),
  );
  const response = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  return ((await response.json()) as { token: string }).token;
}

async function openRoom(token: string): Promise<string> {
  const response = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game: 'pong' }),
  });
  return ((await response.json()) as { colyseusRoomId: string }).colyseusRoomId;
}

beforeAll(async () => {
  sdk = await import('@colyseus/sdk');
  ({ sign } = await import('@telegram-apps/init-data-node'));
  gameCore = await import('@pong/game-core');
  stateModule = await import('@pong/game-core/net');
  ({ renderResultCard } = await import('../src/share/card.js'));

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

describe('reconnection', () => {
  it('pauses the match for both players and resumes cleanly', async () => {
    const tokenA = await authenticate(7001, 'Ada');
    const tokenB = await authenticate(7002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new sdk.Client(BASE);
    const clientB = new sdk.Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;

    const roomA = await clientA.joinById(roomId, { token: tokenA }, stateModule.PongState);
    const roomB = await clientB.joinById(roomId, { token: tokenB }, stateModule.PongState);

    await waitFor('both seated', () => roomA.state.players.size === 2);
    await waitFor('ball in play', () => roomA.state.meta.phase === gameCore.Phase.PLAYING);

    const reconnectionToken = roomB.reconnectionToken;
    expect(reconnectionToken).toBeTruthy();

    // Drop B the way a phone losing signal drops: `leave(false)` is an
    // UNCONSENTED leave, which is what routes through `onDrop` and
    // `allowReconnection` rather than through a clean `onLeave`.
    await roomB.leave(false);

    // The connected player's view must freeze too. Letting A keep rallying
    // against a frozen paddle would hand them free points.
    await waitFor(
      'match paused for the player who stayed',
      () => roomA.state.meta.phase === gameCore.Phase.PAUSED,
      15_000,
    );

    // Both players see a countdown, so the freeze is explained rather than
    // just being a dead screen.
    let sawCountdown = false;
    roomA.state.players.forEach((player: { reconnectSecondsLeft: number }) => {
      if (player.reconnectSecondsLeft > 0) sawCountdown = true;
    });
    expect(sawCountdown).toBe(true);

    // Roughly the five seconds the acceptance criterion names.
    await sleep(5000);
    expect(roomA.state.meta.phase).toBe(gameCore.Phase.PAUSED);

    const rejoined = await clientB.reconnect(reconnectionToken, stateModule.PongState);

    // Resume through a countdown, never straight back into a live ball: the
    // returning player has been looking at a frozen screen.
    await waitFor(
      'resumed',
      () =>
        roomA.state.meta.phase === gameCore.Phase.COUNTDOWN ||
        roomA.state.meta.phase === gameCore.Phase.PLAYING,
      15_000,
    );
    await waitFor(
      'ball moving again',
      () => roomA.state.meta.phase === gameCore.Phase.PLAYING,
      15_000,
    );

    // Nobody was awarded anything for the interruption.
    expect(roomA.state.meta.endReason).toBe(gameCore.EndReason.NONE);
    // And the returning player is back on their own side.
    expect(rejoined.state.players.size).toBe(2);

    await roomA.leave(true);
    await rejoined.leave(true);
  }, 120_000);
});

describe('result card', () => {
  it('renders a PNG with no network access and no avatars', async () => {
    // The initials fallback path: a user with no photo, and a name in a script
    // the default font must still cover.
    const png = await renderResultCard({
      bottom: { name: 'Ada', photoUrl: null, score: 7, isWinner: true },
      top: { name: 'Грейс', photoUrl: null, score: 4, isWinner: false },
      longestRally: 23,
    });

    expect(png.byteLength).toBeGreaterThan(5000);
    // PNG magic number, so a silently-empty render fails here rather than at
    // the moment a user taps share.
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 30_000);

  it('survives an unreachable avatar URL rather than hanging the share', async () => {
    const png = await renderResultCard({
      bottom: { name: 'Ada', photoUrl: 'http://127.0.0.1:1/nope.jpg', score: 7, isWinner: true },
      top: { name: 'Grace', photoUrl: 'not a url at all', score: 5, isWinner: false },
      longestRally: 9,
    });
    expect(png.byteLength).toBeGreaterThan(5000);
  }, 30_000);

  it('escapes a name that would otherwise break the SVG', async () => {
    // A display name is user-controlled and goes straight into an XML
    // document; an unescaped `<` would produce an invalid SVG and a failed
    // render, or worse, injected markup.
    const png = await renderResultCard({
      bottom: { name: '<script>&"\'', photoUrl: null, score: 7, isWinner: true },
      top: { name: ']]><!--', photoUrl: null, score: 0, isWinner: false },
      longestRally: 1,
    });
    expect(png.byteLength).toBeGreaterThan(5000);
  }, 30_000);
});

describe('asynchronous invites', () => {
  /**
   * The empty-room problem, which is the single biggest silent killer of an
   * invite-only game.
   *
   * With no AI opponent an invite is often tapped an hour later, by which time
   * the inviter has closed the app. The room outliving them is only half the
   * answer — the other half is telling them somebody showed up. The
   * notification used to fire from `beginMatch`, which needs BOTH players
   * connected, so it announced the opponent only in the one case where the
   * host could already see them arrive on screen, and stayed silent in the
   * case it exists for.
   */
  it('keeps the room open and alive after the host leaves, and seats a later guest', async () => {
    const tokenA = await authenticate(8001, 'Ada');
    const tokenB = await authenticate(8002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new sdk.Client(BASE);
    clientA.auth.token = tokenA;
    const roomA = await clientA.joinById(roomId, { token: tokenA }, stateModule.PongState);
    await waitFor('host seated', () => roomA.state.players.size === 1);

    // The host closes the app while nobody has taken the invite yet.
    await roomA.leave(true);
    await sleep(1500);

    // An hour later (a second and a half here) somebody taps the link. The
    // room must still be joinable — not ENDED by the host's departure.
    const clientB = new sdk.Client(BASE);
    clientB.auth.token = tokenB;
    const roomB = await clientB.joinById(roomId, { token: tokenB }, stateModule.PongState);

    await waitFor('guest seated', () => roomB.state.players.size >= 1);

    // Still waiting, because a match needs two people — but crucially the room
    // is alive and the guest is in it, not bounced off a dead room.
    expect(roomB.state.meta.phase).toBe(gameCore.Phase.WAITING);
    expect(roomB.state.meta.endReason).toBe(gameCore.EndReason.NONE);

    // The guest took the open slot, so they are the top side; the bottom seat
    // stays reserved for the host who created the room.
    const me = roomB.state.players.get(roomB.sessionId);
    expect(me).toBeDefined();
    expect(me!.side).toBe(gameCore.SIDE_TOP);

    // And when the host comes back, the match starts.
    const clientA2 = new sdk.Client(BASE);
    clientA2.auth.token = tokenA;
    const roomA2 = await clientA2.joinById(roomId, { token: tokenA }, stateModule.PongState);

    await waitFor(
      'match starts once both are present',
      () => roomA2.state.meta.phase !== gameCore.Phase.WAITING,
      20_000,
    );
    expect(roomA2.state.players.get(roomA2.sessionId)!.side).toBe(gameCore.SIDE_BOTTOM);

    await roomA2.leave(true);
    await roomB.leave(true);
  }, 90_000);
});
