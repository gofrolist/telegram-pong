/**
 * The field's placement inside the canvas.
 *
 * This is the one piece of "move the paddle up" that costs the simulation
 * nothing: the letterbox above and below a 100x180 field on a modern phone is
 * slack the layout was throwing away, and the half below the field is the half
 * the steering hand needs.
 */

import { describe, expect, it } from 'vitest';
import { FIELD_H, FIELD_W, PADDLE_INSET } from '@pong/game-core';

import { computeViewport } from '../src/game/renderer.js';

/** Bottom of the canvas to the plane the bottom paddle's ends sit on. */
function thumbClearance(cssWidth: number, cssHeight: number): number {
  const viewport = computeViewport(cssWidth, cssHeight);
  return cssHeight - (viewport.offsetY + (FIELD_H - PADDLE_INSET) * viewport.scale);
}

describe('computeViewport', () => {
  it('keeps the field inside the canvas and preserves its aspect ratio', () => {
    for (const [w, h] of [
      [390, 760],
      [360, 640],
      [430, 900],
      [1440, 900],
      [320, 320],
    ]) {
      const viewport = computeViewport(w, h);
      expect(viewport.offsetX).toBeGreaterThanOrEqual(0);
      expect(viewport.offsetY).toBeGreaterThanOrEqual(0);
      expect(viewport.offsetX + FIELD_W * viewport.scale).toBeLessThanOrEqual(w + 1e-9);
      expect(viewport.offsetY + FIELD_H * viewport.scale).toBeLessThanOrEqual(h + 1e-9);
    }
  });

  it('spends a phone-shaped letterbox on the thumb rather than splitting it', () => {
    // A 390x760 match area has 58px of slack. Centred, half of that sits above
    // the field doing nothing.
    const viewport = computeViewport(390, 760);
    const slack = 760 - FIELD_H * viewport.scale;
    expect(slack).toBeGreaterThan(40);
    expect(viewport.offsetY).toBeLessThan(slack / 2);
    // …and the paddle ends up meaningfully further from the bottom edge than a
    // centred field would have put it.
    expect(thumbClearance(390, 760)).toBeGreaterThan(760 - (slack / 2 + (FIELD_H - PADDLE_INSET) * viewport.scale));
  });

  it('never crowds the top paddle against the leave button', () => {
    for (const [w, h] of [
      [390, 760],
      [390, 1400],
      [360, 800],
    ]) {
      expect(computeViewport(w, h).offsetY).toBeGreaterThanOrEqual(8 - 1e-9);
    }
  });

  it('stays centred when there is no slack to spend', () => {
    // A 16:9 screen is almost exactly the field's own shape: nothing to give.
    const viewport = computeViewport(360, 640);
    const slack = 640 - FIELD_H * viewport.scale;
    expect(viewport.offsetY).toBeCloseTo(slack / 2, 6);
  });

  it('does not push the field below centre on a tall window', () => {
    // Once half the slack already clears the reserve, the centred layout is
    // the honest one — a desktop tab should not render a top-heavy field.
    const viewport = computeViewport(390, 1400);
    const slack = 1400 - FIELD_H * viewport.scale;
    expect(viewport.offsetY).toBeCloseTo(slack / 2, 6);
  });
});
