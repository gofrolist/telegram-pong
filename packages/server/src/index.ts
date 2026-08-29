/**
 * Server entry point.
 *
 * One process holds the Colyseus game server, the HTTP API and the Telegram
 * bot's webhook. That is the whole deployment: a single fly.io machine with
 * `min_machines_running = 1` and auto-stop disabled. Pong load is negligible
 * and one machine holds hundreds of concurrent rooms; a second machine would
 * add a routing problem before it added capacity.
 */

import { listen, matchMaker } from 'colyseus';

import { createApp } from './app.js';
import { config } from './config.js';
import { stopAnalyticsFlusher } from './analytics.js';
import { closeDb } from './db/client.js';

const server = createApp({
  registerTelegramWebhook: config.TELEGRAM_REGISTER_WEBHOOK,
  startBackgroundJobs: true,
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[boot] ${signal} received, draining`);
  try {
    // Lets in-flight matches finish their current tick and tells clients to
    // reconnect, rather than dropping every socket at once.
    await matchMaker.gracefullyShutdown();
  } catch (error) {
    console.error('[boot] matchmaker shutdown error:', error);
  }
  await stopAnalyticsFlusher();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

listen(server, config.PORT);
