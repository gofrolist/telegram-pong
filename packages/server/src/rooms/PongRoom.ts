/**
 * The Pong room.
 *
 * This class and `@pong/game-core` are the only two places in the codebase
 * that know Pong exists. Auth, invites, sharing, stats and i18n are all
 * game-agnostic; adding a second game means adding a sibling of this file and
 * a `defineRoom()` entry, and touching none of them.
 *
 * Netcode shape:
 *   - 30 Hz fixed timestep via `setFixedTimestep`, which is also what the
 *     framework advertises to predicting clients in the join handshake.
 *   - `patchRate` pinned to the same 33.33ms. Colyseus' default is 50ms; a
 *     patch rate that does not divide the tick rate produces a visible
 *     beat-frequency judder in the ball.
 *   - One input consumed per client per step (`inputs.get(sid).next()`), then
 *     one shared-world step. Draining the buffer and applying only the newest
 *     would advance the reconcile ack past inputs the server never simulated,
 *     and the client would roll back to a state it can't reproduce.
 *   - That consume runs on EVERY tick, in every phase, including WAITING and
 *     PAUSED. It is the client's ack clock, not just a gameplay step: a tick
 *     that consumes nothing acks nothing, so a phase that skips the consume
 *     lets the client's unacked queue grow until the 64-slot buffer overflows.
 *     Past that the ack advances only by dropping the oldest input, which
 *     pins the queue at the buffer size for the rest of the match — longer
 *     than the client's own 64-entry replay ring, so its oldest unacked inputs
 *     age out and are silently skipped on every rollback. The prediction then
 *     cannot reconstruct server truth at all, and the ball visibly teleports
 *     on every reconcile. A host sits in WAITING for as long as the invite
 *     takes to be answered, so this was the *normal* path for whoever opened
 *     the room.
 */

import { Room, type Client } from '@colyseus/core';
import {
  EndReason,
  FIELD_W,
  OPEN_ROOM_TTL_MS,
  PATCH_RATE_MS,
  Phase,
  RECONNECT_GRACE_SEC,
  SIDE_BOTTOM,
  SIDE_TOP,
  TICK_RATE,
  seedFromString,
  startMatch,
  step,
  type PongWorld,
  type Side,
} from '@pong/game-core';

import { config } from '../config.js';
import { PongInput, PongState, PlayerInfo } from '@pong/game-core/net';
import { recordEvent } from '../analytics.js';
import { finishMatch, markRoomFilled, markRoomStatus } from '../matchWriter.js';
import { notifyOpponentWaiting } from '../telegram/notify.js';
import { verifySessionToken, type SessionToken } from '../telegram/initData.js';
import { TraceRecorder } from '../antiCheat/traceRecorder.js';

export interface PongJoinOptions {
  /** Our short-lived session token, issued by `POST /api/auth`. */
  token: string;
}

/** What `onAuth` hands to `onJoin`. */
export interface PongAuthContext {
  userId: number;
  name: string;
  username?: string;
  photoUrl?: string;
  languageCode?: string;
  chatInstance: string | null;
  chatType: string | null;
  isPremium: boolean;
}

export interface PongRoomCreateOptions {
  /** Public room code, `<machineId>-<code>`. */
  roomCode: string;
  hostUserId: number;
  chatInstance: string | null;
  /** Set when this room was opened from a "Rematch" button. */
  rematchOfMatchId?: string | null;
  /** Only this user may take the second slot, for a rematch invite. */
  expectedGuestUserId?: number | null;
}

/**
 * Room type descriptor. Colyseus 0.18 parameterises `Room` by a shape rather
 * than by the state class alone, so the state, the client type and the input
 * schema are all inferred from one place.
 */
interface PongRoomType {
  state: PongState;
  input: PongInput;
}

export class PongRoom extends Room<PongRoomType> {
  maxClients = 2;

  /**
   * The room outlives an empty seat on purpose. With no AI opponent, an invite
   * dropped into a chat is frequently tapped an hour later; a room that
   * disposed the moment its creator closed the app would make most invites
   * fail silently. Disposal is driven by an explicit timer instead.
   */
  autoDispose = false;

  /**
   * Anti-cheat: a client that floods the socket is disconnected rather than
   * served. Inputs ride their own channel and are not counted here; this caps
   * the ordinary message channel (`ready`, `rematch`, ...).
   */
  maxMessagesPerSecond = 20;

  state = new PongState();

