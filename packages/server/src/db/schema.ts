/**
 * Data model.
 *
 * Two structural commitments, both there to keep the platform open:
 *
 *  - Every table that could ever be game-specific carries a `game` column.
 *    Adding a second game must not mean adding tables to stats or leaderboards.
 *  - Every match carries an `origin` (`invite` | `pool`). Phase 1 only ever
 *    writes `invite`, but tagging from day one is what makes a future global
 *    rating computable *exclusively* from pool matches without a backfill.
 *
 * There is deliberately no rating column anywhere. All Phase-1 matches are
 * between people who chose each other, which makes collusion indistinguishable
 * from normal play; a global number here would be unprotectable.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Telegram user ids exceed 2^32, so they are `bigint` throughout. */
const telegramUserId = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable(
  'users',
  {
    /** Telegram user id. Authoritative — it comes from signed `initData`. */
    id: telegramUserId('id').primaryKey(),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    photoUrl: text('photo_url'),
    /** `language_code` as Telegram signed it. Trustworthy, may carry a region. */
    languageCode: text('language_code'),
    /**
     * An explicit in-app language choice. Wins over `languageCode`.
     * Resolution order is: this → languageCode → 'en'.
     */
    languageOverride: text('language_override'),
    /**
     * WRITE-ONCE. Set on a user's first launch if the start param carried a
     * referrer, and never updated afterwards — attribution that can be
     * rewritten is attribution that will be farmed.
     */
    referrerUserId: telegramUserId('referrer_user_id'),
    isPremium: boolean('is_premium').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('users_referrer_idx').on(table.referrerUserId)],
);

/**
 * A chat, identified only by `chat_instance`.
 *
 * `chat_instance` is opaque: it identifies a chat without naming it, and
 * Telegram returns it only for Mini Apps opened by direct link. The UI
 * therefore says "this chat" and never a title. `chat_type` is stored so that
 * leaderboards can be suppressed in `sender`/`private` conversations, where a
 * "chat leaderboard" would be a table of two.
 */
export const chats = pgTable('chats', {
  chatInstance: text('chat_instance').primaryKey(),
  /** `sender` | `private` | `group` | `supergroup` | `channel`. */
  chatType: text('chat_type'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastMatchAt: timestamp('last_match_at', { withTimezone: true }),
});

/**
 * An open or in-flight room.
 *
 * Rooms are asynchronous by design: with no AI opponent, an invite dropped in
 * a chat is often tapped an hour later, and a room that dies in thirty seconds
 * makes most invites fail silently.
 */
export const rooms = pgTable(
  'rooms',
  {
    /**
     * The PUBLIC room code, `<machineId>-<code>`. This is what travels in an
     * invite link. The machine prefix is not used for routing today (there is
     * one machine) but is what makes a second machine a `fly-replay` header
     * rather than a data migration.
     */
    id: text('id').primaryKey(),
    /**
     * Colyseus' own room id, which the framework allocates and we do not
     * control. Kept separate from the public code so the invite link never
     * changes shape if Colyseus changes its id format.
     */
    colyseusRoomId: text('colyseus_room_id').notNull(),
    game: text('game').notNull().default('pong'),
    hostUserId: telegramUserId('host_user_id').notNull(),
    guestUserId: telegramUserId('guest_user_id'),
    chatInstance: text('chat_instance'),
    /** `open` | `full` | `playing` | `closed`. */
    status: text('status').notNull().default('open'),
    /** Seed for the deterministic simulation. */
    seed: integer('seed').notNull(),
    /** Set when this room was opened as a rematch of an earlier match. */
    rematchOfMatchId: uuid('rematch_of_match_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Open rooms live about an hour; a reaper closes them after this. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when the second player took the slot; drives the "opponent is
     * waiting" message the bot sends back to the inviter. */
    filledAt: timestamp('filled_at', { withTimezone: true }),
  },
  (table) => [
    index('rooms_status_expires_idx').on(table.status, table.expiresAt),
    index('rooms_host_created_idx').on(table.hostUserId, table.createdAt),
  ],
);

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    game: text('game').notNull().default('pong'),
    /** `invite` today; `pool` is reserved for a future matchmaking pool. */
    origin: text('origin').notNull().default('invite'),
    roomId: text('room_id').notNull(),
    chatInstance: text('chat_instance'),
    seed: integer('seed').notNull(),

    /** `a` is always the bottom side, `b` the top side. */
    playerAId: telegramUserId('player_a_id').notNull(),
    playerBId: telegramUserId('player_b_id').notNull(),
    scoreA: smallint('score_a').notNull(),
    scoreB: smallint('score_b').notNull(),
    /** Null only for a draw, which Pong cannot produce; kept for other games. */
    winnerId: telegramUserId('winner_id'),
    /** `score` | `disconnect` | `forfeit`. */
    endReason: text('end_reason').notNull(),

    longestRally: smallint('longest_rally').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('matches_player_a_idx').on(table.playerAId, table.endedAt),
    index('matches_player_b_idx').on(table.playerBId, table.endedAt),
    index('matches_chat_idx').on(table.chatInstance, table.endedAt),
    index('matches_origin_idx').on(table.origin, table.endedAt),
  ],
);

/**
 * The full input trace of a match, for the offline cheat-detection job.
 *
 * Pong traces are kilobytes — two 16-bit values per player per tick — so this
 * is stored inline rather than in object storage. Written once, after the
 * match ends; never inside a tick.
 */
