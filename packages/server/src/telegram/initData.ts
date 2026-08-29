/**
 * `initData` validation and session-token issuance.
 *
 * The threat this closes: `initData` is signed with the bot token and stays
 * valid for as long as its `auth_date` allows — Telegram's own default is a
 * day. Anything that captures it once (a shared screenshot of a debug page, a
 * proxy on a hostile network) can replay it for that whole window. So it is
 * accepted at one front door only — `POST /api/auth` — and immediately
 * exchanged for our own token measured in minutes.
 *
 * NOT single-use. The same `initData` can be presented again inside its
 * `INIT_DATA_MAX_AGE_SEC` window and will mint another session token; making
 * it single-use needs a persisted nonce set, which is a schema change rather
 * than a code change. What the short window buys is a bound on that exposure:
 * 15 minutes to replay, against Telegram's own 24-hour default. See
 * `docs/ASSUMPTIONS.md` under "Known gaps".
 *
 * Everything downstream — the room's `onAuth`, every HTTP route — trusts only
 * our token. `initData` never travels past this module.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  isAuthDateInvalidError,
  isExpiredError,
  isSignatureInvalidError,
  isSignatureMissingError,
  parse,
  validate,
} from '@telegram-apps/init-data-node';

import { config } from '../config.js';

export interface SessionUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  /** Signed by Telegram, therefore trustworthy for localisation. */
  languageCode?: string;
  isPremium: boolean;
}

export interface TelegramSession {
  user: SessionUser;
  /**
   * Opaque per-chat identity. Present only for Mini Apps opened by a direct
   * link; a launch from the bot menu or `/start` has none, and the UI must
   * fall back to profile and head-to-head rather than showing an empty chat
   * leaderboard.
   */
  chatInstance: string | null;
  /** `sender` | `private` | `group` | `supergroup` | `channel`. */
  chatType: string | null;
  /** The `startapp` payload, still encoded. */
  startParam: string | null;
  authDate: number;
}

/**
 * The subset of parsed `initData` this server relies on.
 *
 * `parse` returns Telegram's wire field names verbatim — snake_case, with
 * `auth_date` already widened to a `Date`. Declaring the shape here rather
 * than trusting the library's loosely-indexed return type means a future
 * change to either would surface as a compile error, not as `undefined`
 * quietly becoming a null chat context.
 */
interface ParsedInitData {
  user?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    photo_url?: string;
    language_code?: string;
    is_premium?: boolean;
  };
  chat_instance?: string;
  chat_type?: string;
  start_param?: string;
  auth_date: Date;
}

export class InitDataError extends Error {
  constructor(
    message: string,
    readonly reason: 'signature' | 'expired' | 'malformed',
  ) {
    super(message);
    this.name = 'InitDataError';
  }
}

/**
 * Validate raw `initData` and extract the session.
 *
 * `expiresIn` is deliberately far below Telegram's one-day default: the Mini
 * App produces fresh `initData` on every launch, so a short window costs
 * honest users nothing and shrinks the replay window by two orders of
 * magnitude.
 */
export function verifyInitData(raw: string): TelegramSession {
  if (!raw || typeof raw !== 'string') {
    throw new InitDataError('initData missing', 'malformed');
  }

  try {
    validate(raw, config.TELEGRAM_BOT_TOKEN, {
      expiresIn: config.INIT_DATA_MAX_AGE_SEC,
    });
  } catch (error) {
    if (isExpiredError(error)) {
      throw new InitDataError('initData expired', 'expired');
    }
    if (isSignatureInvalidError(error) || isSignatureMissingError(error)) {
      throw new InitDataError('initData signature invalid', 'signature');
    }
    if (isAuthDateInvalidError(error)) {
      throw new InitDataError('initData auth_date invalid', 'malformed');
    }
    throw new InitDataError('initData rejected', 'malformed');
  }

  // The library's declared return type carries an open index signature, which
  // widens every field to `unknown` at the use site. `ParsedInitData` above
  // pins down exactly what we read, and every field is guarded below.
  const parsed = parse(raw) as unknown as ParsedInitData;
  const user = parsed.user;
  if (!user || typeof user.id !== 'number') {
    // A Mini App opened without a user (an attachment-menu edge case) has
    // nobody to attribute a match to, so it cannot play.
    throw new InitDataError('initData carries no user', 'malformed');
  }

  return {
    user: {
      id: user.id,
      firstName: user.first_name ?? '',
      lastName: user.last_name,
      username: user.username,
      photoUrl: user.photo_url,
      languageCode: user.language_code,
      isPremium: Boolean(user.is_premium),
    },
    chatInstance: parsed.chat_instance ?? null,
    chatType: parsed.chat_type ?? null,
    startParam: parsed.start_param ?? null,
    authDate: Math.floor(parsed.auth_date.getTime() / 1000),
  };
}

/**
 * Our own session token.
 *
 * Hand-rolled rather than pulled from a JWT library on purpose: the payload is
 * ours, the audience is ours, and the only algorithm we ever want is
 * HMAC-SHA256. A compact `base64url(payload).base64url(mac)` has no algorithm
 * field, and therefore no `alg: none` class of bug.
 */
export interface SessionToken {
  /** Telegram user id. */
  uid: number;
  /** Opaque chat identity at issue time, if any. */
  ci: string | null;
  ct: string | null;
  /** Issued-at and expiry, in seconds. */
  iat: number;
  exp: number;
  /** Display fields, carried so rooms need no database read to seat a player. */
  n: string;
  u?: string;
  p?: string;
  l?: string;
  /** Telegram Premium, used only to pick an avatar ring on the result card. */
  pr: boolean;
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', config.SESSION_SECRET).update(payload).digest());
}

export function issueSessionToken(session: TelegramSession): string {
  const now = Math.floor(Date.now() / 1000);
  const token: SessionToken = {
    uid: session.user.id,
    ci: session.chatInstance,
    ct: session.chatType,
    iat: now,
    exp: now + config.SESSION_TTL_SEC,
    n: session.user.firstName,
    u: session.user.username,
    p: session.user.photoUrl,
    l: session.user.languageCode,
    pr: session.user.isPremium,
  };
  const payload = b64url(Buffer.from(JSON.stringify(token), 'utf8'));
  return `${payload}.${sign(payload)}`;
}

/** Verify a session token. Returns `null` for anything not exactly valid. */
export function verifySessionToken(token: string | null | undefined): SessionToken | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);

  // Constant-time compare: a naive `===` leaks the MAC one byte at a time to
  // anyone willing to measure.
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }

  let decoded: SessionToken;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionToken;
  } catch {
    return null;
  }

  if (typeof decoded.uid !== 'number' || !Number.isSafeInteger(decoded.uid)) return null;
  if (typeof decoded.exp !== 'number' || decoded.exp * 1000 <= Date.now()) return null;

  return decoded;
}