  /**
   * Per-client input buffer.
   *
   * `sanitize` clamps `targetX` into the field before the value is ever seen
   * by the simulation — the first line of the anti-cheat, applied by the
   * framework rather than by us remembering to call it.
   *
   * NO `idle` policy, deliberately. `idle: true` does not repeat the previous
   * input — it synthesizes a frame of schema ZERO values, so every tick that
   * found an empty buffer (ordinary mobile jitter) set `targetX = 0` and slid
   * the paddle towards the left wall at the full speed cap. The client, which
   * predicts with the target it actually sent, cannot reproduce that, and the
   * paddle they disagree about is the one the ball bounces off.
   *
   * Holding the previous target is what we wanted, and it needs no policy at
   * all: `targetX` is state, so a tick that consumes nothing simply leaves it
   * where the last real input put it. See {@link fixedStep}.
   */
  inputs = this.defineInput(PongInput, {
    bufferMaxSize: 64,
    sanitize: { targetX: [0, FIELD_W] },
  });

  private options!: PongRoomCreateOptions;
  private seed = 0;
  private startedAt = 0;
  private longestRally = 0;
  private matchWritten = false;
  /** Set the first time a non-host takes the open slot. */
  private guestArrived = false;
  private disposeTimer: NodeJS.Timeout | null = null;
  private trace!: TraceRecorder;

  /** sessionId → side. Rebuilt on reconnect so a returning player keeps their end. */
  private sideBySession = new Map<string, Side>();
  /** userId → side, so a reconnecting client is reseated on the same side. */
  private sideByUser = new Map<number, Side>();

  /**
   * Authenticate before the room is entered.
   *
   * `static` so it runs before a room instance is even resolved — a rejected
   * client never occupies a seat, never triggers `onJoin`, and never costs a
   * tick.
   *
   * The token here is *ours*, not raw `initData`. `initData` is validated once
   * at `POST /api/auth` and exchanged for a short-lived token; see
   * `telegram/initData.ts` for why re-accepting `initData` on every socket
   * would leave a day-long replay window open.
   */
  static async onAuth(token: string, options: PongJoinOptions): Promise<PongAuthContext> {
    // The framework reads `token` from the Authorization header (the SDK sets
    // it from `client.auth.token`). Join options are accepted as a fallback so
    // a caller that cannot set headers is still able to authenticate.
    const session: SessionToken | null =
      verifySessionToken(token) ?? verifySessionToken(options?.token);
    if (!session) {
      throw new Error('unauthorized');
    }
    return {
      userId: session.uid,
      name: session.n,
      username: session.u,
      photoUrl: session.p,
      languageCode: session.l,
      chatInstance: session.ci,
      chatType: session.ct,
      isPremium: session.pr,
    };
  }

  onCreate(options: PongRoomCreateOptions): void {
    this.options = options;
    this.seed = seedFromString(options.roomCode);

    this.state.roomCode = options.roomCode;
    this.state.origin = 'invite';
    this.state.meta.phase = Phase.WAITING;
    this.state.meta.rng = this.seed;

    this.trace = new TraceRecorder(TICK_RATE);

    // Pin the patch rate to the tick. Leaving Colyseus' 50ms default against a
    // 33.33ms tick means a patch lands after one tick, then after two, in a
    // repeating 3:2 pattern — which the eye reads as the ball hitching.
    this.patchRate = PATCH_RATE_MS;

    // `tickRate` here is the single source of the simulation rate: it is
    // advertised to predicting clients so their rollback replays at the same
    // dt. It must not be duplicated in `defineInput`.
    this.setFixedTimestep((ctx) => this.fixedStep(ctx.dt), TICK_RATE);

    // Rooms are asynchronous: an unfilled room lives about an hour, then
    // closes itself.
    this.disposeTimer = setTimeout(() => {
      if (this.state.meta.phase === Phase.WAITING) {
        void markRoomStatus(options.roomCode, 'closed');
        this.disconnect();
      }
    }, OPEN_ROOM_TTL_MS);

    void recordEvent({
      name: 'room_created',
      userId: options.hostUserId,
      chatInstance: options.chatInstance,
      game: 'pong',
      roomId: options.roomCode,
      props: { rematch: Boolean(options.rematchOfMatchId) },
    });
  }

