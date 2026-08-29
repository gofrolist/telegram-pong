/**
 * Funnel instrumentation.
 *
 * Every step from launch to rematch is logged, because without them the
 * product's two questions — does this make someone more likely to invite
 * another person, and does it still hold with a second game — cannot be
 * answered, and the whole project becomes unfalsifiable.
 *
 * Writes are batched and fire-and-forget. An analytics insert must never delay
 * a match, and never fail one: `recordEvent` cannot reject.
 */

import type { AnalyticsPayload } from '@pong/game-core';

import { db, tryWrite } from './db/client.js';
import { events } from './db/schema.js';

type EventRow = typeof events.$inferInsert;

const queue: EventRow[] = [];
/** Above this the queue is drained immediately rather than waiting for the timer. */
const FLUSH_AT = 50;
/** And in any case every few seconds, so a quiet period still lands. */
const FLUSH_INTERVAL_MS = 5000;
/** Beyond this the oldest rows are dropped: losing analytics beats OOM. */
const MAX_QUEUE = 5000;

let timer: NodeJS.Timeout | null = null;
let flushing = false;

export async function recordEvent(payload: AnalyticsPayload): Promise<void> {
  queue.push({
    name: payload.name,
    userId: payload.userId ?? null,
    chatInstance: payload.chatInstance ?? null,
    game: payload.game ?? null,
    roomId: payload.roomId ?? null,
    matchId: payload.matchId ?? null,
    props: payload.props ?? null,
  });

  if (queue.length > MAX_QUEUE) {
    queue.splice(0, queue.length - MAX_QUEUE);
  }
  if (queue.length >= FLUSH_AT) {
    await flushEvents();
  }
}

export async function flushEvents(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    await tryWrite('analytics flush', () => db.insert(events).values(batch));
  } finally {
    flushing = false;
  }
}

export function startAnalyticsFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushEvents();
  }, FLUSH_INTERVAL_MS);
  // Do not hold the process open for the sake of an analytics timer.
  timer.unref?.();
}

export async function stopAnalyticsFlusher(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flushEvents();
}
