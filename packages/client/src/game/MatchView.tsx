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
import { canSharePreparedMessage, sharePreparedMessage } from '../telegram.js';
import { loadNetcodeOverlay } from '../debug/netcode.js';
import { NetcodeSampler } from '../net/netcodeSampler.js';
import { MatchFeedback } from './feedback.js';
import { PaddleKeyboard } from './keyboard.js';
import {
  computeOverlayAnchors,
  draw,
  pointerToFieldX,
  resizeCanvas,
  type Theme,
  type Viewport,
} from './renderer.js';

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
   * one place they can still reach the invite they have to send, so it has to
   * travel with them rather than staying behind on the home screen.
   */
  inviteUrl?: string | null;
  /** The room the invite opens; the server re-encodes the link from it. */
  inviteRoomCode?: string | null;
  /**
   * Telegram's platform tag (`ios`, `android`, `tdesktop`, `web`…).
   *
   * Carried only for the netcode summary. Every platform is a different
   * webview with its own frame scheduling, and a drift figure means something
   * different on each — so a report without it is barely comparable to the
   * next one.
   */
  platform: string;
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

export function MatchView({
  room,
  mySide,
  inviteUrl,
  inviteRoomCode,
  platform,
  onFinished,
  onLeave,
}: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * Where the finger is, in field units. A ref, not state: it changes on every
   * pointer event and must never trigger a render.
   */
  const desiredXRef = useRef<number>(50);

  /**
   * The arrow keys, on the desktop clients. A ref for the same reason as
   * `desiredXRef`: it is read on every frame and written by every keystroke,
   * and neither may render.
   */
  const keyboardRef = useRef<PaddleKeyboard>(new PaddleKeyboard());

  /**
   * The netcode summary in progress.
   *
   * A ref rather than state, for the same reason as `desiredXRef`: it is
   * written on every frame and must never cause a render. It lives at
   * component scope because the frame loop fills it and a different effect —
   * the one that notices the match ended — is what sends it.
   */
  const samplerRef = useRef<NetcodeSampler>(new NetcodeSampler());

  /**
   * Hits and points, as something the player can feel and see.
   *
   * At component scope for the same reason as the sampler: the frame loop
   * drives it and the match-ended effect reads its tally. It is fed by the
   * prediction adapter's event channels, so its cues land at the moment the
   * simulation produced the event rather than one round trip later — see
   * `MatchEventSink` in `net/predictionAdapter.ts`.
   */
  const feedbackRef = useRef<MatchFeedback>(new MatchFeedback(mySide));

  const [phase, setPhase] = useState<number>(Phase.WAITING);
  const [reconnectSeconds, setReconnectSeconds] = useState(0);
  const [opponentConnected, setOpponentConnected] = useState(true);
  const [selfConnected, setSelfConnected] = useState(true);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const mirrored = mySide === SIDE_TOP;

  // ---------------------------------------------------------------------
  // The animation frame
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    // The waiting overlay is DOM laid out around things drawn on the canvas —
    // the score numerals and the dashed centre line. It cannot read the
    // viewport, and a percentage of the overlay is not a position on the
    // letterboxed field, so hand it the two anchors in CSS pixels and let the
    // stylesheet do the arithmetic. Published here, next to the resize that
    // invalidates them, so there is exactly one place they can go stale.
    const publishAnchors = (current: Viewport) => {
      const host = canvas.parentElement;
      if (!host) return;
      const anchors = computeOverlayAnchors(current);
      host.style.setProperty('--field-score-top', `${anchors.scoreTop}px`);
      host.style.setProperty('--field-centre-line', `${anchors.centreLine}px`);
    };

    let viewport: Viewport = resizeCanvas(canvas);
    publishAnchors(viewport);
    let theme = readTheme();
    let running = true;
    let frameHandle = 0;
    let prediction: PredictionHandle | null = null;

    const observer = new ResizeObserver(() => {
      viewport = resizeCanvas(canvas);
      publishAnchors(viewport);
    });
    observer.observe(canvas);

    // Telegram can change the theme under a running app.
    const themeInterval = window.setInterval(() => {
      theme = readTheme();
    }, 2000);

    const state = room.state as PongState;

    // Where the player's own paddle was drawn last frame, and when that frame
    // was. Both exist only to turn held arrow keys into the absolute target
    // the rest of the pipeline speaks in; see the keyboard step in `loop`.
    let selfPaddleX = desiredXRef.current;
    let lastFrameAt = 0;

    // No-op unless the overlay was switched on. Loading it here rather than at
    // startup means it is fetched at the moment there is finally something for
    // it to show, and the SDK replays what publishers emitted before it
    // installed — so arriving after the room joined costs nothing.
    void loadNetcodeOverlay();

    // Attaching waits for the first decoded state patch, so the render loop
    // starts before prediction is live and simply draws the replicated
    // position until it is.
    attachPrediction(room, mySide, { events: feedbackRef.current })
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

    const loop = (now: number) => {
      if (!running) return;
      frameHandle = requestAnimationFrame(loop);

      // Held arrow keys, folded into the same target the finger writes — so
      // everything downstream, prediction included, sees one kind of input.
      //
      // Only while the room is actually simulating: `step` in the shared sim
      // moves no paddle outside PLAYING and COUNTDOWN, so integrating a held
      // key through the waiting screen or a reconnection pause would park the
      // target at the wall against a paddle standing still — and the moment
      // play resumed it would glide there with no key down, which is the exact
      // failure the integration is built to avoid.
      const simulating =
        state.meta.phase === Phase.PLAYING || state.meta.phase === Phase.COUNTDOWN;
      if (simulating) {
        const dt = lastFrameAt === 0 ? 0 : (now - lastFrameAt) / 1000;
        desiredXRef.current = keyboardRef.current.step(
          desiredXRef.current,
          selfPaddleX,
          dt,
          mirrored,
        );
      }
      lastFrameAt = now;

      // Send input and advance the reconciler. Even while paused: the adapter
      // needs a tick to keep its clock aligned, and the shared simulation
      // freezes itself when the phase says so.
      //
      // `now` is rAF's own timestamp, passed straight through. Sampling the
      // clock inside this callback instead would hand the interpolation a
      // jittery dt and put a visible wobble on the ball.
      prediction?.frame(desiredXRef.current, now);

      // Frames are counted even before prediction attaches, so the fps figure
      // describes the whole time the player was looking at the field rather
      // than only the part that was instrumented.
      if (prediction) samplerRef.current.frame(now, () => prediction!.stats());


      // Until prediction is attached, draw the replicated state directly. It
      // is a fraction of a second on join, and a still countdown screen.
      const snapshot = prediction?.read() ?? {
        ballX: state.ball.x,
        ballY: state.ball.y,
        bottomX: state.bottom.x,
        topX: state.top.x,
      };
      selfPaddleX = mySide === SIDE_BOTTOM ? snapshot.bottomX : snapshot.topX;
      const selfScore = mySide === SIDE_BOTTOM ? state.meta.scoreBottom : state.meta.scoreTop;
      const opponentScore = mySide === SIDE_BOTTOM ? state.meta.scoreTop : state.meta.scoreBottom;

      // The numerals stay AUTHORITATIVE while the cues run early, and the
      // asymmetry is the point. A haptic for a point that the far paddle
      // turns out to have saved is a wrong signal the player has already
      // felt and forgotten; a score numeral that reads 4-3 and then goes
      // back to 3-3 is a wrong signal they are still looking at. So the
      // cheap-to-be-wrong half is predicted and the expensive half waits —
      // and at a healthy lead the numeral is ~170ms behind the cue, which
      // the README's `lead ms` column has always described as invisible.
      const cues = feedbackRef.current.read();

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
          bottomFlash: cues.bottomFlash,
          topFlash: cues.topFlash,
          pointFlash: cues.pointFlash,
          pointFlashMine: cues.pointFlashMine,
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

        // One netcode row per player per match, sent at the only moment the
        // whole match is known. `summarize` returns null when there is too
        // little to be worth a row — a match that ended on a disconnect would
        // otherwise contribute noise indistinguishable from signal.
        const summary = samplerRef.current.summarize(performance.now());
        if (summary) {
          api.reportEvent('netcode_sample', {
            matchId: state.matchId,
            props: {
              ...summary,
              // How many cues arrived early and how many had to wait for the
              // server. This is the far-plane misprediction rate as the
              // player FELT it, which no correction figure captures: a build
              // that quietly stopped predicting events would be identical in
              // every other column here.
              ...feedbackRef.current.summary(),
              // The two things that make the numbers comparable across
              // reports: which client drew them, and how far the player was
              // from the machine. Neither is derivable server-side.
              platform,
              rallyHits: state.meta.rallyHits,
            },
          });
        }

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
  }, [room, mySide, onFinished, platform]);

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  /**
   * Arrow keys, for the desktop clients — `tdesktop` and the browser — where
   * there is no finger to rest on the field.
   *
   * Listening on the window rather than the canvas: a canvas is not focusable
   * without a tabindex, and giving it one would put a focus ring around the
   * field and let a stray Tab steer the paddle to the Leave button instead.
   * Nothing else in this screen takes typed input, so the window is unambiguous.
   *
   * The frame loop does the moving; this only records which way.
   */
  useEffect(() => {
    const keyboard = keyboardRef.current;

    const onKeyDown = (event: KeyboardEvent) => {
      // Arrows scroll the page otherwise, auto-repeats included. Modified
      // arrows are left to the browser — see `keyDown`; swallowing a
      // `Cmd+ArrowLeft` costs a back navigation AND latches a direction macOS
      // never sends a `keyup` for.
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (keyboard.keyDown(event.key, event.repeat, modified)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keyboard.keyUp(event.key);
    };
    const release = () => keyboard.releaseAll();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);

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

  /**
   * Send the invite through Telegram's own chat picker.
   *
   * The primary path, because it is the one that answers the actual question —
   * *who* are you playing — without leaving the app. Telegram draws its chat
   * list over the Mini App; the room stays open underneath, so a host who
   * changes their mind is still sitting in it.
   *
   * The prepared-message id is single-use, so one is minted per tap.
   */
  const sendInvite = useCallback(async () => {
    if (!inviteRoomCode) return;
    setInviteSending(true);
    setInviteError(null);
    try {
      const prepared = await api.prepareInvite(inviteRoomCode);
      const sent = await sharePreparedMessage(prepared.id);
      // `sent === false` is mostly the user closing the picker, which is not
      // an error worth shouting about — but it is worth measuring.
      api.reportEvent(sent ? 'invite_shared' : 'share_message_failed', {
        props: { method: 'picker' },
      });
      if (!sent) setInviteError(null);
    } catch {
      api.reportEvent('share_message_failed', { props: { method: 'picker' } });
      setInviteError(t('home.inviteFailed'));
    } finally {
      setInviteSending(false);
    }
  }, [inviteRoomCode, t]);

  /**
   * The fallback, and only the fallback.
   *
   * `navigator.clipboard` is unavailable or permission-denied inside
   * Telegram's webview on iOS, where this silently did nothing and left a
   * button that looked like it had worked. A failure now says so and points at
   * the link, which is selectable on screen.
   */
  const copyInvite = useCallback(async () => {
    if (!inviteUrl) return;
    setInviteError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      api.reportEvent('invite_shared', { props: { method: 'copy' } });
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      setInviteError(t('home.copyFailed'));
    }
  }, [inviteUrl, t]);

  const paused = phase === Phase.PAUSED;
  /** Whether this Telegram can show the picker, and we have a room to invite to. */
  const canPick = Boolean(inviteRoomCode) && canSharePreparedMessage();

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
        <div className="match__overlay match__overlay--waiting" role="status">
          {/* Two blocks rather than one centred stack: a stack centred on the
              canvas lands on the dashed centre line, which runs straight
              through the hint and makes it unreadable. The lede is pinned to
              the underside of the top score and grows upward, so extra wrapped
              lines can never reach the numeral; the actions are pinned below
              the line and grow down. */}
          <div className="match__overlay-lede">
            <div className="match__overlay-title">{t('home.waitingForOpponent')}</div>
            <div className="match__overlay-text">{t('home.waitingHint')}</div>
          </div>
          <div className="match__overlay-actions">
            {inviteUrl && (
              <>
                {/* One button, because there is one thing to do here: pick who
                    you are playing. A URL on screen is not an action — it is
                    something the host would have to get out of the app by hand,
                    which is the problem the picker exists to solve. */}
                {canPick && (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={inviteSending}
                    onClick={() => void sendInvite()}
                  >
                    {inviteSending ? t('home.inviteSending') : t('home.inviteFriend')}
                  </button>
                )}

                {/* The link appears only when it is the only way left: a
                    Telegram too old for `shareMessage`, or a picker that just
                    failed. Showing it before then is clutter; showing it after
                    is the difference between a dead end and a way out. */}
                {(!canPick || inviteError) && (
                  <>
                    <code className="card__link">{inviteUrl}</code>
                    <button type="button" className="button" onClick={() => void copyInvite()}>
                      {inviteCopied ? t('home.copied') : t('home.copyLink')}
                    </button>
                  </>
                )}

                {inviteError && <p className="error">{inviteError}</p>}
              </>
            )}
          </div>
        </div>
      )}

      <button type="button" className="match__leave" onClick={onLeave}>
        {t('match.leave')}
      </button>
    </div>
  );
}
