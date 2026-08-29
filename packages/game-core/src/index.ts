/**
 * `@pong/game-core` — the simulation both the server and the client run.
 *
 * The backend is TypeScript for exactly one reason: rollback reconciliation is
 * only silent when both sides execute the *same* code, so the simulation ships
 * as a workspace package imported by `@pong/server` and `@pong/client` alike.
 *
 * Adding a second game to the platform means adding a sibling module here, a
 * Room class, and a React component — and touching nothing in auth, invites,
 * sharing, stats or i18n.
 */

export * from './constants.js';
export * from './types.js';
export * from './rng.js';
export * from './sim.js';

// Platform-shared (game-agnostic) helpers. These live here rather than in a
// fourth workspace package because `game-core` is the only package both the
// server and the client already depend on; they are deliberately kept in a
// separate directory so the boundary stays visible.
export * from './platform/invite.js';
export * from './platform/events.js';
