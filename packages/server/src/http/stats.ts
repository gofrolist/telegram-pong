/**
 * Stats reads: head-to-head, per-chat leaderboard, profile.
 *
 * Game-agnostic — every query is parameterised by `game`, so a second game
 * reuses this file untouched.
 *
 * There is no global rating and no rank. All Phase-1 matches are between
 * people who chose each other, which makes collusion indistinguishable from
 * ordinary play; a global number computed from them would be unprotectable by
 * any algorithm, so none is computed.
 */

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { cheatFlags, chatLeaderboard, headToHead, matches, playerStats, users } from '../db/schema.js';
import { orderPair } from '../db/schema.js';

export interface HeadToHeadResult {
  /** Wins by the requesting user. */
  mine: number;
  /** Wins by the opponent. */
  theirs: number;
  opponent: { id: number; name: string; username: string | null; photoUrl: string | null } | null;
}

export async function getHeadToHead(
  game: string,
  userId: number,
  opponentId: number,
): Promise<HeadToHeadResult> {
  const { low, high } = orderPair(userId, opponentId);

  const [record] = await db
    .select()
    .from(headToHead)
    .where(
      and(
        eq(headToHead.game, game),
        eq(headToHead.lowUserId, low),
        eq(headToHead.highUserId, high),
      ),
    )
    .limit(1);

  const [opponent] = await db
    .select({
      id: users.id,
      name: users.firstName,
      username: users.username,
      photoUrl: users.photoUrl,
    })
    .from(users)
    .where(eq(users.id, opponentId))
    .limit(1);

  const userIsLow = userId === low;
  return {
    mine: (userIsLow ? record?.lowWins : record?.highWins) ?? 0,
    theirs: (userIsLow ? record?.highWins : record?.lowWins) ?? 0,
    opponent: opponent
      ? {
          id: opponent.id,
          name: opponent.name ?? '',
          username: opponent.username,
          photoUrl: opponent.photoUrl,
        }
      : null,
  };
}

/** Every opponent this user has a record against, most recent first. */
export async function listHeadToHead(game: string, userId: number, limit = 20) {
  const rows = await db
    .select()
    .from(headToHead)
    .where(
      and(
        eq(headToHead.game, game),
        or(eq(headToHead.lowUserId, userId), eq(headToHead.highUserId, userId)),
      ),
    )
    .orderBy(desc(headToHead.lastMatchAt))
    .limit(limit);

  const opponentIds = rows.map((row) => (row.lowUserId === userId ? row.highUserId : row.lowUserId));
  const profiles = opponentIds.length
    ? await db
        .select({
          id: users.id,
          name: users.firstName,
          username: users.username,
          photoUrl: users.photoUrl,
        })
        .from(users)
        .where(inArray(users.id, opponentIds))
    : [];
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  return rows.map((row) => {
    const userIsLow = row.lowUserId === userId;
    const opponentId = userIsLow ? row.highUserId : row.lowUserId;
    const profile = byId.get(opponentId);
    return {
      opponentId,
      name: profile?.name ?? '',
      username: profile?.username ?? null,
      photoUrl: profile?.photoUrl ?? null,
      mine: userIsLow ? row.lowWins : row.highWins,
      theirs: userIsLow ? row.highWins : row.lowWins,
      lastMatchAt: row.lastMatchAt,
    };
  });
}

export interface ChatLeaderboardRow {
  userId: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
  wins: number;
  losses: number;
  matches: number;
}

/**
 * Per-chat leaderboard by win count.
 *
 * Flagged players are omitted. A flag is never a ban — it is exclusion from
 * this list and nothing else, because false positives on genuinely strong
 * players are certain and an auto-ban would turn a statistical guess into a
 * product failure.
 */
export async function getChatLeaderboard(
  chatInstance: string,
  game: string,
  limit = 20,
): Promise<ChatLeaderboardRow[]> {
  const flagged = db
    .select({ userId: cheatFlags.userId })
    .from(cheatFlags)
    .where(and(eq(cheatFlags.game, game), eq(cheatFlags.active, true)));

  const rows = await db
    .select({
      userId: chatLeaderboard.userId,
      wins: chatLeaderboard.wins,
      losses: chatLeaderboard.losses,
      matches: chatLeaderboard.matches,
      name: users.firstName,
      username: users.username,
      photoUrl: users.photoUrl,
    })
    .from(chatLeaderboard)
    .leftJoin(users, eq(users.id, chatLeaderboard.userId))
    .where(
      and(
        eq(chatLeaderboard.chatInstance, chatInstance),
        eq(chatLeaderboard.game, game),
        sql`${chatLeaderboard.userId} not in ${flagged}`,
      ),
    )
    .orderBy(desc(chatLeaderboard.wins), desc(chatLeaderboard.matches))
    .limit(limit);

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name ?? '',
    username: row.username,
    photoUrl: row.photoUrl,
    wins: row.wins,
    losses: row.losses,
    matches: row.matches,
  }));
}

export interface ProfileStats {
  matches: number;
  wins: number;
  winRate: number;
  longestRally: number;
  bestStreak: number;
  currentStreak: number;
}

export async function getProfileStats(game: string, userId: number): Promise<ProfileStats> {
  const [row] = await db
    .select()
    .from(playerStats)
    .where(and(eq(playerStats.game, game), eq(playerStats.userId, userId)))
    .limit(1);

  const played = row?.matches ?? 0;
  const wins = row?.wins ?? 0;
  return {
    matches: played,
    wins,
    winRate: played > 0 ? wins / played : 0,
    longestRally: row?.longestRally ?? 0,
    bestStreak: row?.bestStreak ?? 0,
    currentStreak: row?.currentStreak ?? 0,
  };
}

/** The match a result screen or a share is about. */
export async function getMatch(matchId: string) {
  const [row] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  return row ?? null;
}
