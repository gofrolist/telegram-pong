/**
 * Post-match persistence.
 *
 * Called exactly once per match, after the last tick — never from inside one.
 * Only the server reaches this code; there is no message shape a client can
 * send that results in a row here.
 *
 * All four derived tables (head-to-head, chat leaderboard, profile stats,
 * trace) are updated in one transaction with the match row, so a crash
 * mid-write cannot leave a leaderboard that disagrees with the match history.
 */

import { and, eq, sql } from 'drizzle-orm';

import { db, tryWrite } from './db/client.js';
import {
  chatLeaderboard,
  chats,
  headToHead,
  matchTraces,
  matches,
  playerStats,
  rooms,
  orderPair,
} from './db/schema.js';
import type { MatchTrace } from './antiCheat/traceRecorder.js';

export interface FinishMatchInput {
  roomCode: string;
  colyseusRoomId: string;
  game: string;
  origin: 'invite' | 'pool';
  seed: number;
  chatInstance: string | null;
  /** Bottom side. */
  playerAId: number;
  /** Top side. */
  playerBId: number;
  scoreA: number;
  scoreB: number;
  winnerId: number | null;
  endReason: 'score' | 'disconnect' | 'forfeit';
  longestRally: number;
  durationMs: number;
  startedAt: Date;
  trace: MatchTrace;
  chatLeaderboardsEnabled: boolean;
}

/**
 * Write a completed match and everything derived from it.
 *
 * Returns the new match id, or `null` if the write failed — the caller treats
 * a failure as "no shareable card", not as a reason to break the room.
 */
export async function finishMatch(input: FinishMatchInput): Promise<string | null> {
  const result = await tryWrite('finishMatch', async () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(matches)
        .values({
          game: input.game,
          origin: input.origin,
          roomId: input.roomCode,
          chatInstance: input.chatInstance,
          seed: input.seed,
          playerAId: input.playerAId,
          playerBId: input.playerBId,
          scoreA: input.scoreA,
          scoreB: input.scoreB,
          winnerId: input.winnerId,
          endReason: input.endReason,
          longestRally: input.longestRally,
          durationMs: input.durationMs,
          startedAt: input.startedAt,
        })
        .returning({ id: matches.id });

      const matchId = row?.id;
      if (!matchId) throw new Error('match insert returned no id');

      // The trace exists only for the offline cheat job. It is written in the
      // same transaction so a trace can never reference a match that isn't
      // there.
      await tx.insert(matchTraces).values({
        matchId,
        tickRate: input.trace.tickRate,
        trace: input.trace,
      });

      await tx
        .update(rooms)
        .set({ status: 'closed' })
        .where(eq(rooms.id, input.roomCode));

      if (input.winnerId !== null) {
        const loserId = input.winnerId === input.playerAId ? input.playerBId : input.playerAId;
        await updateHeadToHead(tx, input.game, input.winnerId, loserId);
        await updateProfileStats(tx, input.game, input.winnerId, loserId, input.longestRally);

        if (input.chatInstance && input.chatLeaderboardsEnabled) {
          await updateChatLeaderboard(tx, input.chatInstance, input.game, input.winnerId, loserId);
        }
      }

      if (input.chatInstance) {
        await tx
          .update(chats)
          .set({ lastMatchAt: new Date() })
          .where(eq(chats.chatInstance, input.chatInstance));
      }

      return matchId;
    }),
  );

  return result ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Head-to-head, stored once per unordered pair.
 *
 * The pair is normalised to `low < high` before writing, so two players can
 * never end up with two rows that disagree about their record.
 */
async function updateHeadToHead(tx: Tx, game: string, winnerId: number, loserId: number): Promise<void> {
  const { low, high } = orderPair(winnerId, loserId);
  const winnerIsLow = winnerId === low;

  await tx
    .insert(headToHead)
    .values({
      game,
      lowUserId: low,
      highUserId: high,
      lowWins: winnerIsLow ? 1 : 0,
      highWins: winnerIsLow ? 0 : 1,
      lastMatchAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [headToHead.game, headToHead.lowUserId, headToHead.highUserId],
      set: {
        lowWins: winnerIsLow ? sql`${headToHead.lowWins} + 1` : headToHead.lowWins,
        highWins: winnerIsLow ? headToHead.highWins : sql`${headToHead.highWins} + 1`,
        lastMatchAt: new Date(),
      },
    });
}

