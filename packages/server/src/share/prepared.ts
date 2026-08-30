/**
 * Sharing, via Bot API 8.0 prepared inline messages.
 *
 * The flow: the backend calls `savePreparedInlineMessage` with the rendered
 * photo and a Rematch button; the frontend calls `shareMessage(id)`, and the
 * user gets Telegram's own native chat picker. `switchInlineQuery` is
 * deliberately not used — it is the older flow, it drops the user into a
 * compose box rather than a picker, and it loses the photo.
 *
 * The prepared message id is **single-use**. A fresh one is prepared on every
 * share tap; caching it would give the user a picker that silently fails the
 * second time.
 *
 * The *photo* is cached, though, and aggressively: rendering and uploading
 * happen once per match, and every subsequent share reuses Telegram's
 * `file_id`.
 */

import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';

import { bot } from '../telegram/bot.js';
import { config } from '../config.js';
import { db, tryWrite } from '../db/client.js';
import { resultCards } from '../db/schema.js';
import { renderResultCard, type CardInput } from './card.js';
import { encodeInvite } from '@pong/game-core';
import { t } from '../i18n/strings.js';

/**
 * Where the card is uploaded so Telegram hands back a `file_id`.
 *
 * Sending the photo to the *sharing user's* own private chat would spam them.
 * Instead the upload targets the user themselves only if no cache exists, and
 * the message is deleted immediately afterwards — Telegram keeps the `file_id`
 * valid regardless.
 */
async function uploadAndCache(matchId: string, userId: number, png: Buffer): Promise<string | null> {
  try {
    const message = await bot.api.sendPhoto(userId, new InputFile(png, `pong-${matchId}.png`), {
      disable_notification: true,
    });
    const photo = message.photo?.at(-1);
    if (!photo) return null;

    // Tidy up: the user asked to share a card, not to receive one.
    void bot.api.deleteMessage(userId, message.message_id).catch(() => {});

    await tryWrite('cache result card', () =>
      db.insert(resultCards).values({ matchId, fileId: photo.file_id }).onConflictDoNothing(),
    );
    return photo.file_id;
  } catch (error) {
    console.error('[share] card upload failed:', error);
    return null;
  }
}

/** Render-and-upload, or reuse the cached `file_id` for this match. */
export async function ensureCardFileId(
  matchId: string,
  userId: number,
  card: CardInput,
): Promise<string | null> {
  const [cached] = await db
    .select({ fileId: resultCards.fileId })
    .from(resultCards)
    .where(eq(resultCards.matchId, matchId))
    .limit(1);
  if (cached?.fileId) return cached.fileId;

  const png = await renderResultCard(card);
  return uploadAndCache(matchId, userId, png);
}

export interface PrepareInviteInput {
  /** The user who tapped invite — a prepared message is bound to one user. */
  userId: number;
  /** Their display name, which the invite message names as the challenger. */
  userName: string;
  languageCode: string | null | undefined;
  /** The room the invite opens. */
  startParam: string;
}

/**
 * Prepare a single-use invite for Telegram's own chat picker.
 *
 * This is what makes "invite a friend" a picker rather than a clipboard. The
 * Mini App calls `shareMessage(id)` with what this returns and Telegram shows
 * its native chat list *over* the app — the game keeps running underneath,
 * the room stays open, and nothing has to be pasted anywhere.
 *
 * An `article`, not a `photo`: unlike the result card there is nothing to
 * render, and a text result costs no upload and no round trip to the Bot API
 * to cache a `file_id`.
 *
 * Returns `null` rather than throwing — a failed invite should fall back to
 * the link on screen, not replace the waiting room with an error.
 */
export async function prepareInvite(input: PrepareInviteInput): Promise<PreparedShare | null> {
  const strings = t(input.languageCode);
  const url = `https://t.me/${config.TELEGRAM_BOT_USERNAME}/${config.TELEGRAM_APP_NAME}?startapp=${input.startParam}`;

  try {
    const prepared = await bot.api.savePreparedInlineMessage(
      input.userId,
      {
        type: 'article',
        // Single-use and scoped to this user, so the room code is identity
        // enough; it also keeps the id stable for one room's retries.
        id: input.startParam.slice(0, 64),
        title: strings.inviteTitle,
        description: strings.inviteText(input.userName),
        input_message_content: {
          message_text: strings.inviteText(input.userName),
        },
        reply_markup: {
          inline_keyboard: [[{ text: strings.inviteButton, url }]],
        },
      },
      {
        // Anywhere an opponent might be. Bot chats are excluded for the same
        // reason as the result card: the other side would never tap it.
        allow_user_chats: true,
        allow_bot_chats: false,
        allow_group_chats: true,
        allow_channel_chats: true,
      },
    );

    return { id: prepared.id, expirationDate: prepared.expiration_date };
  } catch (error) {
    console.error('[share] savePreparedInlineMessage failed for invite:', error);
    return null;
  }
}

export interface PrepareShareInput {
  matchId: string;
  /** The user who tapped share — prepared messages are bound to one user. */
  userId: number;
  languageCode: string | null | undefined;
  card: CardInput;
  /** Room code for the rematch this card's button opens. */
  rematchRoomCode: string;
}

export interface PreparedShare {
  id: string;
  expirationDate: number;
}

/**
 * Prepare a single-use shareable message for one user.
 *
 * Returns `null` rather than throwing: a failed share should show the user a
 * retry, not an error screen.
 */
export async function prepareShare(input: PrepareShareInput): Promise<PreparedShare | null> {
  // `ensureCardFileId` does an unwrapped `db.select` and renders an SVG, both
  // of which can reject. Outside a `try` they escape this function, breaking
  // the contract above: the caller's catch-all turns a retryable 502 into a
  // generic 500 and the `share_message_failed` funnel event never fires.
  let fileId: string | null;
  try {
    fileId = await ensureCardFileId(input.matchId, input.userId, input.card);
  } catch (error) {
    console.error('[share] card render failed:', error);
    return null;
  }
  if (!fileId) return null;

  const strings = t(input.languageCode);
  const startParam = encodeInvite({
    game: 'pong',
    room: input.rematchRoomCode,
    ref: input.userId,
  });
  const rematchUrl = `https://t.me/${config.TELEGRAM_BOT_USERNAME}/${config.TELEGRAM_APP_NAME}?startapp=${startParam}`;

  try {
    const prepared = await bot.api.savePreparedInlineMessage(
      input.userId,
      {
        type: 'photo',
        id: input.matchId.slice(0, 64),
        photo_file_id: fileId,
        caption: strings.cardCaption(
          input.card.bottom.isWinner ? input.card.bottom.name : input.card.top.name,
          input.card.bottom.isWinner ? input.card.top.name : input.card.bottom.name,
          Math.max(input.card.bottom.score, input.card.top.score),
          Math.min(input.card.bottom.score, input.card.top.score),
        ),
        reply_markup: {
          inline_keyboard: [[{ text: strings.rematchButton, url: rematchUrl }]],
        },
      },
      {
        // Let the card go anywhere a Pong invite makes sense. Channels are
        // included: a card posted to a channel is an invite to every reader.
        allow_user_chats: true,
        allow_bot_chats: false,
        allow_group_chats: true,
        allow_channel_chats: true,
      },
    );

    return { id: prepared.id, expirationDate: prepared.expiration_date };
  } catch (error) {
    console.error('[share] savePreparedInlineMessage failed:', error);
    return null;
  }
}
