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
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
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

  await tryWrite('createRoom', () =>
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

  return { roomCode, colyseusRoomId: room.roomId };
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
