/**
 * Seeded PRNG for the simulation.
 *
 * `Math.random()` must never appear in a tick: rollback replays the same tick
 * many times, and an unseeded source would produce a different world on every
 * replay, which surfaces as a permanent visible stutter.
 *
 * This is mulberry32 — 32-bit integer arithmetic only, so it is bit-identical
 * on every JavaScript engine. The generator is *stateless*: the caller owns
 * the state word (it lives in `MetaLike.rng` and is therefore part of the
 * replicated state and of every rollback snapshot).
 */

/** Advance the state word. Pure: returns the next state. */
export function nextState(state: number): number {
  return (state + 0x6d2b79f5) | 0;
}

/**
 * Derive a uniform float in [0, 1) from a state word.
 *
 * Call {@link nextState} first, then pass the *new* state here, so that a
 * given state word is never consumed twice.
 */
export function toFloat(state: number): number {
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Advance the state and return `[nextState, uniform float in [0,1))`. */
export function nextFloat(state: number): [number, number] {
  const s = nextState(state);
  return [s, toFloat(s)];
}

/** Advance the state and return `[nextState, integer in [0, bound))`. */
export function nextInt(state: number, bound: number): [number, number] {
  const [s, f] = nextFloat(state);
  return [s, Math.floor(f * bound)];
}

/**
 * Turn an arbitrary string (a room code) into a seed word.
 *
 * FNV-1a, so two rooms created in the same millisecond still diverge.
 */
export function seedFromString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
