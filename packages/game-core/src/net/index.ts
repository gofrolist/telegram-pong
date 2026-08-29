/**
 * `@pong/game-core/net` — the replicated Schema classes.
 *
 * These live beside the simulation, and are imported by BOTH the server room
 * and the Mini App, for one reason: a client-side copy of the state schema
 * that drifts from the server's is a desync that only appears under load and
 * only on the field the two disagree about.
 *
 * This is a **separate entry point** so that importing `@pong/game-core`
 * pulls in the pure, dependency-free simulation and nothing else. Only code
 * that actually talks to Colyseus pays for `@colyseus/schema`.
 *
 * `@colyseus/schema` is pinned to an exact version here and matched exactly by
 * the server. Mixing Colyseus package versions is a documented source of
 * confusing errors, and a schema-version mismatch between the two ends is the
 * worst of them: the wire format changes and the failure surfaces as garbled
 * state rather than as a connection error.
 */

export * from './state.js';
export * from './input.js';

/**
 * Re-exported so the client can tell a decoded schema instance from a locally
 * auto-instantiated placeholder without taking its own direct dependency on
 * `@colyseus/schema` — which would risk a second, differently-versioned copy.
 * Mixing Colyseus package versions is a documented source of confusing errors.
 */
export { $refId } from '@colyseus/schema';
