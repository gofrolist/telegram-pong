/**
 * The live match.
 *
 * Two loops that never touch each other:
 *   - the animation frame, which sends input, reads the smoothed world and
 *     draws it. It never calls `setState`.
 *   - React, which renders only the things that change at human speed: the
 *     pause overlay, the reconnection countdown, the final score.
 *
 * Keeping the ball out of React is the difference between a smooth 120 fps and
 * a phone that heats up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Phase, SIDE_BOTTOM, SIDE_TOP, type Side } from '@pong/game-core';
import type { PongState } from '@pong/game-core/net';

import * as api from '../api.js';
import { attachPrediction, type PredictionHandle } from '../net/predictionAdapter.js';
import type { PongRoomHandle } from '../net/client.js';
import { draw, pointerToFieldX, resizeCanvas, type Theme, type Viewport } from './renderer.js';

export interface MatchOutcome {
  matchId: string;
  scoreSelf: number;
  scoreOpponent: number;
  won: boolean;
  endReason: number;
  longestRally: number;
  opponentName: string;
}

interface Props {
  room: PongRoomHandle;
  mySide: Side;
  /**
   * Set only for the host who just opened this room. The waiting screen is the
   * one place they can still reach the link they have to share, so it has to
   * travel with them rather than staying behind on the home screen.
   */
  inviteUrl?: string | null;
  onFinished(outcome: MatchOutcome): void;
  onLeave(): void;
}

/**
 * Colours read from Telegram's theme params, which `bindThemeParamsCssVars`
 * has already published as CSS variables. Falling back to a dark field rather
 * than to white: a bright field with a small dark ball is the harder one to
 * track, and dark is what Telegram defaults to on most phones.
 */
function readTheme(): Theme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--tg-theme-secondary-bg-color', '#0d1017'),
    line: read('--tg-theme-hint-color', '#2b303b'),
    ball: read('--tg-theme-text-color', '#ffffff'),
    self: read('--tg-theme-button-color', '#4a9cff'),
    opponent: read('--tg-theme-destructive-text-color', '#e2604a'),
    text: read('--tg-theme-text-color', '#ffffff'),
  };
}

