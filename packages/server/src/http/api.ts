/**
 * The HTTP API.
 *
 * Everything a Mini App needs that is not the realtime socket: the one-time
 * `initData` exchange, room creation and invite resolution, stats reads, and
 * share preparation.
 *
 * CORS is explicit and narrow, and in production it is also mostly moot: the
 * Mini App is served from this same origin (see `staticClient.ts`), so the
 * browser sends no `Origin` on these calls at all. The allowlist earns its
 * keep in development, where the client runs on Vite's dev server, and as the
 * thing that stops a permissive `*` from making the session token readable by
 * any page that can convince a user to visit it.
 */

import type { Application, NextFunction, Request, Response } from 'express';
import express from 'express';
import { matchMaker } from 'colyseus';

import { config, isDevelopment } from '../config.js';
import { recordEvent } from '../analytics.js';
import { decodeInvite, encodeInvite, MatchOrigin } from '@pong/game-core';
import {
  InitDataError,
  issueSessionToken,
  verifyInitData,
  verifySessionToken,
  type SessionToken,
} from '../telegram/initData.js';
import { consumeRoomCreationBudget, recordLaunch, setLanguageOverride } from '../users.js';
import { closeRoom, createRoom, resolveRoom, UnknownGameError } from './rooms.js';
import {
  getChatLeaderboard,
  getHeadToHead,
  getMatch,
  getProfileStats,
  listHeadToHead,
} from './stats.js';
import { prepareInvite, prepareShare } from '../share/prepared.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { webhookHandler } from '../telegram/bot.js';
import { mountClient } from './staticClient.js';

/** Requests carrying a verified session. */
interface AuthedRequest extends Request {
  session?: SessionToken;
}

const ALLOWED_ORIGINS = new Set(
  [
    config.PUBLIC_CLIENT_URL,
    // Vite's dev server, so the Mini App can be developed against a real
    // server without disabling CORS wholesale.
    isDevelopment ? 'http://localhost:5173' : null,
    isDevelopment ? 'https://localhost:5173' : null,
  ].filter((value): value is string => Boolean(value)),
);

/**
 * Narrow the CORS headers Colyseus applies to *every* response.
 *
 * This is not an `/api` concern and cannot be solved by middleware. Colyseus
 * `prependListener`s its own handler onto the HTTP server, so its headers are
 * written — and every `OPTIONS` is answered with 204 — before express runs at
 * all. Its defaults are `Access-Control-Allow-Origin` reflected from whatever
 * `Origin` the caller sent, plus `Access-Control-Allow-Credentials: true`,
 * which makes every route on this host readable by any page on the internet
 * and silently undoes the allowlist below.
 *
 * The same headers govern the `/matchmake` handshake, so this narrows them
 * rather than removing them.
 */
function narrowTransportCors(): void {
  matchMaker.controller.DEFAULT_CORS_HEADERS = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    // Nothing here authenticates with a cookie: the session arrives as a
    // bearer token the Mini App holds in memory.
    'Access-Control-Allow-Credentials': 'false',
    // The fallback for an origin that is not on the allowlist. It has to be
    // *some* origin — the key is not optional — so it is one we already trust,
    // which by construction can never be the caller's own.
    'Access-Control-Allow-Origin': config.PUBLIC_CLIENT_URL,
    'Access-Control-Max-Age': '600',
  };

  matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
    const origin = headers.get('origin');
    // `Vary` unconditionally, including on the miss: the response genuinely
    // differs by origin, and a cache that learned otherwise would hand one
    // origin's allowance to another.
    return origin && ALLOWED_ORIGINS.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' };
  };
}

/**
 * The `/api` half of the same policy.
 *
 * `narrowTransportCors` has already written correct headers by the time this
 * runs; this re-states them for the API routes specifically, so the policy
 * survives a future change of transport. The `OPTIONS` branch is unreachable
 * in production for the same reason — Colyseus answers preflights first.
 */
