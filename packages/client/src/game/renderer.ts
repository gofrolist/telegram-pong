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

export function computeViewport(cssWidth: number, cssHeight: number): Viewport {
  const scale = Math.min(cssWidth / FIELD_W, cssHeight / FIELD_H);
  return {
    scale,
    offsetX: (cssWidth - FIELD_W * scale) / 2,
    offsetY: (cssHeight - FIELD_H * scale) / 2,
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

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
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
  // flip it is always the one at the bottom of the screen.
  const selfIsBottom = !frame.mirrored;
  const paddleHeight = PADDLE_THICKNESS * scale;
  const paddleWidth = PADDLE_HALF_W * 2 * scale;
  const radius = paddleHeight / 2;

  context.fillStyle = selfIsBottom ? theme.self : theme.opponent;
  roundedRect(
    context,
    px(frame.bottomX) - paddleWidth / 2,
    py(BOTTOM_PLANE_Y) - paddleHeight / 2,
    paddleWidth,
    paddleHeight,
    radius,
  );

  context.fillStyle = selfIsBottom ? theme.opponent : theme.self;
  roundedRect(
    context,
    px(frame.topX) - paddleWidth / 2,
    py(TOP_PLANE_Y) - paddleHeight / 2,
    paddleWidth,
    paddleHeight,
    radius,
  );

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
