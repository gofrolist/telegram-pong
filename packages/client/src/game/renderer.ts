/**
 * Canvas renderer.
 *
 * Canvas 2D rather than React: at 60–120 fps, reconciling a virtual DOM per
 * frame is the single most expensive thing a Mini App can do on a mid-range
 * Android phone, and none of what moves here is a component.
 *
 * The renderer holds no game state. It is handed a smoothed snapshot from the
 * prediction adapter and draws it. Nothing in this file may ever change the
 * simulation.
 */

import {
  BALL_RADIUS,
  BOTTOM_PLANE_Y,
  FIELD_H,
  FIELD_W,
  PADDLE_ARC_R,
  PADDLE_BULGE,
  PADDLE_HALF_W,
  PADDLE_THICKNESS,
  TOP_PLANE_Y,
} from '@pong/game-core';

export interface Theme {
  background: string;
  line: string;
  ball: string;
  self: string;
  opponent: string;
  text: string;
}

export interface Frame {
  ballX: number;
  ballY: number;
  bottomX: number;
  topX: number;
  scoreSelf: number;
  scoreOpponent: number;
  /**
   * True when the local player defends the *top* of the field.
   *
   * Both players see themselves at the bottom of their own screen, because a
   * paddle you steer with your thumb has to be near your thumb. The flip is
   * purely visual: the simulation is never mirrored, since a mirrored
   * simulation would not be the same simulation and rollback would fight it.
   */
  mirrored: boolean;
  /** Countdown numeral to overlay, or 0 for none. */
  countdown: number;
  dimmed: boolean;
}

/** Maps field units to device pixels, preserving the field's aspect ratio. */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  cssWidth: number;
  cssHeight: number;
}

/**
 * CSS pixels of leftover height to hand to the thumb instead of splitting it
 * evenly above and below the field.
 *
 * The field is 100x180 and almost every phone is taller than that, so a
 * centred field leaves a band of dead pixels at each end. Below the field that
 * band is the most valuable space on the screen — it is where the hand steering
 * the bottom paddle can rest without covering it — and above the field it is
 * worth nothing. Roughly the contact patch of a thumb.
 *
 * This is why the fix is here and not in the simulation: moving the paddle up
 * by moving PADDLE_INSET shortens the rally for both players and is replicated
 * to everyone, whereas letterbox is per-device slack that is being thrown away.
 */
const THUMB_RESERVE_PX = 56;
/**
 * Never leave the top paddle closer than this to the top of the canvas — it
 * shares that corner with the leave button.
 */
const MIN_TOP_GAP_PX = 8;

export function computeViewport(cssWidth: number, cssHeight: number): Viewport {
  const scale = Math.min(cssWidth / FIELD_W, cssHeight / FIELD_H);

  // Give the thumb up to THUMB_RESERVE_PX of the letterbox, without crowding
  // the top paddle and without ever pushing the field BELOW centre — on a
  // window tall enough that half the slack already clears the reserve, the
  // honest layout is the centred one.
  const slack = cssHeight - FIELD_H * scale;
  const offsetY = Math.min(slack / 2, Math.max(MIN_TOP_GAP_PX, slack - THUMB_RESERVE_PX));

  return {
    scale,
    offsetX: (cssWidth - FIELD_W * scale) / 2,
    offsetY,
    cssWidth,
    cssHeight,
  };
}

/**
 * Resize the backing store for the device pixel ratio.
 *
 * Without this the field is drawn at CSS resolution and upscaled, which on a
 * 3x phone display turns a crisp ball into a smear.
 */
export function resizeCanvas(canvas: HTMLCanvasElement): Viewport {
  const rect = canvas.getBoundingClientRect();
  // Cap the ratio: a 4x backing store on a large screen quadruples fill cost
  // for a difference nobody can see on a 2mm ball.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext('2d');
  if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0);

  return computeViewport(rect.width, rect.height);
}

/** Convert a pointer X in CSS pixels to a field-unit target for the paddle. */
export function pointerToFieldX(clientX: number, canvas: HTMLCanvasElement, mirrored: boolean): number {
  const rect = canvas.getBoundingClientRect();
  const viewport = computeViewport(rect.width, rect.height);
  const fieldX = (clientX - rect.left - viewport.offsetX) / viewport.scale;
  // A mirrored *view* means the finger's left is the field's right.
  return mirrored ? FIELD_W - fieldX : fieldX;
}

/**
 * Half-angle the paddle's face subtends at the centre of its arc.
 *
 * Renderer-only trigonometry, which is why it is here and not in the
 * simulation: `Math.asin` is implementation-defined and a single call to it
 * inside a tick would be enough to desync the server from an iOS webview. The
 * drawing is free to use it because nothing downstream of a pixel is replayed.
 */
const PADDLE_ARC_HALF_ANGLE = Math.asin(PADDLE_HALF_W / PADDLE_ARC_R);