/**
 * Profile stats. Rank-free by design — matches played, win rate, longest
 * rally, best streak, and nothing that could be read as a ladder position.
 */
async function updateProfileStats(
  tx: Tx,
  game: string,
  winnerId: number,
  loserId: number,
  longestRally: number,
): Promise<void> {
  // Lock the two rows in ascending user-id order, never winner-then-loser.
  // Two rooms between the same pair can finish at the same moment with
  // opposite winners; ordering by outcome makes them take the same two locks
  // in opposite orders, Postgres aborts one on deadlock, `tryWrite` swallows
  // it, and a match that was actually played gets no row, no stats and no
  // card. `updateHeadToHead` already normalises via `orderPair` — this is the
  // same discipline applied to the tables that were missing it.
  for (const userId of ascending(winnerId, loserId)) {
    await upsertPlayerStats(tx, game, userId, userId === winnerId, longestRally);
  }
}

/** The two ids in a canonical order, so every transaction locks them alike. */
function ascending(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

async function upsertPlayerStats(
  tx: Tx,
  game: string,
  userId: number,
  won: boolean,
  longestRally: number,
): Promise<void> {
  await tx
    .insert(playerStats)
    .values({
      userId,
      game,
      matches: 1,
      wins: won ? 1 : 0,
      longestRally,
      bestStreak: won ? 1 : 0,
      currentStreak: won ? 1 : 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [playerStats.userId, playerStats.game],
      set: won
        ? {
            matches: sql`${playerStats.matches} + 1`,
            wins: sql`${playerStats.wins} + 1`,
            longestRally: sql`greatest(${playerStats.longestRally}, ${longestRally})`,
            currentStreak: sql`${playerStats.currentStreak} + 1`,
            bestStreak: sql`greatest(${playerStats.bestStreak}, ${playerStats.currentStreak} + 1)`,
            updatedAt: new Date(),
          }
        : {
            matches: sql`${playerStats.matches} + 1`,
            longestRally: sql`greatest(${playerStats.longestRally}, ${longestRally})`,
            currentStreak: 0,
            updatedAt: new Date(),
          },
    });
}

/**
 * Per-chat leaderboard by win count.
 *
 * Manipulation inside a chat is policed by the chat's own members, which at
 * this scale is the only enforcement that actually works.
 */
async function updateChatLeaderboard(
  tx: Tx,
  chatInstance: string,
  game: string,
  winnerId: number,
  loserId: number,
): Promise<void> {
  await tx
    .insert(chats)
    .values({ chatInstance, lastMatchAt: new Date() })
    .onConflictDoNothing();

  // Ascending user-id order, for the deadlock reason in `updateProfileStats`.
  for (const userId of ascending(winnerId, loserId)) {
    const won = userId === winnerId;
    await tx
      .insert(chatLeaderboard)
      .values({
        chatInstance,
        game,
        userId,
        wins: won ? 1 : 0,
        losses: won ? 0 : 1,
        matches: 1,
        lastMatchAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [chatLeaderboard.chatInstance, chatLeaderboard.game, chatLeaderboard.userId],
        set: won
          ? {
              wins: sql`${chatLeaderboard.wins} + 1`,
              matches: sql`${chatLeaderboard.matches} + 1`,
              lastMatchAt: new Date(),
            }
          : {
              losses: sql`${chatLeaderboard.losses} + 1`,
              matches: sql`${chatLeaderboard.matches} + 1`,
              lastMatchAt: new Date(),
            },
      });
  }
}

/** Flag a room as filled and remember when, for the "opponent waiting" nudge. */
export async function markRoomFilled(roomCode: string, guestUserId: number): Promise<void> {
  await tryWrite('markRoomFilled', () =>
    db
      .update(rooms)
      .set({ status: 'playing', guestUserId, filledAt: new Date() })
      .where(and(eq(rooms.id, roomCode), eq(rooms.status, 'open'))),
  );
}

export async function markRoomStatus(roomCode: string, status: string): Promise<void> {
  await tryWrite('markRoomStatus', () =>
    db.update(rooms).set({ status }).where(eq(rooms.id, roomCode)),
  );
}
