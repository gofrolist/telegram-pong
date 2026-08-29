/**
 * Colyseus connection.
 *
 * The second netcode module, and the only other one: joining, reconnecting and
 * leaving. Prediction lives entirely in `predictionAdapter.ts`.
 */

import { Client, type Room } from '@colyseus/sdk';
import { PongState } from '@pong/game-core/net';

import { SERVER_URL } from '../api.js';

/**
 * `https://` → `wss://`. The SDK takes an HTTP(S) endpoint and upgrades it
 * itself, so the scheme only has to be right, not rewritten.
 */
const client = new Client(SERVER_URL);

export type PongRoomHandle = Room<PongState>;

export interface JoinOptions {
  colyseusRoomId: string;
  /** Our short-lived session token; the room's `onAuth` validates it. */
  token: string;
}

/**
 * Join a room by its Colyseus id.
 *
 * The id comes from our own API rather than from matchmaking: the invite
 * carries a public room *code*, which the backend resolves. That indirection
 * is what lets the code stay short and human-shaped while Colyseus keeps
 * whatever id format it likes.
 */
export async function joinRoom(options: JoinOptions): Promise<PongRoomHandle> {
  // The room's `static onAuth` receives the token from the Authorization
  // header, which the SDK builds from `client.auth.token`. It is also passed
  // in the join options as a fallback the room accepts.
  client.auth.token = options.token;
  return client.joinById<PongState>(options.colyseusRoomId, { token: options.token }, PongState);
}

/**
 * Resume a session that dropped.
 *
 * The reconnection token is minted by the server when the client first joined
 * and is the only way back into a room that is holding a seat open. Colyseus
 * owns the grace period; this just presents the ticket.
 */
export async function reconnect(reconnectionToken: string, token: string): Promise<PongRoomHandle> {
  client.auth.token = token;
  return client.reconnect<PongState>(reconnectionToken, PongState);
}
