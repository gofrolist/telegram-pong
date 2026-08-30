/**
 * Application shell and the screen state machine.
 *
 * The launch path, in order:
 *   1. Bring up the Telegram SDK and read `initData`.
 *   2. Exchange it, once, for a short-lived session token.
 *   3. Initialise i18n explicitly from the language the exchange returned.
 *   4. If the launch carried an invite, join that room. Otherwise, home.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SIDE_BOTTOM, SIDE_TOP, decodeInvite, type Side } from '@pong/game-core';
import type { PongState } from '@pong/game-core/net';

import * as api from './api.js';
import { i18next, initI18n } from './i18n/index.js';
import { joinRoom, type PongRoomHandle } from './net/client.js';
import { initTelegram, type TelegramEnvironment } from './telegram.js';
import { MatchView, type MatchOutcome } from './game/MatchView.js';
import { Home } from './screens/Home.js';
import { Result } from './screens/Result.js';
import { InitDataDump } from './debug/InitDataDump.js';

type Screen =
  | { kind: 'booting' }
  | { kind: 'outside-telegram' }
  | { kind: 'failed'; message: string }
  | { kind: 'home' }
  | { kind: 'joining' }
  | { kind: 'match'; room: PongRoomHandle; side: Side; inviteUrl: string | null }
  | { kind: 'result'; outcome: MatchOutcome };

/** How long to wait for our own `PlayerInfo` to decode before giving up. */
const SIDE_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Resolve which end of the field we defend.
 *
 * The seat is confirmed before the first state patch arrives, so `players` is
 * empty at that moment; polling until our own entry decodes is what stops both
 * clients from concluding they are the bottom player.
 */
function waitForMySide(room: PongRoomHandle): Promise<Side> {
  const read = (): Side | null => {
    const state = room.state as PongState | undefined;
    const me = state?.players?.get(room.sessionId);
    if (!me) return null;
    return me.side === SIDE_TOP ? SIDE_TOP : SIDE_BOTTOM;
  };

  const immediate = read();
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise<Side>((resolve, reject) => {
    const deadline = Date.now() + SIDE_RESOLVE_TIMEOUT_MS;
    const timer = window.setInterval(() => {
      const side = read();
      if (side !== null) {
        window.clearInterval(timer);
        resolve(side);
      } else if (Date.now() > deadline) {
        window.clearInterval(timer);
        reject(new Error('side_unresolved'));
      }
    }, 16);
  });
}

/**
 * `?debug=initdata` renders the raw-`initData` probe instead of the game.
 *
 * This is the harness for verifying `chat_instance` behaviour across two
 * accounts and two chats before per-chat leaderboards are trusted — see
 * `docs/CHAT-INSTANCE-VERIFICATION.md`.
 */
function debugMode(): string | null {
  return new URLSearchParams(window.location.search).get('debug');
}

