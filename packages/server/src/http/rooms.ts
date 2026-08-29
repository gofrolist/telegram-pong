/**
 * Room creation and invite resolution.
 *
 * Colyseus' `defineServer({ rooms })` registration *is* the game registry —
 * `game` here is only ever a key into it. There is deliberately no second
 * registry to keep in sync.
 */

import { matchMaker } from '@colyseus/core';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { db, tryWrite } from '../db/client.js';
import { rooms } from '../db/schema.js';
import { composeRoomId, seedFromString, OPEN_ROOM_TTL_MS } from '@pong/game-core';
import type { PongRoomCreateOptions } from '../rooms/PongRoom.js';

/** Games this deployment knows how to open a room for. */
const KNOWN_GAMES = new Set(['pong']);

/**
 * A short, unambiguous room code.
 *
 * Base32-ish alphabet with `0/O` and `1/I/L` removed: codes end up read aloud
 * and retyped, and those pairs are the two that actually get confused.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(length = 8): string {
  // Rejection sampling, not `% ALPHABET.length`: 256 is not a multiple of 31,
  // so a plain modulo draws the first eight letters 9/256 of the time against
  // 8/256 for the rest. The code is the only secret protecting an open room.
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface CreateRoomInput {
  game: string;
  hostUserId: number;
  chatInstance: string | null;
  rematchOfMatchId?: string | null;
  /** Restricts the second seat to one person, for a rematch. */
  expectedGuestUserId?: number | null;
}

export interface CreatedRoom {
  /** Public code carried by the invite link. */
  roomCode: string;
  /** Colyseus' own id, which the client passes to `joinById`. */
  colyseusRoomId: string;
  /**
   * Whether the `rooms` row was actually written.
   *
   * `false` means the room is live and joinable by id, but its *code* — and
   * therefore the invite link — cannot be resolved by anyone else.
   */
  persisted: boolean;
}

export class UnknownGameError extends Error {}

/**
 * Create a room and record it.
 *
 * The room is created server-side via `matchMaker.createRoom` rather than by
 * letting the client `joinOrCreate`, for two reasons: the host's rate-limit
 * budget is checked before anything is allocated, and the public code is
 * decided by us rather than derived from a Colyseus id we do not control.
 */
export async function createRoom(input: CreateRoomInput): Promise<CreatedRoom> {
  if (!KNOWN_GAMES.has(input.game)) {
    throw new UnknownGameError(`unknown game: ${input.game}`);
  }

  // The machine prefix is not used for routing today — there is one machine —
  // but it means a second machine is a `fly-replay` header rather than a data
  // migration.
  const roomCode = composeRoomId(config.FLY_MACHINE_ID, randomCode());

  const createOptions: PongRoomCreateOptions = {
    roomCode,
    hostUserId: input.hostUserId,
    chatInstance: input.chatInstance,
    rematchOfMatchId: input.rematchOfMatchId ?? null,
    expectedGuestUserId: input.expectedGuestUserId ?? null,
  };

  const room = await matchMaker.createRoom(input.game, createOptions);

  // This row is not bookkeeping — it is the only thing that can turn the code
  // in the invite link back into a joinable room, so a swallowed failure here
  // hands the host a link every recipient's `GET /api/rooms/:code` will 404 on
  // forever.
  //
  // It is deliberately still not fatal: the platform's standing commitment
  // (asserted by `netcode.integration.test.ts`, which runs against an
  // unreachable database on purpose) is that a database outage degrades stats
  // rather than breaking a match, and the host can still play through the
  // `colyseusRoomId` returned below. What was wrong was that the failure was
  // silent — `persisted` lets the caller say so instead of promising a link
  // that cannot work.
  const written = await tryWrite('createRoom', () =>
    db.insert(rooms).values({
      id: roomCode,
      colyseusRoomId: room.roomId,
      game: input.game,
      hostUserId: input.hostUserId,
      chatInstance: input.chatInstance,
      status: 'open',
      seed: seedFromString(roomCode),
      rematchOfMatchId: input.rematchOfMatchId ?? null,
      expiresAt: new Date(Date.now() + OPEN_ROOM_TTL_MS),
    }),
  );

  return { roomCode, colyseusRoomId: room.roomId, persisted: written !== null };
}

/**
 * Shut a room down and close its row.
 *
 * Used when a room was allocated for a flow that then failed: an invite nobody
 * will ever receive still costs a fixed timestep for the full hour of its TTL.
 */
export async function closeRoom(room: CreatedRoom): Promise<void> {
  await matchMaker.remoteRoomCall(room.colyseusRoomId, 'disconnect').catch(() => {});
  await tryWrite('closeRoom', () =>
    db.update(rooms).set({ status: 'closed' }).where(eq(rooms.id, room.roomCode)),
  );
}

export interface ResolvedRoom {
  roomCode: string;
  colyseusRoomId: string;
  game: string;
  status: string;
  hostUserId: number;
}

/**
 * Resolve an invite code to something joinable.
 *
 * Returns `null` for an expired, closed or unknown code — all three land the
 * tapper on the home screen with an offer to start their own match, which is
 * a better outcome than an error and is itself a conversion opportunity.
 */
export async function resolveRoom(roomCode: string): Promise<ResolvedRoom | null> {
  const [row] = await db.select().from(rooms).where(eq(rooms.id, roomCode)).limit(1);
  if (!row) return null;
  if (row.status === 'closed') return null;
  if (row.expiresAt.getTime() < Date.now() && row.status === 'open') return null;

  return {
    roomCode: row.id,
    colyseusRoomId: row.colyseusRoomId,
    game: row.game,
    status: row.status,
    hostUserId: row.hostUserId,
  };
}

/**
 * Close rooms whose invite was never taken.
 *
 * Runs on a timer, off the game loop. Colyseus disposes the room itself on its
 * own TTL; this is the database's half of the same decision.
 */
export async function reapExpiredRooms(): Promise<void> {
  await tryWrite('reapExpiredRooms', () =>
    db.execute(
      // Only `open` rooms expire. A `playing` room is a live match and its
      // lifetime belongs to Colyseus, not to a clock.
      `update rooms set status = 'closed'
       where status = 'open' and expires_at < now()`,
    ),
  );
}
