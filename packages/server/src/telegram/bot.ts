/**
 * The Telegram bot — webhook mode only.
 *
 * Long polling is never started, not even in development. A poller and a
 * webhook cannot coexist against the same token, and the failure mode (updates
 * silently vanishing into whichever process asked last) is expensive to debug.
 * Local development points the webhook at a tunnel instead; see the README.
 */

import { Bot, webhookCallback, type Context } from 'grammy';

import { config } from '../config.js';
import { t } from '../i18n/strings.js';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

/**
 * The Mini App's canonical entry point.
 *
 * `ctx.match` for `/start` is whatever the user typed after the command, not a
 * deep-link payload, so it has to be treated as free text. An unencoded space
 * (`/start hello world`) makes the Bot API reject the whole inline keyboard
 * with `BUTTON_URL_INVALID`, and the user gets no reply at all to the single
 * most important message the bot handles.
 */
function miniAppUrl(startParam?: string): string {
  const base = `https://t.me/${config.TELEGRAM_BOT_USERNAME}/${config.TELEGRAM_APP_NAME}`;
  const trimmed = startParam?.trim();
  if (!trimmed) return base;
  return `${base}?startapp=${encodeURIComponent(trimmed)}`;
}

bot.command('start', async (ctx: Context) => {
  const strings = t(ctx.from?.language_code);
  await ctx.reply(strings.start, {
    reply_markup: {
      inline_keyboard: [[{ text: strings.startPlay, url: miniAppUrl(ctx.match as string | undefined) }]],
    },
  });
});

bot.command('help', async (ctx: Context) => {
  await ctx.reply(t(ctx.from?.language_code).help);
});

bot.on('message:text', async (ctx: Context) => {
  const strings = t(ctx.from?.language_code);
  await ctx.reply(strings.unknownCommand, {
    reply_markup: { inline_keyboard: [[{ text: strings.playButton, url: miniAppUrl() }]] },
  });
});

bot.catch((error) => {
  // A failing handler must not 500 the webhook: Telegram retries on a non-2xx
  // and a persistent error becomes a retry storm against our one machine.
  console.error('[bot] handler error:', error.error);
});

/**
 * Express middleware for `POST /telegram/webhook`.
 *
 * `secretToken` makes grammY reject any request that does not carry the
 * matching `X-Telegram-Bot-Api-Secret-Token` header. Without it the endpoint
 * is an unauthenticated way to make the bot do things.
 */
export const webhookHandler = webhookCallback(bot, 'express', {
  secretToken: config.TELEGRAM_WEBHOOK_SECRET,
});

/** Point Telegram at this deployment. Called once, after the server listens. */
export async function registerWebhook(): Promise<void> {
  const url = `${config.PUBLIC_SERVER_URL.replace(/\/$/, '')}/telegram/webhook`;
  await bot.api.setWebhook(url, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query', 'inline_query'],
  });
  // `bot.init()` populates `bot.botInfo`, which grammY needs before it can
  // dispatch an update; in webhook mode nothing else calls it.
  await bot.init();
  console.log(`[bot] webhook registered at ${url}`);
}