function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * Telegram's webview caches aggressively enough that a deploy can be invisible
 * for hours. API responses are never cacheable.
 */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  next();
}

function requireSession(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.session = session;
  next();
}

/** Wrap an async handler so a rejection becomes a 500 rather than a hang. */
function handler(
  fn: (req: AuthedRequest, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req as AuthedRequest, res).catch((error: unknown) => {
      console.error(`[api] ${req.method} ${req.path} failed:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

/**
 * Is this a well-formed UUID?
 *
 * `matches.id` is a `uuid` column, so an id that is merely a string reaches
 * Postgres as `22P02 invalid input syntax for type uuid` — a 500 where the
 * caller deserves a 400, and (on `POST /rooms`) after their hourly
 * room-creation budget has already been spent on a request that creates
 * nothing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function mountApi(app: Application): void {
  narrowTransportCors();

  // The webhook is mounted BEFORE the JSON body parser scoped to /api, and
  // uses its own parser: grammY needs the parsed update, and Telegram will not
  // send an Origin header, so it must sit outside CORS as well.
  app.post('/telegram/webhook', express.json({ limit: '1mb' }), webhookHandler);

  app.get('/healthz', (_req, res) => {
    // Deliberately does not touch the database. Neon scale-to-zero means a
    // cold query can take seconds, and a health check that waits on one turns
    // a quiet night into a failed deploy.
    res.json({ ok: true, region: config.FLY_REGION, machine: config.FLY_MACHINE_ID });
  });

  const api = express.Router();
  api.use(cors, noStore, express.json({ limit: '256kb' }));

  /**
   * Exchange raw `initData` for a short-lived session token.
   *
   * This is the *only* endpoint that accepts `initData`, and it accepts it
   * once. Everything else takes our own token: a stolen `initData` stays
   * usable for as long as Telegram's `auth_date` window allows, whereas ours
   * expires in minutes.
   */
  api.post(
    '/auth',
    handler(async (req, res) => {
      const raw = typeof req.body?.initData === 'string' ? req.body.initData : '';
      let session;
      try {
        session = verifyInitData(raw);
      } catch (error) {
        const reason = error instanceof InitDataError ? error.reason : 'malformed';
        res.status(401).json({ error: 'init_data_rejected', reason });
        return;
      }

      const invite = decodeInvite(session.startParam);
      await recordLaunch(session, invite?.ref ?? null);

      void recordEvent({
        name: 'launch',
        userId: session.user.id,
        chatInstance: session.chatInstance,
        props: { platform: String(req.headers['user-agent'] ?? '').slice(0, 120) },
      });
      if (invite?.ref) {
        void recordEvent({
          name: 'referrer_present',
          userId: session.user.id,
          chatInstance: session.chatInstance,
          props: { ref: invite.ref },
        });
      }
      if (session.chatInstance) {
        void recordEvent({
          name: 'chat_context_present',
          userId: session.user.id,
          chatInstance: session.chatInstance,
          props: { chatType: session.chatType },
        });
      }

      // A cold or unreachable Neon compute must not cost the user their
      // launch: the stored language override is a preference, and English
      // falls out of the resolution order on its own if it cannot be read.
      let languageOverride: string | null = null;
      try {
        const [stored] = await db
          .select({ languageOverride: users.languageOverride })
          .from(users)
          .where(eq(users.id, session.user.id))
          .limit(1);
        languageOverride = stored?.languageOverride ?? null;
      } catch (error) {
        console.warn('[api] language override lookup failed:', error);
      }

      res.json({
        token: issueSessionToken(session),
        expiresIn: config.SESSION_TTL_SEC,
        user: session.user,
        // Language resolution order for the client: explicit choice →
        // signed `language_code` → English. The browser's own language is
        // never consulted; it misreports inside Telegram's webview.
        languageOverride,
        chat: session.chatInstance
          ? { instance: session.chatInstance, type: session.chatType }
          : null,
        chatLeaderboardsEnabled: config.CHAT_LEADERBOARDS_ENABLED,
        invite,
        botUsername: config.TELEGRAM_BOT_USERNAME,
        appName: config.TELEGRAM_APP_NAME,
      });
    }),
  );

  api.post(
    '/language',
    requireSession,
    handler(async (req, res) => {
      const language = typeof req.body?.language === 'string' ? req.body.language : null;
      await setLanguageOverride(req.session!.uid, language);
      res.json({ ok: true });
    }),
  );

  /** Open a room and return the invite link to drop into a chat. */
  api.post(
    '/rooms',
    requireSession,
    handler(async (req, res) => {
      const session = req.session!;
      const game = typeof req.body?.game === 'string' ? req.body.game : 'pong';

      const rematchOfMatchId =
        typeof req.body?.rematchOfMatchId === 'string' ? req.body.rematchOfMatchId : null;
      // Validated before the budget is consumed: a client with a stale id
      // should not burn its hourly quota on requests that cannot succeed.
      if (rematchOfMatchId !== null && !isUuid(rematchOfMatchId)) {
        res.status(400).json({ error: 'bad_match_id' });
        return;
      }

      let expectedGuestUserId: number | null = null;
      if (rematchOfMatchId) {
        const match = await getMatch(rematchOfMatchId);
        if (!match) {
          res.status(404).json({ error: 'match_not_found' });
          return;
        }
        // Only the two people who played a match may open a rematch of it.
        // Without this, a stranger silently reserves the room's second seat
        // for `match.playerAId` and stamps `rooms.rematch_of_match_id` with
        // someone else's match, forging the rematch attribution the whole
        // retention funnel is measured on.
        if (match.playerAId !== session.uid && match.playerBId !== session.uid) {
          res.status(403).json({ error: 'not_a_participant' });
          return;
        }
        // A rematch is addressed to the person you just played.
        expectedGuestUserId =
          match.playerAId === session.uid ? match.playerBId : match.playerAId;
      }

      if (!(await consumeRoomCreationBudget(session.uid))) {
        res.status(429).json({ error: 'too_many_rooms' });
        return;
      }

      try {
        const room = await createRoom({
          game,
          hostUserId: session.uid,
          chatInstance: session.ci,
          rematchOfMatchId,
          expectedGuestUserId,
        });

        const startParam = encodeInvite({
          game,
          room: room.roomCode,
          ref: session.uid,
        });

        // An unpersisted room is joinable by id but its code resolves to
        // nothing, so there is no invite link to give out. Say so rather than
        // handing back a URL that 404s for every recipient.
        res.json({
          ...room,
          origin: MatchOrigin.INVITE,
          startParam: room.persisted ? startParam : null,
          inviteUrl: room.persisted
            ? `https://t.me/${config.TELEGRAM_BOT_USERNAME}/${config.TELEGRAM_APP_NAME}?startapp=${startParam}`
            : null,
        });
      } catch (error) {
        if (error instanceof UnknownGameError) {
          res.status(400).json({ error: 'unknown_game' });
          return;
        }
        throw error;
      }
    }),
  );

  /** Resolve an invite code into something the client can `joinById`. */
  api.get(
    '/rooms/:code',
    requireSession,
    handler(async (req, res) => {
      const room = await resolveRoom(String(req.params.code));
      if (!room) {
        res.status(404).json({ error: 'room_unavailable' });
        return;
      }
      res.json(room);
    }),
  );

  api.get(
    '/stats/profile',
    requireSession,
    handler(async (req, res) => {
      const game = typeof req.query.game === 'string' ? req.query.game : 'pong';
      const [stats, opponents] = await Promise.all([
        getProfileStats(game, req.session!.uid),
        listHeadToHead(game, req.session!.uid),
      ]);
      res.json({ stats, opponents });
    }),
  );

  api.get(
    '/stats/head-to-head/:opponentId',
    requireSession,
    handler(async (req, res) => {
      const game = typeof req.query.game === 'string' ? req.query.game : 'pong';
      const opponentId = Number(req.params.opponentId);
      if (!Number.isSafeInteger(opponentId)) {
        res.status(400).json({ error: 'bad_opponent' });
        return;
      }
      res.json(await getHeadToHead(game, req.session!.uid, opponentId));
    }),
  );

  /**
   * The chat leaderboard.
   *
   * Chat identity comes from `chat_instance` in the session — present only for
   * a Mini App opened by direct link. A session from the bot menu or `/start`
   * has none, and gets an explicit `available: false` so the UI can fall back
   * to profile and head-to-head rather than rendering an empty table.
   */
  api.get(
    '/stats/chat',
    requireSession,
    handler(async (req, res) => {
      const session = req.session!;
      const game = typeof req.query.game === 'string' ? req.query.game : 'pong';

      if (!config.CHAT_LEADERBOARDS_ENABLED) {
        res.json({ available: false, reason: 'disabled', rows: [] });
        return;
      }
      if (!session.ci) {
        res.json({ available: false, reason: 'no_chat_context', rows: [] });
        return;
      }
      // A "chat leaderboard" in a one-to-one conversation is a table of two
      // people, which head-to-head already says better.
      if (session.ct === 'sender' || session.ct === 'private') {
        res.json({ available: false, reason: 'solo_conversation', rows: [] });
        return;
      }

      res.json({ available: true, rows: await getChatLeaderboard(session.ci, game) });
    }),
  );

  /**
   * Prepare a single-use invite for Telegram's own chat picker.
   *
   * The clipboard is not a viable primary path here: `navigator.clipboard` is
   * unavailable or permission-denied inside Telegram's webview on iOS, where
   * a "copy link" button looks like it worked and did nothing. This gives the
   * Mini App something to hand `shareMessage()`, which opens Telegram's native
   * chat list over the running app — the room stays open underneath and
   * nothing has to be pasted.
   *
   * The room code is re-encoded here rather than taken from the client, so an
   * invite can only ever point at a room this caller actually hosts.
   */
  api.post(
    '/invite/:roomCode',
    requireSession,
    handler(async (req, res) => {
      const session = req.session!;
      const roomCode = String(req.params.roomCode);

      const room = await resolveRoom(roomCode);
      if (!room) {
        res.status(404).json({ error: 'room_not_found' });
        return;
      }
      if (room.hostUserId !== session.uid) {
        res.status(403).json({ error: 'not_the_host' });
        return;
      }

      const prepared = await prepareInvite({
        userId: session.uid,
        userName: session.n,
        languageCode: session.l,
        startParam: encodeInvite({ game: room.game, room: room.roomCode, ref: session.uid }),
      });

      if (!prepared) {
        // The link is still on screen, so this is a degraded share rather than
        // a dead end — say so with a status the client can retry on.
        res.status(502).json({ error: 'share_unavailable' });
        return;
      }

      void recordEvent({
        name: 'share_tapped',
        userId: session.uid,
        chatInstance: session.ci,
        game: room.game,
      });

      res.json(prepared);
    }),
  );

  /**
   * Prepare a single-use shareable result card.
   *
   * A fresh prepared-message id is produced on every tap, because the id is
   * consumed by the first `shareMessage()` call and reusing it gives the user
   * a picker that silently does nothing.
   */
  api.post(
    '/share/:matchId',
    requireSession,
    handler(async (req, res) => {
      const session = req.session!;
      const matchId = String(req.params.matchId);
      if (!isUuid(matchId)) {
        res.status(400).json({ error: 'bad_match_id' });
        return;
      }
      const match = await getMatch(matchId);
      if (!match) {
        res.status(404).json({ error: 'match_not_found' });
        return;
      }
      if (match.playerAId !== session.uid && match.playerBId !== session.uid) {
        // Only the two people who played it may share a card of it.
        res.status(403).json({ error: 'not_a_participant' });
        return;
      }

      void recordEvent({
        name: 'share_tapped',
        userId: session.uid,
        chatInstance: session.ci,
        game: match.game,
        matchId: match.id,
      });

      const profiles = await db
        .select({ id: users.id, name: users.firstName, photoUrl: users.photoUrl })
        .from(users)
        .where(inArray(users.id, [match.playerAId, match.playerBId]));
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));

      // Every result screen and every shared card carries a rematch button —
      // it is the retention mechanic that matters, so the room is opened here
      // rather than when the recipient taps.
      //
      // Under the same budget as `POST /rooms`: a `PongRoom` sets
      // `autoDispose = false` and runs a 30Hz fixed timestep for a full hour,
      // so an unmetered room-per-tap here is a CPU and memory DoS from one
      // authenticated account.
      if (!(await consumeRoomCreationBudget(session.uid))) {
        res.status(429).json({ error: 'too_many_rooms' });
        return;
      }

      const rematchRoom = await createRoom({
        game: match.game,
        hostUserId: session.uid,
        chatInstance: session.ci,
        rematchOfMatchId: match.id,
        expectedGuestUserId: match.playerAId === session.uid ? match.playerBId : match.playerAId,
      });

      const prepared = await prepareShare({
        matchId: match.id,
        userId: session.uid,
        languageCode: session.l,
        rematchRoomCode: rematchRoom.roomCode,
        card: {
          bottom: {
            name: byId.get(match.playerAId)?.name ?? '',
            photoUrl: byId.get(match.playerAId)?.photoUrl ?? null,
            score: match.scoreA,
            isWinner: match.winnerId === match.playerAId,
          },
          top: {
            name: byId.get(match.playerBId)?.name ?? '',
            photoUrl: byId.get(match.playerBId)?.photoUrl ?? null,
            score: match.scoreB,
            isWinner: match.winnerId === match.playerBId,
          },
          longestRally: match.longestRally,
        },
      });

      if (!prepared) {
        // The card never got made, so nobody will ever tap this room's invite.
        // Leaving it running would leak a live room on every share failure.
        void closeRoom(rematchRoom);
        void recordEvent({
          name: 'share_message_failed',
          userId: session.uid,
          game: match.game,
          matchId: match.id,
          props: { stage: 'prepare' },
        });
        res.status(502).json({ error: 'share_unavailable' });
        return;
      }

      res.json({ ...prepared, rematchRoom });
    }),
  );

  /**
   * Client-side funnel events.
   *
   * The client owns three of the funnel steps the server cannot see —
   * `shareMessageSent`, `shareMessageFailed`, and `rematch_tapped` — so it
   * needs a way to report them. The name is validated against the closed union
   * so this cannot become an open write endpoint.
   */
  api.post(
    '/events',
    requireSession,
    handler(async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const allowed = new Set([
        'share_message_sent',
        'share_message_failed',
        'rematch_tapped',
        'invite_shared',
        // One netcode summary per player per match. The client keeps bounded
        // samples during play and posts percentiles once, at the end.
        'netcode_sample',
      ]);
      if (!allowed.has(name)) {
        res.status(400).json({ error: 'unknown_event' });
        return;
      }
      const matchId = typeof req.body?.matchId === 'string' ? req.body.matchId : undefined;
      // `events.match_id` is a `uuid` column and events are inserted in
      // batches: one unparseable id poisons the whole batch, and because the
      // batch is spliced off the queue before the insert, up to fifty
      // unrelated funnel rows — other users' included — are lost with it.
      if (matchId !== undefined && !isUuid(matchId)) {
        res.status(400).json({ error: 'bad_match_id' });
        return;
      }
      await recordEvent({
        name: name as never,
        userId: req.session!.uid,
        chatInstance: req.session!.ci,
        game: typeof req.body?.game === 'string' ? req.body.game : 'pong',
        matchId,
        props: typeof req.body?.props === 'object' ? req.body.props : undefined,
      });
      res.json({ ok: true });
    }),
  );

  app.use('/api', api);

  // LAST. The Mini App's fallback answers anything that is left, so every
  // route above has to be registered before it.
  mountClient(app);
}