export function App() {
  const { t } = useTranslation();
  const [screen, setScreen] = useState<Screen>({ kind: 'booting' });
  const [language, setLanguage] = useState('en');
  const [environment, setEnvironment] = useState<TelegramEnvironment | null>(null);
  const [auth, setAuth] = useState<api.AuthResponse | null>(null);
  const [profile, setProfile] = useState<api.ProfileResponse | null>(null);
  const [chatLeaderboard, setChatLeaderboard] = useState<api.ChatLeaderboardResponse | null>(null);

  /** The live room, so cleanup can leave it even from an unrelated code path. */
  const roomRef = useRef<PongRoomHandle | null>(null);

  const enterRoom = useCallback(
    async (colyseusRoomId: string, token: string, inviteUrl?: string | null) => {
      setScreen({ kind: 'joining' });
      try {
        // Joining another room means the previous connection is finished with;
        // dropping it on the floor holds one of the room's two seats open
        // until the server's grace period expires.
        const previous = roomRef.current;
        roomRef.current = null;
        if (previous) await previous.leave(true).catch(() => {});

        const room = await joinRoom({ colyseusRoomId, token });
        roomRef.current = room;

        // Which end of the field is ours. The server assigns it; the client
        // only mirrors the *view*, never the simulation.
        //
        // `joinById` resolves on the seat confirmation, which is strictly
        // earlier than the first state patch — reading `players` here without
        // waiting returns an empty map, and every client would decide it was
        // the bottom player. See the same hazard in `predictionAdapter.ts`.
        const side = await waitForMySide(room);

        setScreen({ kind: 'match', room, side, inviteUrl: inviteUrl ?? null });
      } catch {
        // `i18next.t` rather than the hook's `t`: the hook's identity changes
        // when i18n finishes initialising, and depending on it here would make
        // this callback — and the boot effect that depends on it — re-run.
        setScreen({ kind: 'failed', message: i18next.t('home.roomExpired') });
      }
    },
    [],
  );

  // Boot.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const env = await initTelegram();
      if (cancelled) return;
      setEnvironment(env);

      if (!env.inTelegram) {
        await initI18n(null, null);
        setScreen({ kind: 'outside-telegram' });
        return;
      }

      let session: api.AuthResponse;
      try {
        session = await api.authenticate(env.initDataRaw);
      } catch {
        await initI18n(null, null);
        // `i18next.t`, not the hook's `t`: the hook's `t` was captured on the
        // render *before* i18n existed, so it is react-i18next's not-ready
        // stub and would render the literal key `app.error` at the user.
        if (!cancelled) setScreen({ kind: 'failed', message: i18next.t('app.error') });
        return;
      }
      if (cancelled) return;

      setAuth(session);
      // Explicit initialisation from the signed language, never from the
      // browser's — inside Telegram's webview the two routinely disagree.
      const resolved = await initI18n(session.languageOverride, session.user.languageCode);
      setLanguage(resolved);

      // Stats are not on the critical path: the home screen renders without
      // them and fills in when they land.
      void api.getProfile().then(setProfile).catch(() => {});
      void api.getChatLeaderboard().then(setChatLeaderboard).catch(() => {});

      const invite = session.invite ?? decodeInvite(env.startParam);
      if (invite?.room) {
        try {
          const resolvedRoom = await api.resolveRoom(invite.room);
          if (!cancelled) await enterRoom(resolvedRoom.colyseusRoomId, session.token);
          return;
        } catch {
          // An expired or already-full invite lands on home rather than on an
          // error, and offers to start a match — the tap is itself a
          // conversion opportunity.
          if (!cancelled) setScreen({ kind: 'home' });
          return;
        }
      }

      if (!cancelled) setScreen({ kind: 'home' });
    })();

    return () => {
      cancelled = true;
    };
    // Boot runs exactly once. `enterRoom` is stable by construction; adding
    // `t` here would re-run the whole boot — a second `initTelegram`, a second
    // `POST /api/auth` and a second `joinRoom` — the moment i18n finishes
    // initialising and react-i18next hands back a new `t` identity.
  }, [enterRoom]);

  // Leave the room on unmount, whatever path got us here.
  useEffect(
    () => () => {
      void roomRef.current?.leave(true);
      roomRef.current = null;
    },
    [],
  );

  const handleFinished = useCallback((outcome: MatchOutcome) => {
    void roomRef.current?.leave(true);
    roomRef.current = null;
    setScreen({ kind: 'result', outcome });
    // Refresh the numbers the match just changed.
    void api.getProfile().then(setProfile).catch(() => {});
    void api.getChatLeaderboard().then(setChatLeaderboard).catch(() => {});
  }, []);

  const handleLeave = useCallback(() => {
    void roomRef.current?.leave(true);
    roomRef.current = null;
    setScreen({ kind: 'home' });
  }, []);

  const handleRoomOpened = useCallback(
    (room: api.CreatedRoom) => {
      if (!auth) return;
      // The invite link travels with us into the match: the host lands
      // straight on the waiting screen, and that screen is the only place they
      // can still get at the link they need to share.
      void enterRoom(room.colyseusRoomId, auth.token, room.inviteUrl);
    },
    [auth, enterRoom],
  );

  if (debugMode() === 'initdata') {
    return <InitDataDump environment={environment} auth={auth} />;
  }

  switch (screen.kind) {
    case 'booting':
      // Deliberately not translated. This screen is on screen *before* i18n is
      // initialised — initialisation needs the language the auth exchange
      // returns — so `t` here is react-i18next's not-ready stub and would
      // render the literal key `app.loading` at the user. An ellipsis says the
      // same thing in every language.
      return <div className="screen screen--centered">…</div>;

    case 'outside-telegram':
      return <div className="screen screen--centered">{t('app.openInTelegram')}</div>;

    case 'failed':
      return (
        <div className="screen screen--centered">
          <p className="error">{screen.message}</p>
          <button type="button" className="button button--primary" onClick={() => setScreen({ kind: 'home' })}>
            {t('home.startYourOwn')}
          </button>
        </div>
      );

    case 'joining':
      return <div className="screen screen--centered">{t('match.connecting')}</div>;

    case 'match':
      return (
        <MatchView
          room={screen.room}
          mySide={screen.side}
          inviteUrl={screen.inviteUrl}
          onFinished={handleFinished}
          onLeave={handleLeave}
        />
      );

    case 'result':
      return (
        <Result
          outcome={screen.outcome}
          language={language}
          onRematch={handleRoomOpened}
          onHome={() => setScreen({ kind: 'home' })}
        />
      );

    case 'home':
      return (
        <Home
          language={language}
          profile={profile}
          chatLeaderboard={chatLeaderboard}
          onRoomOpened={handleRoomOpened}
        />
      );
  }
}
