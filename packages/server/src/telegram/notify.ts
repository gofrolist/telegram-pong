/**
 * Outbound nudges.
 *
 * The empty-room problem is the single biggest silent killer of an invite-only
 * game: with no AI opponent, a link dropped in a chat is often tapped an hour
 * later, by which time the inviter has closed the app and will never know
 * anyone showed up. Rooms therefore persist, and *this* is what closes the
 * loop — the moment someone takes the open slot, the inviter gets a message.
 *
 * Everything here is best-effort. A blocked bot, a user who never started a
 * private chat, a Telegram hiccup: none of them may break a live match, so no
 * function in this file throws.
 */

import { eq } from 'drizzle-orm';

import { bot } from './bot.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { t } from '../i18n/strings.js';
import { encodeInvite } from '@pong/game-core';

function miniAppUrl(startParam: string): string {
  return `https://t.me/${config.TELEGRAM_BOT_USERNAME}/${config.TELEGRAM_APP_NAME}?startapp=${startParam}`;
}

/**
 * Tell the host that their opponent has arrived.
 *
 * Called off the game loop, un-awaited by the room.
 */
export async function notifyOpponentWaiting(
  hostUserId: number,
  roomCode: string,
  guestUserId: number,
): Promise<void> {
  try {
    const [host] = await db
      .select({ language: users.languageOverride, code: users.languageCode })
      .from(users)
      .where(eq(users.id, hostUserId))
      .limit(1);

    const [guest] = await db
      .select({ firstName: users.firstName, username: users.username })
      .from(users)
      .where(eq(users.id, guestUserId))
      .limit(1);

    const strings = t(host?.language ?? host?.code);
    const guestName = guest?.firstName || (guest?.username ? `@${guest.username}` : 'Someone');
    const startParam = encodeInvite({ game: 'pong', room: roomCode });

    await bot.api.sendMessage(hostUserId, strings.opponentWaiting(guestName), {
      reply_markup: {
        inline_keyboard: [[{ text: strings.opponentWaitingButton, url: miniAppUrl(startParam) }]],
      },
    });
  } catch (error) {
    // 403 here just means the user never opened a private chat with the bot,
    // which is entirely normal for someone who arrived through a group link.
    console.warn('[notify] opponent-waiting message not delivered:', error);
  }
}

/**
 * Tell the GUEST that the host has come back.
 *
 * The missing half of the handshake, and the reason invites deadlocked.
 *
 * Before this, `notifyOpponentWaiting` was the only message the platform ever
 * sent, so the traffic was one-way: the host got called back and the guest
 * never did. The guest taps a link, lands on a waiting screen with nobody in
 * it, and closes the app within seconds — reasonably, since nothing on that
 * screen suggests waiting will be rewarded. By the time the host reads their
 * notification and returns, minutes later, the seat opposite is empty again.
 * Both sides were waiting for each other on timescales that could not meet.
 *
 * This deployment's own telemetry has it twice. Room `SHDR9TWQ`: the guest
 * joined and disconnected in the SAME SECOND, and the host arrived 43 minutes
 * later to an empty table. Room `PK29NHH8`: the host was quick enough that the
 * match started against the already-departed guest and was written as a 0-0
 * disconnect 31 seconds later.
 *
 * Best-effort like everything else here, and sent at most once per room — the
 * host may bounce in and out of a waiting screen several times and that must
 * not become several messages.
 */
export async function notifyHostReturned(
  guestUserId: number,
  roomCode: string,
  hostUserId: number,
): Promise<void> {
  try {
    const [guest] = await db
      .select({ language: users.languageOverride, code: users.languageCode })
      .from(users)
      .where(eq(users.id, guestUserId))
      .limit(1);

    const [host] = await db
      .select({ firstName: users.firstName, username: users.username })
      .from(users)
      .where(eq(users.id, hostUserId))
      .limit(1);

    const strings = t(guest?.language ?? guest?.code);
    const hostName = host?.firstName || (host?.username ? `@${host.username}` : 'Someone');
    const startParam = encodeInvite({ game: 'pong', room: roomCode });

    await bot.api.sendMessage(guestUserId, strings.hostReturned(hostName), {
      reply_markup: {
        inline_keyboard: [[{ text: strings.hostReturnedButton, url: miniAppUrl(startParam) }]],
      },
    });
  } catch (error) {
    console.warn('[notify] host-returned message not delivered:', error);
  }
}
