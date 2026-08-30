/**
 * User records and referral attribution.
 */

import { eq, lt, sql } from 'drizzle-orm';

import { config } from './config.js';
import { db, tryWrite } from './db/client.js';
import { chats, roomCreationCounters, users } from './db/schema.js';
import type { TelegramSession } from './telegram/initData.js';

/**
 * Upsert the user seen in this launch, and attribute a referrer if this is
 * their first ever launch.
 *
 * `referrer_user_id` is **write-once**. `onConflictDoUpdate` refreshes the
 * profile fields but never touches it: attribution that can be rewritten is
 * attribution that will be farmed, and a user's first referrer is the only one
 * that means anything.
 */
export async function recordLaunch(
  session: TelegramSession,
  referrerUserId: number | null,
): Promise<void> {
  const now = new Date();

  await tryWrite('recordLaunch', () =>
    db
      .insert(users)
      .values({
        id: session.user.id,
        username: session.user.username ?? null,
        firstName: session.user.firstName,
        lastName: session.user.lastName ?? null,
        photoUrl: session.user.photoUrl ?? null,
        languageCode: session.user.languageCode ?? null,
        isPremium: session.user.isPremium,
        // Never attribute a user to themselves, however the link was built.
        referrerUserId:
          referrerUserId && referrerUserId !== session.user.id ? referrerUserId : null,
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          username: session.user.username ?? null,
          firstName: session.user.firstName,
          lastName: session.user.lastName ?? null,
          photoUrl: session.user.photoUrl ?? null,
          languageCode: session.user.languageCode ?? null,
          isPremium: session.user.isPremium,
          lastSeenAt: now,
          // referrerUserId intentionally absent — see the doc comment.
        },
      }),
  );

  if (session.chatInstance) {
    await tryWrite('recordChat', () =>
      db
        .insert(chats)
        .values({ chatInstance: session.chatInstance!, chatType: session.chatType })
        .onConflictDoUpdate({
          target: chats.chatInstance,
          set: { chatType: session.chatType },
        }),
    );
  }
}

/** Persist an explicit in-app language choice. Wins over `language_code`. */
export async function setLanguageOverride(userId: number, language: string | null): Promise<void> {
  await tryWrite('setLanguageOverride', () =>
    db.update(users).set({ languageOverride: language }).where(eq(users.id, userId)),
  );
}

/**
 * Rate-limit room creation, per user per hour.
 *
 * Kept in Postgres rather than Redis: this counter is touched once per room
 * creation, not once per tick, and Redis at this size would add a network hop
 * to every one of them for no benefit.
 *
 * Returns `true` if the user may create a room.
 */
export async function consumeRoomCreationBudget(userId: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);

  const rows = await tryWrite('consumeRoomCreationBudget', () =>
    db
      .insert(roomCreationCounters)
      .values({ userId, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [roomCreationCounters.userId, roomCreationCounters.windowStart],
        set: { count: sql`${roomCreationCounters.count} + 1` },
      })
      .returning({ count: roomCreationCounters.count }),
  );

  // A failed counter write must not lock a user out of the product; the cap is
  // an abuse control, not a correctness invariant.
  if (!rows) return true;
  const count = rows[0]?.count ?? 1;
  return count <= config.ROOM_CREATE_LIMIT_PER_HOUR;
}

/** Drop counter rows older than the current window. Called by the reaper. */
export async function pruneRoomCreationCounters(): Promise<void> {
  const cutoff = new Date(Date.now() - 3 * 3_600_000);
  await tryWrite('pruneRoomCreationCounters', () =>
    // `lt` rather than a raw `sql` fragment: only the column-aware operators
    // run the column's driver encoder, and the driver rejects a bare `Date`.
    db
      .delete(roomCreationCounters)
      .where(lt(roomCreationCounters.windowStart, cutoff)),
  );
}
