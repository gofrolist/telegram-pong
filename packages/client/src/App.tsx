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
import { initI18n } from './i18n/index.js';
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
  | { kind: 'match'; room: PongRoomHandle; side: Side }
  | { kind: 'result'; outcome: MatchOutcome };

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
    async (colyseusRoomId: string, token: string) => {
      setScreen({ kind: 'joining' });
      try {
        const room = await joinRoom({ colyseusRoomId, token });
        roomRef.current = room;

        // Which end of the field is ours. The server assigns it; the client
        // only mirrors the *view*, never the simulation.
        const state = room.state as PongState;
        const me = state.players.get(room.sessionId);
        const side: Side = me?.side === SIDE_TOP ? SIDE_TOP : SIDE_BOTTOM;

        setScreen({ kind: 'match', room, side });
      } catch {
        setScreen({ kind: 'failed', message: t('home.roomExpired') });
      }
    },
    [t],
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
        if (!cancelled) setScreen({ kind: 'failed', message: t('app.error') });
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
  }, [enterRoom, t]);

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
      void enterRoom(room.colyseusRoomId, auth.token);
    },
    [auth, enterRoom],
  );

  if (debugMode() === 'initdata') {
    return <InitDataDump environment={environment} auth={auth} />;
  }

  switch (screen.kind) {
    case 'booting':
      return <div className="screen screen--centered">{t('app.loading')}</div>;

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
