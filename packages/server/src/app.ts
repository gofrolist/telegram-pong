/**
 * Server composition.
 *
 * Separated from `index.ts` so that the whole application — rooms, HTTP API,
 * transport — can be started on an ephemeral port by an integration test
 * without also registering a Telegram webhook or installing signal handlers.
 */

import { defineRoom, defineServer } from 'colyseus';
import { uWebSocketsTransport } from '@colyseus/uwebsockets-transport';

import { config, isDevelopment } from './config.js';
import { startAnalyticsFlusher } from './analytics.js';
import { warmUpInBackground } from './db/client.js';
import { mountApi } from './http/api.js';
import { reapExpiredRooms } from './http/rooms.js';
import { pruneRoomCreationCounters } from './users.js';
import { PongRoom } from './rooms/PongRoom.js';
import { registerWebhook } from './telegram/bot.js';

export interface AppOptions {
  /**
   * Register the Telegram webhook on boot. Off in tests, which have no real
   * bot token and must not call the Bot API.
   */
  registerTelegramWebhook: boolean;
  /** Start the periodic room reaper and analytics flusher. */
  startBackgroundJobs: boolean;
}

export function createApp(options: AppOptions) {
  return defineServer({
    /**
     * The game registry.
     *
     * This map *is* the registry — adding a second game is adding a key here
     * and a Room class, and nothing else. There is deliberately no parallel
     * registry elsewhere that could drift out of sync with it.
     */
    rooms: {
      pong: defineRoom(PongRoom),
    },

    transport: new uWebSocketsTransport({
      // State patches are small and frequent; a large receive buffer buys
      // nothing and costs memory per connection.
      maxPayloadLength: 64 * 1024,
      idleTimeout: 60,
    }),

    express: (app) => {
      // fly terminates TLS in front of us, so the client IP and protocol
      // arrive in forwarding headers. Without this, rate limiting sees one IP.
      app.set('trust proxy', true);
      app.disable('x-powered-by');
      mountApi(app);
    },

    beforeListen: () => {
      if (options.startBackgroundJobs) {
        startAnalyticsFlusher();

        // Neon scales to zero. Warming the pool *after* the server is up turns
        // the first user's cold-start penalty into a startup one, without ever
        // being able to delay the health check.
        warmUpInBackground();

        // The database's half of the room TTL. Colyseus disposes an unfilled
        // room on its own timer; this closes the row.
        const reaper = setInterval(
          () => {
            void reapExpiredRooms();
            void pruneRoomCreationCounters();
          },
          5 * 60 * 1000,
        );
        reaper.unref?.();
      }

      if (options.registerTelegramWebhook) {
        // Webhook-only, always. A poller and a webhook cannot both hold the
        // same token, and the failure mode is updates vanishing silently.
        void registerWebhook().catch((error: unknown) => {
          console.error('[boot] webhook registration failed:', error);
        });
      }

      if (isDevelopment && config.SIMULATED_LATENCY_MS > 0) {
        console.log(`[boot] simulating ${config.SIMULATED_LATENCY_MS}ms latency`);
      }
    },
  });
}
