/**
 * HTTP client for our own backend.
 *
 * Vercel and fly are different origins, so every one of these is a
 * cross-origin request that the browser will preflight; the server's CORS
 * allowlist is the matching half.
 *
 * The session token is held in memory only. Persisting it would outlive the
 * `initData` it was minted from, and the whole point of a short-lived token is
 * that it expires.
 */

import type { InvitePayload } from '@pong/game-core';

const BASE = import.meta.env.VITE_SERVER_URL ?? 'https://localhost:2567';

export interface AuthUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  languageCode?: string;
  isPremium: boolean;
}

export interface AuthResponse {
  token: string;
  expiresIn: number;
  user: AuthUser;
  languageOverride: string | null;
  chat: { instance: string; type: string | null } | null;
  chatLeaderboardsEnabled: boolean;
  invite: InvitePayload | null;
  botUsername: string;
  appName: string;
}

export interface CreatedRoom {
  roomCode: string;
  colyseusRoomId: string;
  origin: string;
  /**
   * `null` when the server could not record the room: it is still joinable by
   * `colyseusRoomId`, but its code resolves to nothing, so there is no link
   * worth showing the host.
   */
  startParam: string | null;
  inviteUrl: string | null;
}

export interface ResolvedRoom {
  roomCode: string;
  colyseusRoomId: string;
  game: string;
  status: string;
  hostUserId: number;
}

export interface ProfileResponse {
  stats: {
    matches: number;
    wins: number;
    winRate: number;
    longestRally: number;
    bestStreak: number;
    currentStreak: number;
  };
  opponents: Array<{
    opponentId: number;
    name: string;
    username: string | null;
    photoUrl: string | null;
    mine: number;
    theirs: number;
    lastMatchAt: string;
  }>;
}

export interface ChatLeaderboardResponse {
  available: boolean;
  reason?: 'disabled' | 'no_chat_context' | 'solo_conversation';
  rows: Array<{
    userId: number;
    name: string;
    username: string | null;
    photoUrl: string | null;
    wins: number;
    losses: number;
    matches: number;
  }>;
}

export interface PreparedShareResponse {
  id: string;
  expirationDate: number;
  rematchRoom: { roomCode: string; colyseusRoomId: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

let token: string | null = null;

export function setToken(value: string | null): void {
  token = value;
}

export function hasToken(): boolean {
  return token !== null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    // No cookies anywhere: the session lives entirely in the bearer token, so
    // there is nothing for a cross-site request to carry implicitly.
    credentials: 'omit',
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      // A non-JSON error body is still an error; the status carries the signal.
    }
    throw new ApiError(response.status, code);
  }

  return (await response.json()) as T;
}

/**
 * Exchange raw `initData` for a session token.
 *
 * This is the only place `initData` leaves the client.
 */
export async function authenticate(initDataRaw: string): Promise<AuthResponse> {
  const result = await request<AuthResponse>('/api/auth', {
    method: 'POST',
    body: JSON.stringify({ initData: initDataRaw }),
  });
  setToken(result.token);
  return result;
}

export function createRoom(options: { game?: string; rematchOfMatchId?: string } = {}) {
  return request<CreatedRoom>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ game: options.game ?? 'pong', ...options }),
  });
}

export function resolveRoom(roomCode: string) {
  return request<ResolvedRoom>(`/api/rooms/${encodeURIComponent(roomCode)}`);
}

export function getProfile(game = 'pong') {
  return request<ProfileResponse>(`/api/stats/profile?game=${encodeURIComponent(game)}`);
}

export function getChatLeaderboard(game = 'pong') {
  return request<ChatLeaderboardResponse>(`/api/stats/chat?game=${encodeURIComponent(game)}`);
}

/**
 * Prepare a shareable card.
 *
 * The returned id is single-use, so this is called on every share tap rather
 * than cached — a reused id gives the user a chat picker that silently does
 * nothing.
 */
export function prepareShare(matchId: string) {
  return request<PreparedShareResponse>(`/api/share/${encodeURIComponent(matchId)}`, {
    method: 'POST',
  });
}

export function setLanguage(language: string | null) {
  return request<{ ok: true }>('/api/language', {
    method: 'POST',
    body: JSON.stringify({ language }),
  });
}

/** Report one of the funnel steps only the client can see. */
export function reportEvent(
  name: 'share_message_sent' | 'share_message_failed' | 'rematch_tapped' | 'invite_shared',
  props: Record<string, unknown> = {},
): void {
  // Fire-and-forget: instrumentation must never block or fail a user action.
  void request('/api/events', {
    method: 'POST',
    body: JSON.stringify({ name, ...props }),
  }).catch(() => {});
}

export const SERVER_URL = BASE;
