/**
 * Arrow-key steering: the integration from a held direction to a target.
 *
 * What is worth pinning here is the release, not the travel. A target that
 * outruns the paddle keeps it gliding after the key comes up, and a target
 * left parked inside a wall makes the first fraction of a second of the next
 * press do nothing — two bugs that a player reads as "the controls are laggy"
 * and neither of which shows up in a screenshot. The mirroring is pinned for a
 * different reason: it is only ever wrong for the top player, so half the
 * matches played would be fine.
 */

import { describe, expect, it } from 'vitest';

import { FIELD_W, PADDLE_HALF_W, PADDLE_MAX_SPEED } from '@pong/game-core';

import { PaddleKeyboard } from '../src/game/keyboard.js';

/** One 60fps frame, in seconds. */
const FRAME = 1 / 60;
const MAX_X = FIELD_W - PADDLE_HALF_W;

describe('PaddleKeyboard', () => {
  it('claims only the arrow keys', () => {
    const keyboard = new PaddleKeyboard();
    expect(keyboard.keyDown('ArrowLeft', false)).toBe(true);
    expect(keyboard.keyDown('ArrowRight', false)).toBe(true);
    // Claimed even on a repeat: the auto-repeats scroll the page too.
    expect(keyboard.keyDown('ArrowLeft', true)).toBe(true);
    expect(keyboard.keyDown('ArrowUp', false)).toBe(false);
    expect(keyboard.keyDown('a', false)).toBe(false);
    expect(keyboard.keyUp('Escape')).toBe(false);
  });

  it('leaves the target alone when nothing is held', () => {
    const keyboard = new PaddleKeyboard();
    expect(keyboard.step(50, 20, FRAME, false)).toBe(50);
  });

  it('travels at exactly the speed the server would clamp it to', () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowRight', false);
    // The first step seeds from the paddle, so both are 50 here.
    const after = keyboard.step(50, 50, FRAME, false);
    expect(after).toBeCloseTo(50 + PADDLE_MAX_SPEED * FRAME, 10);
  });

  it('starts from the paddle, not from where the finger left the target', () => {
    const keyboard = new PaddleKeyboard();
    // A drag flung the target at the right wall; the paddle is still at 30.
    keyboard.keyDown('ArrowLeft', false);
    const first = keyboard.step(MAX_X, 30, FRAME, false);
    expect(first).toBeCloseTo(30 - PADDLE_MAX_SPEED * FRAME, 10);
    // Only the first frame of a press seeds; after that it integrates the
    // target it is building, or a slow paddle would drag it backwards.
    const second = keyboard.step(first, 30, FRAME, false);
    expect(second).toBeCloseTo(first - PADDLE_MAX_SPEED * FRAME, 10);
  });

  it('stops dead on release rather than gliding on', () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowRight', false);
    let target = 50;
    let paddle = 50;
    for (let frame = 0; frame < 12; frame += 1) {
      target = keyboard.step(target, paddle, FRAME, false);
      // The paddle can always make the move, because the target never asks
      // for more than PADDLE_MAX_SPEED.
      paddle = target;
    }
    keyboard.keyUp('ArrowRight');
    const parked = keyboard.step(target, paddle, FRAME, false);
    expect(parked).toBe(target);
    expect(paddle).toBe(target);
  });

  it('never parks the target inside a wall', () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowRight', false);
    let target = 50;
    // Two full seconds of holding right — far longer than the field is wide.
    for (let frame = 0; frame < 120; frame += 1) {
      target = keyboard.step(target, target, FRAME, false);
    }
    expect(target).toBe(MAX_X);

    // So the very first frame of pressing left moves, instead of spending
    // 200ms unwinding an overshoot nobody can see.
    keyboard.keyUp('ArrowRight');
    keyboard.keyDown('ArrowLeft', false);
    expect(keyboard.step(target, target, FRAME, false)).toBeCloseTo(
      MAX_X - PADDLE_MAX_SPEED * FRAME,
      10,
    );
  });

  it("mirrors the top player, whose left is the field's right", () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowLeft', false);
    expect(keyboard.step(50, 50, FRAME, true)).toBeCloseTo(50 + PADDLE_MAX_SPEED * FRAME, 10);
  });

  it('hands the paddle back to the key still held', () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowRight', false);
    keyboard.keyDown('ArrowLeft', false);
    // Most recent press wins while both are down.
    expect(keyboard.direction).toBe(-1);
    keyboard.keyUp('ArrowLeft');
    expect(keyboard.direction).toBe(1);
    keyboard.keyUp('ArrowRight');
    expect(keyboard.direction).toBe(0);
  });

  it('forgets everything when the window takes the focus away', () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowRight', false);
    keyboard.releaseAll();
    expect(keyboard.direction).toBe(0);
    expect(keyboard.step(50, 50, FRAME, false)).toBe(50);
  });

  it('caps a backgrounded tab rather than flinging the paddle into the wall', () => {
    const keyboard = new PaddleKeyboard();
    keyboard.keyDown('ArrowRight', false);
    // Five seconds of `dt`, as a tab that was hidden with the key held gets.
    const after = keyboard.step(50, 50, 5, false);
    expect(after).toBeCloseTo(50 + PADDLE_MAX_SPEED * 0.1, 10);
    expect(after).toBeLessThan(MAX_X);
  });
});
