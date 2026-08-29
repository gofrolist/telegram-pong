/**
 * The HTTP API.
 *
 * Everything a Mini App needs that is not the realtime socket: the one-time
 * `initData` exchange, room creation and invite resolution, stats reads, and
 * share preparation.
 *
 * CORS is explicit and narrow. Vercel and fly are different origins, so the
 * browser will preflight every one of these; a permissive `*` would also make
 * the session token readable by any page that can convince a user to visit it.
 */

import type { Application, NextFunction, Request, Response } from 'express';
import express from 'express';

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
import { createRoom, resolveRoom, UnknownGameError } from './rooms.js';
import {
  getChatLeaderboard,
  getHeadToHead,
  getMatch,
  getProfileStats,
  listHeadToHead,
} from './stats.js';
import { prepareShare } from '../share/prepared.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { webhookHandler } from '../telegram/bot.js';

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

export function mountApi(app: Application): void {
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

      if (!(await consumeRoomCreationBudget(session.uid))) {
        res.status(429).json({ error: 'too_many_rooms' });
        return;
      }

      const rematchOfMatchId =
        typeof req.body?.rematchOfMatchId === 'string' ? req.body.rematchOfMatchId : null;
      let expectedGuestUserId: number | null = null;
      if (rematchOfMatchId) {
        const match = await getMatch(rematchOfMatchId);
        if (match) {
          // A rematch is addressed to the person you just played.
          expectedGuestUserId =
            match.playerAId === session.uid ? match.playerBId : match.playerAId;
        }
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

        res.json({
          ...room,
          origin: MatchOrigin.INVITE,
          startParam,
          inviteUrl: `https://t.me/${config.TELEGRAM_BOT_USERNAME}/${config.TELEGRAM_APP_NAME}?startapp=${startParam}`,
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
      const match = await getMatch(String(req.params.matchId));
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
      ]);
      if (!allowed.has(name)) {
        res.status(400).json({ error: 'unknown_event' });
        return;
      }
      await recordEvent({
        name: name as never,
        userId: req.session!.uid,
        chatInstance: req.session!.ci,
        game: typeof req.body?.game === 'string' ? req.body.game : 'pong',
        matchId: typeof req.body?.matchId === 'string' ? req.body.matchId : undefined,
        props: typeof req.body?.props === 'object' ? req.body.props : undefined,
      });
      res.json({ ok: true });
    }),
  );

  app.use('/api', api);
}