  async onJoin(client: Client, _options: PongJoinOptions, auth: PongAuthContext): Promise<void> {
    // A rematch invite is addressed to one person; anyone else who taps the
    // link finds the seat taken rather than hijacking the match.
    const expected = this.options.expectedGuestUserId;
    if (
      expected &&
      auth.userId !== expected &&
      auth.userId !== this.options.hostUserId &&
      !this.sideByUser.has(auth.userId)
    ) {
      throw new Error('room_reserved');
    }

    const side = this.assignSide(auth.userId);
    this.sideBySession.set(client.sessionId, side);

    const info = new PlayerInfo();
    info.sessionId = client.sessionId;
    info.userId = String(auth.userId);
    info.name = auth.name;
    info.photoUrl = auth.photoUrl ?? '';
    info.side = side;
    info.connected = true;
    this.state.players.set(client.sessionId, info);

    // The guest taking the open slot is what "someone joined" means — it does
    // NOT require the host to still be connected, and the host being away is
    // precisely the case this notification exists for. With no AI opponent an
    // invite is often tapped an hour later, by which point the inviter has
    // closed the app and would otherwise never learn anyone showed up.
    if (auth.userId !== this.options.hostUserId && !this.guestArrived) {
      this.guestArrived = true;
      void recordEvent({
        name: 'opponent_joined',
        userId: auth.userId,
        chatInstance: this.options.chatInstance,
        game: 'pong',
        roomId: this.state.roomCode,
      });
      // Both touch the network and the database, so they run off the tick.
      void markRoomFilled(this.state.roomCode, auth.userId);
      if (!this.isHostConnected()) {
        void notifyOpponentWaiting(this.options.hostUserId, this.state.roomCode, auth.userId);
      }
    }

    if (this.state.players.size === 2 && this.state.meta.phase === Phase.WAITING) {
      this.beginMatch();
    }
  }

  /** Is the room's host currently in the room? */
  private isHostConnected(): boolean {
    const hostSide = this.sideByUser.get(this.options.hostUserId);
    if (hostSide === undefined) return false;
    for (const [, info] of this.state.players) {
      if (info.userId === String(this.options.hostUserId) && info.connected) return true;
    }
    return false;
  }