export function MatchView({ room, mySide, inviteUrl, onFinished, onLeave }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * Where the finger is, in field units. A ref, not state: it changes on every
   * pointer event and must never trigger a render.
   */
  const desiredXRef = useRef<number>(50);

  const [phase, setPhase] = useState<number>(Phase.WAITING);
  const [reconnectSeconds, setReconnectSeconds] = useState(0);
  const [opponentConnected, setOpponentConnected] = useState(true);
  const [selfConnected, setSelfConnected] = useState(true);
  const [inviteCopied, setInviteCopied] = useState(false);

  const mirrored = mySide === SIDE_TOP;

  // ---------------------------------------------------------------------
  // The animation frame
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let viewport: Viewport = resizeCanvas(canvas);
    let theme = readTheme();
    let running = true;
    let frameHandle = 0;
    let prediction: PredictionHandle | null = null;

    const observer = new ResizeObserver(() => {
      viewport = resizeCanvas(canvas);
    });
    observer.observe(canvas);

    // Telegram can change the theme under a running app.
    const themeInterval = window.setInterval(() => {
      theme = readTheme();
    }, 2000);

    const state = room.state as PongState;

    // Attaching waits for the first decoded state patch, so the render loop
    // starts before prediction is live and simply draws the replicated
    // position until it is.
    attachPrediction(room, mySide)
      .then((handle) => {
        if (!running) {
          handle.dispose();
          return;
        }
        prediction = handle;
      })
      .catch((error: unknown) => {
        // Prediction is an enhancement, not a prerequisite: the loop below
        // falls back to drawing the replicated state. Swallowing this
        // silently would leave an unhandled rejection instead.
        console.warn('[match] prediction unavailable, falling back to replicated state', error);
      });

    const loop = () => {
      if (!running) return;
      frameHandle = requestAnimationFrame(loop);

      // Send input and advance the reconciler. Even while paused: the adapter
      // needs a tick to keep its clock aligned, and the shared simulation
      // freezes itself when the phase says so.
      prediction?.frame(desiredXRef.current);

      // Until prediction is attached, draw the replicated state directly. It
      // is a fraction of a second on join, and a still countdown screen.
      const snapshot = prediction?.read() ?? {
        ballX: state.ball.x,
        ballY: state.ball.y,
        bottomX: state.bottom.x,
        topX: state.top.x,
      };
      const selfScore = mySide === SIDE_BOTTOM ? state.meta.scoreBottom : state.meta.scoreTop;
      const opponentScore = mySide === SIDE_BOTTOM ? state.meta.scoreTop : state.meta.scoreBottom;

      draw(
        context,
        viewport,
        {
          ballX: snapshot.ballX,
          ballY: snapshot.ballY,
          bottomX: snapshot.bottomX,
          topX: snapshot.topX,
          scoreSelf: selfScore,
          scoreOpponent: opponentScore,
          mirrored,
          countdown:
            state.meta.phase === Phase.COUNTDOWN
              ? Math.ceil(state.meta.countdown / 30)
              : 0,
          dimmed: state.meta.phase === Phase.PAUSED,
        },
        theme,
      );
    };

    frameHandle = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(frameHandle);
      observer.disconnect();
      window.clearInterval(themeInterval);
      prediction?.dispose();
    };
  }, [room, mySide, mirrored]);

  // ---------------------------------------------------------------------
  // React-speed state
  // ---------------------------------------------------------------------
  useEffect(() => {
    const state = room.state as PongState;

    // Polled rather than subscribed per field: these values change a few times
    // a match, and a poll avoids wiring a callback per schema field only to
    // re-render the same overlay.
    const interval = window.setInterval(() => {
      setPhase(state.meta.phase);

      let opponentOnline = true;
      let selfOnline = true;
      let seconds = 0;
      let opponentName = '';

      state.players.forEach((player) => {
        seconds = Math.max(seconds, player.reconnectSecondsLeft);
        if (player.sessionId === room.sessionId) {
          selfOnline = player.connected;
        } else {
          opponentOnline = player.connected;
          opponentName = player.name;
        }
      });

      setOpponentConnected(opponentOnline);
      setSelfConnected(selfOnline);
      setReconnectSeconds(seconds);

      if (state.meta.phase === Phase.ENDED && state.matchId) {
        const selfScore = mySide === SIDE_BOTTOM ? state.meta.scoreBottom : state.meta.scoreTop;
        const opponentScore = mySide === SIDE_BOTTOM ? state.meta.scoreTop : state.meta.scoreBottom;
        window.clearInterval(interval);
        onFinished({
          matchId: state.matchId,
          scoreSelf: selfScore,
          scoreOpponent: opponentScore,
          won: selfScore > opponentScore,
          endReason: state.meta.endReason,
          longestRally: state.meta.rallyHits,
          opponentName,
        });
      }
    }, 200);

    return () => window.clearInterval(interval);
  }, [room, mySide, onFinished]);

  // ---------------------------------------------------------------------
  // Touch
  // ---------------------------------------------------------------------
  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // `preventDefault` plus `touch-action: none` in CSS is what stops a drag
      // from scrolling the page or pulling the Mini App closed. Telegram's
      // vertical-swipe-to-dismiss is separately disabled at startup.
      event.preventDefault();
      desiredXRef.current = pointerToFieldX(event.clientX, canvas, mirrored);
    },
    [mirrored],
  );

  const copyInvite = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      api.reportEvent('invite_shared', { props: { method: 'copy' } });
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      // Clipboard permission can be denied inside the webview; the link is
      // rendered on screen either way.
    }
  }, [inviteUrl]);

  const paused = phase === Phase.PAUSED;

  return (
    <div className="match">
      <canvas
        ref={canvasRef}
        className="match__canvas"
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        // Capture the pointer so a finger that slides off the canvas edge
        // mid-rally keeps steering rather than dropping the paddle.
        onPointerDownCapture={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
      />

      {paused && (
        <div className="match__overlay" role="status">
          <div className="match__overlay-title">{t('match.paused')}</div>
          <div className="match__overlay-text">
            {!selfConnected
              ? t('match.youDisconnected')
              : !opponentConnected
                ? t('match.opponentDisconnected')
                : t('match.connecting')}
          </div>
          {reconnectSeconds > 0 && (
            <div className="match__overlay-countdown">
              {t('match.reconnectIn', { seconds: reconnectSeconds })}
            </div>
          )}
        </div>
      )}

      {phase === Phase.WAITING && (
        <div className="match__overlay" role="status">
          <div className="match__overlay-title">{t('home.waitingForOpponent')}</div>
          <div className="match__overlay-text">{t('home.waitingHint')}</div>
          {inviteUrl && (
            <>
              <code className="card__link">{inviteUrl}</code>
              <button type="button" className="button button--primary" onClick={() => void copyInvite()}>
                {inviteCopied ? t('home.copied') : t('home.copyLink')}
              </button>
            </>
          )}
        </div>
      )}

      <button type="button" className="match__leave" onClick={onLeave}>
        {t('match.leave')}
      </button>
    </div>
  );
}