/**
 * Y of the centre of the circle each paddle's face is cut from, in field
 * units. Mirrors the simulation's own derivation — the point of drawing the
 * arc at all is that it is *the* contact surface, so if these two ever drift
 * apart the ball starts bouncing off nothing.
 */
const BOTTOM_ARC_CY = BOTTOM_PLANE_Y - PADDLE_BULGE + PADDLE_ARC_R;
const TOP_ARC_CY = TOP_PLANE_Y + PADDLE_BULGE - PADDLE_ARC_R;

/**
 * Draw one paddle as the arc the ball actually bounces off.
 *
 * Stroked rather than filled, at `PADDLE_ARC_R - PADDLE_THICKNESS / 2`: a
 * stroke straddles its path, so pulling the path in by half the line width
 * puts the *outer* edge of the drawn bar exactly on the contact radius. The
 * player aiming at the visible surface is aiming at the real one.
 *
 * `arc` with a round `lineCap`, not `roundRect` — which is Safari 16+ and
 * missing from Telegram's webview on iOS 15, where calling it throws inside
 * `requestAnimationFrame` and takes the whole render loop down with it, so the
 * field goes blank and stays blank for the rest of the match.
 *
 * `faceUp` is about the screen, not the field: the local player's paddle is
 * always the one at the bottom of their own screen, and its face always bulges
 * towards the middle, so the mirror flips which way each arc curves.
 */
function drawPaddleArc(
  context: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  scale: number,
  faceUp: boolean,
): void {
  const radius = (PADDLE_ARC_R - PADDLE_THICKNESS / 2) * scale;
  const base = faceUp ? -Math.PI / 2 : Math.PI / 2;

  context.lineWidth = PADDLE_THICKNESS * scale;
  context.lineCap = 'round';
  context.beginPath();
  context.arc(
    centreX,
    centreY,
    radius,
    base - PADDLE_ARC_HALF_ANGLE,
    base + PADDLE_ARC_HALF_ANGLE,
  );
  context.stroke();
}

export function draw(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  frame: Frame,
  theme: Theme,
): void {
  const { scale, offsetX, offsetY, cssWidth, cssHeight } = viewport;

  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = theme.background;
  context.fillRect(0, 0, cssWidth, cssHeight);

  // Field-unit → CSS-pixel projection, with the vertical flip folded in.
  const px = (fx: number) => offsetX + (frame.mirrored ? FIELD_W - fx : fx) * scale;
  const py = (fy: number) => offsetY + (frame.mirrored ? FIELD_H - fy : fy) * scale;

  context.globalAlpha = frame.dimmed ? 0.35 : 1;

  // Centre line.
  context.strokeStyle = theme.line;
  context.lineWidth = Math.max(1, 0.6 * scale);
  context.setLineDash([3 * scale, 3 * scale]);
  context.beginPath();
  context.moveTo(offsetX, offsetY + (FIELD_H / 2) * scale);
  context.lineTo(offsetX + FIELD_W * scale, offsetY + (FIELD_H / 2) * scale);
  context.stroke();
  context.setLineDash([]);

  // Scores, drawn large and faint behind the play so they never need a HUD row
  // competing with the field for vertical space on a narrow screen.
  context.globalAlpha = frame.dimmed ? 0.12 : 0.16;
  context.fillStyle = theme.text;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `700 ${Math.round(22 * scale)}px system-ui, -apple-system, sans-serif`;
  context.fillText(String(frame.scoreOpponent), offsetX + (FIELD_W / 2) * scale, offsetY + FIELD_H * 0.3 * scale);
  context.fillText(String(frame.scoreSelf), offsetX + (FIELD_W / 2) * scale, offsetY + FIELD_H * 0.7 * scale);
  context.globalAlpha = frame.dimmed ? 0.35 : 1;

  // Paddles. `self` is whichever paddle the local player steers — after the
  // flip it is always the one at the bottom of the screen, and the one whose
  // face curves upwards.
  const selfIsBottom = !frame.mirrored;

  context.strokeStyle = selfIsBottom ? theme.self : theme.opponent;
  drawPaddleArc(context, px(frame.bottomX), py(BOTTOM_ARC_CY), scale, !frame.mirrored);

  context.strokeStyle = selfIsBottom ? theme.opponent : theme.self;
  drawPaddleArc(context, px(frame.topX), py(TOP_ARC_CY), scale, frame.mirrored);

  // Ball.
  context.fillStyle = theme.ball;
  context.beginPath();
  context.arc(px(frame.ballX), py(frame.ballY), BALL_RADIUS * scale, 0, Math.PI * 2);
  context.fill();

  context.globalAlpha = 1;

  if (frame.countdown > 0) {
    context.fillStyle = theme.text;
    context.font = `800 ${Math.round(34 * scale)}px system-ui, -apple-system, sans-serif`;
    context.fillText(
      String(frame.countdown),
      offsetX + (FIELD_W / 2) * scale,
      offsetY + (FIELD_H / 2) * scale,
    );
  }
}