  /**
   * A client dropped. Do not tear anything down yet.
   *
   * Colyseus owns the grace period — hand-rolling one alongside
   * `allowReconnection` produces two timers that disagree, and the loser
   * decides whether the match survives.
   */
  async onDrop(client: Client): Promise<void> {
    const info = this.state.players.get(client.sessionId);
    if (info) info.connected = false;

    const wasPlaying =
      this.state.meta.phase === Phase.PLAYING || this.state.meta.phase === Phase.COUNTDOWN;
    if (wasPlaying) {
      // Freeze for BOTH players. Letting the connected player keep rallying
      // against a frozen paddle would hand them free points.
      this.state.meta.phase = Phase.PAUSED;
    }

    // Is there a match to lose? A host who opens a room and closes the app
    // while waiting for someone to tap the invite has not forfeited anything —
    // and ending the "match" here would put the room in `ENDED` for good, so
    // the invite tapped an hour later (the case this room exists to serve)
    // would land in a dead room that never starts.
    const matchLive = this.matchStarted();

    void recordEvent({
      name: 'disconnect',
      userId: Number(info?.userId ?? 0) || undefined,
      game: 'pong',
      roomId: this.state.roomCode,
      props: { phase: this.state.meta.phase },
    });

    if (matchLive) this.startReconnectCountdown();

    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SEC);
      // Resolved: `onReconnect` has already run.
    } catch {
      // The grace period elapsed. The player who stayed takes the match.
      this.stopReconnectCountdown();
      if (info && matchLive) {
        const side = this.sideBySession.get(client.sessionId);
        const winnerSide: Side | null =
          side === undefined ? null : side === SIDE_BOTTOM ? SIDE_TOP : SIDE_BOTTOM;
        await this.endMatch(EndReason.DISCONNECT, winnerSide);
      }
    }
  }

  /**
   * Has a match actually begun in this room?
   *
   * `startedAt` is stamped by {@link beginMatch} and by nothing else, so this
   * is false for a room that is still waiting on its second player.
   */
  private matchStarted(): boolean {
    return this.startedAt !== 0 && this.state.meta.phase !== Phase.ENDED;
  }

  onReconnect(client: Client): void {
    this.stopReconnectCountdown();
    const info = this.state.players.get(client.sessionId);
    if (info) {
      info.connected = true;
      info.reconnectSecondsLeft = 0;
    }

    if (this.state.meta.phase === Phase.PAUSED && this.everyoneConnected()) {
      // Resume through a countdown, never straight back into a live ball: the
      // returning player has been looking at a frozen screen and needs the
      // same beat to find their paddle that a serve gives them.
      this.state.meta.phase = Phase.COUNTDOWN;
      this.state.meta.countdown = TICK_RATE * 2;
    }

    void recordEvent({
      name: 'reconnected',
      userId: Number(info?.userId ?? 0) || undefined,
      game: 'pong',
      roomId: this.state.roomCode,
    });
  }

  async onLeave(client: Client, code: number): Promise<void> {
    // `onDrop` handles unintentional disconnects; this only fires for a
    // consented leave, or after the grace period has already expired.
    const consented = code === 1000;
    const info = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);

    // Only a live match can be forfeited. A host who backs out of the room
    // they just opened, before anyone has taken the invite, leaves an open
    // room behind — not an `ENDED` one that every later invitee bounces off.
    if (consented && info && !this.matchWritten && this.matchStarted()) {
      const side = this.sideBySession.get(client.sessionId);
      const winnerSide: Side | null =
        side === undefined ? null : side === SIDE_BOTTOM ? SIDE_TOP : SIDE_BOTTOM;
      await this.endMatch(EndReason.FORFEIT, winnerSide);
    }

    this.sideBySession.delete(client.sessionId);
  }

  onDispose(): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    void markRoomStatus(this.state.roomCode, 'closed');
  }

  // ---------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------

  /**
   * One fixed step. Nothing in here may block, allocate per-tick, or touch the
   * database — a 200ms cold Neon query here would stall every live match on
   * the machine, not just this one.
   */
  private fixedStep(dt: number): void {
    const world = this.world();

    // Consume exactly one input per player per step, in EVERY phase — see the
    // class comment for why the buffer must never be left unattended.
    //
    // A tick that consumes nothing also acks nothing, and holding the target
    // is free: `targetX` is state, so leaving it alone IS repeating the last
    // command. Movement is gated inside `step`, which advances no paddle while
    // the room is waiting or paused, so applying a target here is safe in
    // every phase and the paddle is already lined up when play resumes.
    for (const [sessionId, side] of this.sideBySession) {
      const command = this.inputs.get(sessionId).next();
      if (!command) continue;
      const paddle = side === SIDE_BOTTOM ? this.state.bottom : this.state.top;
      // `sanitize` already clamped this to the field; `applyInput` inside
      // game-core clamps again to the *paddle* range, which is narrower.
      paddle.targetX = command.targetX;
    }

    const rallyBefore = this.state.meta.rallyHits;
    step(world, dt);
    if (rallyBefore > this.longestRally) this.longestRally = rallyBefore;

    if (this.state.meta.phase === Phase.PLAYING) {
      this.trace.record(
        this.state.meta.tick,
        this.state.bottom.targetX,
        this.state.top.targetX,
        this.state.ball.x,
        this.state.ball.y,
      );
    }

    if (this.state.meta.phase === Phase.ENDED && !this.matchWritten) {
      const winnerSide: Side =
        this.state.meta.scoreBottom > this.state.meta.scoreTop ? SIDE_BOTTOM : SIDE_TOP;
      // Fire-and-forget: persistence must never be awaited from inside a tick.
      void this.endMatch(EndReason.SCORE, winnerSide);
    }
  }

  /**
   * A `PongWorld` view over the replicated state.
   *
   * No copying: `PongState` already satisfies the interface structurally, so
   * the shared simulation mutates the Schema in place and every change is
   * picked up by the encoder on the next patch.
   */
  private world(): PongWorld {
    return this.state as unknown as PongWorld;
  }

  // ---------------------------------------------------------------------
  // Match lifecycle
  // ---------------------------------------------------------------------

  private assignSide(userId: number): Side {
    const existing = this.sideByUser.get(userId);
    if (existing !== undefined) return existing;

    // The host prefers the bottom, which is the near edge on their own phone.
    // Both players see themselves at the bottom; the client mirrors.
    const preferred: Side = userId === this.options.hostUserId ? SIDE_BOTTOM : SIDE_TOP;
    const other: Side = preferred === SIDE_BOTTOM ? SIDE_TOP : SIDE_BOTTOM;

    // The preference is not a guarantee: nothing reserves the host's seat, so
    // if the host never connects, two guests tapping the same invite would
    // both be handed the top paddle — the bottom one would then never move,
    // the room would have no bottom player to write a result for, and the
    // match would silently evaporate. Take whichever end is actually free.
    for (const candidate of [preferred, other]) {
      if (this.userIdForSide(candidate) === null) {
        this.sideByUser.set(userId, candidate);
        return candidate;
      }
    }
    throw new Error('room_full');
  }

  private everyoneConnected(): boolean {
    for (const [, info] of this.state.players) {
      if (!info.connected) return false;
    }
    return this.state.players.size === 2;
  }

  private beginMatch(): void {
    this.startedAt = Date.now();
    startMatch(this.world(), this.seed, SIDE_BOTTOM);
    this.trace.reset();

    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    // From here on the room is a live match: if both players vanish, let it go.
    this.autoDispose = true;

    void recordEvent({
      name: 'match_started',
      userId: this.options.hostUserId,
      chatInstance: this.options.chatInstance,
      game: 'pong',
      roomId: this.state.roomCode,
    });
  }

  /**
   * Persist the result and freeze the room.
   *
   * Only the server ever writes a result — there is no message a client can
   * send that reaches this function.
   */
  private async endMatch(reason: number, winnerSide: Side | null): Promise<void> {
    if (this.matchWritten) return;
    this.matchWritten = true;

    this.state.meta.phase = Phase.ENDED;
    this.state.meta.endReason = reason;
    this.stopReconnectCountdown();

    const bottomUser = this.userIdForSide(SIDE_BOTTOM);
    const topUser = this.userIdForSide(SIDE_TOP);
    if (bottomUser === null || topUser === null) {
      // A room that never filled has no match to write.
      return;
    }

    const rally = Math.max(this.longestRally, this.state.meta.rallyHits);
    const winnerId =
      winnerSide === null ? null : winnerSide === SIDE_BOTTOM ? bottomUser : topUser;

    const matchId = await finishMatch({
      roomCode: this.state.roomCode,
      colyseusRoomId: this.roomId,
      game: 'pong',
      origin: 'invite',
      seed: this.seed,
      chatInstance: this.options.chatInstance,
      playerAId: bottomUser,
      playerBId: topUser,
      scoreA: this.state.meta.scoreBottom,
      scoreB: this.state.meta.scoreTop,
      winnerId,
      endReason:
        reason === EndReason.SCORE ? 'score' : reason === EndReason.DISCONNECT ? 'disconnect' : 'forfeit',
      longestRally: rally,
      durationMs: this.startedAt ? Date.now() - this.startedAt : 0,
      startedAt: new Date(this.startedAt || Date.now()),
      trace: this.trace.snapshot(),
      chatLeaderboardsEnabled: config.CHAT_LEADERBOARDS_ENABLED,
    });

    if (matchId) {
      this.state.matchId = matchId;
      void recordEvent({
        name: 'match_completed',
        userId: winnerId ?? bottomUser,
        chatInstance: this.options.chatInstance,
        game: 'pong',
        roomId: this.state.roomCode,
        matchId,
        props: {
          scoreA: this.state.meta.scoreBottom,
          scoreB: this.state.meta.scoreTop,
          reason: reason,
          longestRally: rally,
        },
      });
    }
  }

  private userIdForSide(side: Side): number | null {
    for (const [userId, assigned] of this.sideByUser) {
      if (assigned === side) return userId;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Reconnection countdown (display only — the framework owns the real timer)
  // ---------------------------------------------------------------------

  private reconnectInterval: ReturnType<typeof this.clock.setInterval> | null = null;

  private startReconnectCountdown(): void {
    this.stopReconnectCountdown();
    let remaining = RECONNECT_GRACE_SEC;
    for (const [, info] of this.state.players) info.reconnectSecondsLeft = remaining;

    // `clock.setInterval` rather than a bare `setInterval`: the room clock is
    // paused and cleaned up with the room, so this cannot outlive it.
    this.reconnectInterval = this.clock.setInterval(() => {
      remaining -= 1;
      for (const [, info] of this.state.players) {
        info.reconnectSecondsLeft = remaining > 0 ? remaining : 0;
      }
      if (remaining <= 0) this.stopReconnectCountdown();
    }, 1000);
  }

  private stopReconnectCountdown(): void {
    if (this.reconnectInterval) {
      this.reconnectInterval.clear();
      this.reconnectInterval = null;
    }
    for (const [, info] of this.state.players) info.reconnectSecondsLeft = 0;
  }
}
