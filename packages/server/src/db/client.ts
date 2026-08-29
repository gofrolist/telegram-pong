/**
 * Database access.
 *
 * Two rules, both driven by Neon's scale-to-zero behaviour:
 *
 *  1. **Never block startup on a query.** A cold Neon compute takes seconds to
 *     wake. If the process awaited a query before listening, a deploy after a
 *     quiet night would fail its health check and roll back.
 *  2. **Never query inside a tick.** Everything here is called from HTTP
 *     handlers, from `onJoin`/`onLeave`, or from the post-match writer — never
 *     from `setFixedTimestep`. A 200ms cold query inside the loop would stall
 *     the 30 Hz tick of every live match on the machine.
 *
 * The connection string must be the **pooled** (pgbouncer) one. The direct
 * endpoint caps out at Neon's per-compute connection limit, which one fly
 * machine holding hundreds of rooms will hit.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * `prepare: false` is required against pgbouncer in transaction pooling mode:
 * prepared statements are bound to a backend connection the pooler is free to
 * hand to someone else between statements.
 */
const sql = postgres(config.DATABASE_URL, {
  prepare: false,
  max: 10,
  idle_timeout: 20,
  connect_timeout: 15,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });
export { schema };

/**
 * Warm the pool in the background.
 *
 * Called after the server is already listening, deliberately un-awaited: it
 * turns the first *user's* cold-start penalty into a startup one without ever
 * being able to delay the health check.
 */
export function warmUpInBackground(): void {
  void sql`select 1`.catch((error: unknown) => {
    console.warn('[db] warm-up query failed (this is not fatal):', error);
  });
}

/** For a graceful shutdown. */
export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/**
 * Run a database write that must never take down the caller.
 *
 * Stats, analytics and trace persistence all use this: losing a leaderboard
 * increment is annoying, but throwing out of `onLeave` and killing the room
 * for the other player is worse.
 */
export async function tryWrite<T>(label: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    console.error(`[db] ${label} failed:`, error);
    return null;
  }
}
