/**
 * Environment configuration.
 *
 * Parsed once, at import time, and loudly: a missing bot token should stop the
 * process on boot rather than surface as a failed `initData` check an hour
 * later. The one exception is `DATABASE_URL`, which is validated but never
 * *connected to* during startup — see `db/client.ts`.
 */

import { z } from 'zod';

/**
 * Parse an environment flag.
 *
 * Opt-out by an explicit falsey word, case-insensitively. A `!== 'false'` test
 * treats `False`, `FALSE`, `no`, `off` and `''` as **true**, which for
 * `TELEGRAM_REGISTER_WEBHOOK` means a laptop quietly stealing the production
 * bot's updates because someone capitalised the value.
 */
function parseBoolean(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return !['false', '0', 'no', 'off', ''].includes(normalised);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(2567),
  HOST: z.string().default('0.0.0.0'),

  /** From BotFather. Used to validate `initData` and to call the Bot API. */
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  /** Bot username without `@`, e.g. `pongduel_bot`. */
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  /** The Mini App short name registered with BotFather, e.g. `pong`. */
  TELEGRAM_APP_NAME: z.string().min(1).default('pong'),
  /**
   * Secret shared with Telegram on `setWebhook`; every webhook request must
   * echo it in `X-Telegram-Bot-Api-Secret-Token`. Without it the webhook
   * endpoint is an unauthenticated command channel.
   */
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  /** Public origin of THIS server, used to register the webhook. */
  PUBLIC_SERVER_URL: z.string().url(),
  /**
   * Whether to point Telegram's webhook at this deployment on boot.
   *
   * Defaults on, because a deployed server that does not receive updates is a
   * dead bot. Set `false` for local runs: `setWebhook` is global per bot
   * token, so a laptop that registers itself silently steals every update
   * from the real deployment until someone notices.
   */
  TELEGRAM_REGISTER_WEBHOOK: z.string().default('true').transform(parseBoolean),
  /**
   * Public origin of the Mini App.
   *
   * Optional, and normally unset: the Mini App is served by THIS server, from
   * the same origin, so the default below is the correct answer. It stays
   * overridable for the one case where it is not — a client running on Vite's
   * dev server, or a future move back to separate hosting — because that case
   * is exactly when the CORS allowlist has to know a second origin.
   */
  PUBLIC_CLIENT_URL: z.string().url().optional(),

  /** Neon pooled (pgbouncer) connection string. */
  DATABASE_URL: z.string().min(1),

  /**
   * Signing key for our own short-lived session tokens. Distinct from the bot
   * token: a stolen `initData` stays valid for a day, so it is exchanged once
   * for a token measured in minutes.
   */
  SESSION_SECRET: z.string().min(32),
  /** Lifetime of an issued session token, in seconds. */
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),
  /** Reject `initData` older than this. Telegram's own guidance is ~1 day; we
   * are far stricter because the Mini App refreshes it on every launch. */
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(900),

  /** fly.io machine id. Becomes the room-id prefix for future `fly-replay`. */
  FLY_MACHINE_ID: z.string().default('local'),
  FLY_REGION: z.string().default('dev'),

  /**
   * Per-chat leaderboards depend on `chat_instance` behaving as documented,
   * which must be verified against two real accounts in two real chats before
   * it is trusted. See `docs/CHAT-INSTANCE-VERIFICATION.md`.
   */
  CHAT_LEADERBOARDS_ENABLED: z.string().default('true').transform(parseBoolean),

  /** Rooms a single user may create per hour. */
  ROOM_CREATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),

  /**
   * Artificial latency injected into the transport, in ms. Development only —
   * this is how Stage 5 is tested without a real bad network.
   */
  SIMULATED_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),
}).transform((env) => ({
  ...env,
  // Same origin unless told otherwise. Resolved here rather than at each use
  // site so that `config.PUBLIC_CLIENT_URL` is a `string` everywhere, and so
  // there is one place that decides what "the client's origin" means.
  PUBLIC_CLIENT_URL: env.PUBLIC_CLIENT_URL ?? env.PUBLIC_SERVER_URL,
}));

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