export const matchTraces = pgTable('match_traces', {
  matchId: uuid('match_id')
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  tickRate: smallint('tick_rate').notNull(),
  /**
   * `{ a: number[], b: number[], ballX: number[], ballY: number[] }` — the
   * desired paddle X per tick per player, plus the ball path they were
   * reacting to. That pairing is what makes reaction latency computable.
   */
  trace: jsonb('trace').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Head-to-head record between two players.
 *
 * Stored once per unordered pair, with `lowId < highId` enforced by the
 * writer, so a pair has exactly one row rather than two that can disagree.
 * Visible only to the two people in it: farming a friend unlocks nothing.
 */
export const headToHead = pgTable(
  'head_to_head',
  {
    game: text('game').notNull().default('pong'),
    lowUserId: telegramUserId('low_user_id').notNull(),
    highUserId: telegramUserId('high_user_id').notNull(),
    lowWins: integer('low_wins').notNull().default(0),
    highWins: integer('high_wins').notNull().default(0),
    lastMatchAt: timestamp('last_match_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.game, table.lowUserId, table.highUserId] }),
    index('h2h_low_idx').on(table.game, table.lowUserId),
    index('h2h_high_idx').on(table.game, table.highUserId),
  ],
);

/**
 * Per-chat leaderboard, by win count.
 *
 * Manipulation inside a chat is policed by the chat's own members, which is
 * the only enforcement mechanism that actually works at this scale.
 */
export const chatLeaderboard = pgTable(
  'chat_leaderboard',
  {
    chatInstance: text('chat_instance').notNull(),
    game: text('game').notNull().default('pong'),
    userId: telegramUserId('user_id').notNull(),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    matches: integer('matches').notNull().default(0),
    lastMatchAt: timestamp('last_match_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatInstance, table.game, table.userId] }),
    index('chat_lb_rank_idx').on(table.chatInstance, table.game, table.wins),
  ],
);

/** Profile stats. Deliberately rank-free. */
export const playerStats = pgTable(
  'player_stats',
  {
    userId: telegramUserId('user_id').notNull(),
    game: text('game').notNull().default('pong'),
    matches: integer('matches').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    longestRally: smallint('longest_rally').notNull().default(0),
    bestStreak: integer('best_streak').notNull().default(0),
    currentStreak: integer('current_streak').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.game] })],
);

/**
 * Output of the nightly cheat-detection job.
 *
 * A flag NEVER blocks a player. It excludes them from chat leaderboards and
 * nothing more: false positives on genuinely strong players are certain, and
 * an auto-ban turns a statistical guess into a product failure.
 */
export const cheatFlags = pgTable(
  'cheat_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: telegramUserId('user_id').notNull(),
    game: text('game').notNull().default('pong'),
    /** Median reaction latency, ms, after a ball direction change. */
    reactionMedianMs: real('reaction_median_ms'),
    /** Standard deviation of that latency. Near-zero is the tell. */
    reactionStddevMs: real('reaction_stddev_ms'),
    /** RMS tracking error between paddle X and ball X. */
    trackingRmse: real('tracking_rmse'),
    overshootRate: real('overshoot_rate'),
    idleFraction: real('idle_fraction'),
    matchesAnalysed: integer('matches_analysed').notNull().default(0),
    /** Free-text reason from the job, for a human reading the flag later. */
    reason: text('reason'),
    /** While true, this user is omitted from chat leaderboards. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('cheat_flags_user_idx').on(table.userId, table.game, table.active)],
);

/**
 * A rendered result card, keyed by match.
 *
 * The PNG is uploaded through the bot exactly once; afterwards only Telegram's
 * `file_id` is reused, so a card shared fifty times costs one render and one
 * upload.
 */
export const resultCards = pgTable('result_cards', {
  matchId: uuid('match_id')
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  fileId: text('file_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The funnel. Without these rows the project is unfalsifiable, so the table is
 * append-only and written for every step from launch to rematch.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    userId: telegramUserId('user_id'),
    chatInstance: text('chat_instance'),
    game: text('game'),
    roomId: text('room_id'),
    matchId: uuid('match_id'),
    props: jsonb('props'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('events_name_time_idx').on(table.name, table.createdAt),
    index('events_user_idx').on(table.userId, table.createdAt),
  ],
);

/**
 * Room-creation rate limiting, per user per hour.
 *
 * Kept in Postgres rather than Redis: the spec's own instruction is that Redis
 * at this size only adds latency, and this counter is touched once per room
 * creation, not once per tick.
 */
export const roomCreationCounters = pgTable(
  'room_creation_counters',
  {
    userId: telegramUserId('user_id').notNull(),
    /** Start of the hour bucket. */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.windowStart] })],
);

export const usersRelations = relations(users, ({ one }) => ({
  referrer: one(users, {
    fields: [users.referrerUserId],
    references: [users.id],
    relationName: 'referrer',
  }),
}));

export const matchesRelations = relations(matches, ({ one }) => ({
  playerA: one(users, { fields: [matches.playerAId], references: [users.id], relationName: 'a' }),
  playerB: one(users, { fields: [matches.playerBId], references: [users.id], relationName: 'b' }),
  trace: one(matchTraces, { fields: [matches.id], references: [matchTraces.matchId] }),
  card: one(resultCards, { fields: [matches.id], references: [resultCards.matchId] }),
}));

/** Ordered pair helper — head-to-head rows are stored low-id first. */
export function orderPair(a: number, b: number): { low: number; high: number } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

export const NOW = sql`now()`;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type HeadToHead = typeof headToHead.$inferSelect;
export type ChatLeaderboardRow = typeof chatLeaderboard.$inferSelect;
export type PlayerStats = typeof playerStats.$inferSelect;
