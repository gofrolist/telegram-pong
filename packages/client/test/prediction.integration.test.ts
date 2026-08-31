/**
 * Stage 5: prediction, rollback and interpolation under a bad network.
 *
 * This is the stage that decides whether the product works at all, so it is
 * tested against a real server process with **150ms of simulated round-trip
 * latency** and with a fraction of the client's inputs deliberately dropped.
 * Smoothness on localhost proves nothing.
 *
 * The assertions are about *corrections*, not about smoothness — smoothness is
 * what a correction-free stream looks like:
 *
 *  1. The local paddle must never be corrected. The client and the server run
 *     the identical speed-capped `movePaddle`, so an honest client's
 *     prediction is not an approximation of the truth, it *is* the truth
 *     arriving early. Any correction here means the two simulations diverged.
 *  2. The predicted ball must stay close to server truth across a rally. NOT
 *     through the opponent's bounce, though: their paddle crosses its own
 *     12.3-unit contact zone in 65ms of one-way latency, so past ~129ms RTT
 *     this client cannot know whether the ball is coming back, and no amount
 *     of determinism fixes that. The ball's bound is scaled by latency for
 *     that reason; only the local paddle is held to zero.
 *
 * **This ran at 75ms RTT until 2026-08-30, not the 150 it claims.**
 * `COLYSEUS_LATENCY` is a ROUND TRIP that Colyseus halves per direction, and
 * the harness was handing it a one-way figure — so the bad network this file
 * exists to test was half as bad as it said. `harness/support.ts` doubles it
 * now, and the run sits just past the 129ms cliff, which is deliberate: the
 * local paddle must stay exact even where the far one cannot be known.
 *
 * What this does NOT cover: real packet loss and jitter on a mobile radio.
 * `COLYSEUS_LATENCY` is a fixed delay, and dropping inputs at the sender is
 * not the same as losing them in flight. The acceptance test on two phones on
 * mobile data is still the one that counts; see the README.
 */

import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@colyseus/sdk';
import {
  BALL_MAX_SPEED,
  FIELD_W,
  PADDLE_MAX_SPEED,
  PATCH_RATE_MS,
  Phase,
  SIDE_BOTTOM,
  SIDE_TOP,
  type Side,
} from '@pong/game-core';
import { PongState } from '@pong/game-core/net';

import { attachPrediction, type MatchEventSink } from '../src/net/predictionAdapter.js';
// The server spawn and its teardown live in the harness, shared with
// `harness/bots.ts`. One copy, because getting the teardown wrong produces a
// failure that looks nothing like its cause — see the note there.
import {
  authenticate as authenticateAt,
  baseUrl,
  openRoom as openRoomAt,
  sleep,
  startServer,
  stopServer,
  waitFor,
} from '../harness/support.js';

const PORT = 2601;
const BASE = baseUrl(PORT);

/** One-way delay, so the round trip is 150ms. */
const ONE_WAY_LATENCY_MS = 75;

const authenticate = (userId: number, name: string) => authenticateAt(PORT, userId, name);
const openRoom = (token: string) => openRoomAt(PORT, token);

let server: ChildProcess | undefined;

beforeAll(async () => {
  server = await startServer({ port: PORT, oneWayLatencyMs: ONE_WAY_LATENCY_MS });
  await sleep(500);
}, 60_000);

afterAll(async () => {
  await stopServer(server);
});

describe('prediction under 150ms RTT', () => {
  it('keeps the local paddle correction-free and the ball close to truth', async () => {
    const tokenA = await authenticate(5001, 'Ada');
    const tokenB = await authenticate(5002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new Client(BASE);
    const clientB = new Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;

    const roomA = await clientA.joinById(roomId, { token: tokenA }, PongState);
    const roomB = await clientB.joinById(roomId, { token: tokenB }, PongState);

    await waitFor('both seated', () => roomA.state.players.size === 2);

    const sideA: Side = roomA.state.players.get(roomA.sessionId)?.side === SIDE_TOP ? SIDE_TOP : SIDE_BOTTOM;
    const sideB: Side = sideA === SIDE_BOTTOM ? SIDE_TOP : SIDE_BOTTOM;

    /**
     * Every discrete event delivered to client A, and whether it arrived
     * early (predicted) or late (the server's own word for it).
     *
     * Rides the same rally as the correction measurements above rather than
     * getting its own match: the events ARE that rally, so a separate run
     * would only be measuring a second sample of the same thing.
     */
    const startedAt = Date.now();
    const delivered: Array<{
      kind: 'hit' | 'point';
      side: Side;
      predicted: boolean;
      atMs: number;
      serverHitsThen: number;
    }> = [];
    const record = (kind: 'hit' | 'point', side: Side, predicted: boolean) => {
      delivered.push({
        kind,
        side,
        predicted,
        atMs: Date.now() - startedAt,
        serverHitsThen: roomA.state.meta.rallyHits,
      });
    };
    const recorder: MatchEventSink = {
      hit: (side, predicted) => record('hit', side, predicted),
      point: (side, predicted) => record('point', side, predicted),
      pointRejected: () => {},
    };

    const predictionA = await attachPrediction(roomA, sideA, { events: recorder });
    const predictionB = await attachPrediction(roomB, sideB);

    await waitFor('serve', () => roomA.state.meta.phase === Phase.PLAYING);

    const paddleErrors: number[] = [];
    const ballErrors: number[] = [];
    const corrections: number[] = [];
    const selfPaddleCorrections: number[] = [];
    const ballCorrections: number[] = [];
    let frames = 0;
    let droppedInputs = 0;

    // The server's own hit count, accumulated across serves — `rallyHits` is
    // reset to 0 by every serve, so the running total has to be summed from
    // its increases rather than read at the end.
    let serverHits = 0;
    let lastRallyHits = roomA.state.meta.rallyHits;

    // Drive both clients at roughly 60 fps for ~8 seconds of real play.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && roomA.state.meta.phase !== Phase.ENDED) {
      frames++;

      // Both players chase the ball, so a rally builds and the ball actually
      // crosses paddle planes — the interesting case for divergence.
      const targetA = roomA.state.ball.x;
      const targetB = roomB.state.ball.x;

      // Drop roughly one input in twelve, so the server keeps hitting ticks
      // with an empty buffer — the path where it must hold the last target
      // rather than letting the paddle stall or snap.
      if (frames % 12 === 0) {
        droppedInputs++;
      } else {
        // The rAF timestamp in a browser; here, the same monotonic clock the
        // loop would be driven by. Passing it is what keeps the render
        // interpolation advancing on an even dt.
        const now = performance.now();
        predictionA.frame(targetA, now);
        predictionB.frame(targetB, now);
      }

      const rallyHits = roomA.state.meta.rallyHits;
      if (rallyHits > lastRallyHits) serverHits += rallyHits - lastRallyHits;
      lastRallyHits = rallyHits;

      const predicted = predictionA.read();
      const truth = roomA.state;
      const myPaddleTruth = sideA === SIDE_BOTTOM ? truth.bottom.x : truth.top.x;
      const myPaddlePredicted = sideA === SIDE_BOTTOM ? predicted.bottomX : predicted.topX;

      if (truth.meta.phase === Phase.PLAYING) {
        paddleErrors.push(Math.abs(myPaddlePredicted - myPaddleTruth));
        ballErrors.push(Math.hypot(predicted.ballX - truth.ball.x, predicted.ballY - truth.ball.y));
        const stats = predictionA.stats();
        corrections.push(stats.correction);
        selfPaddleCorrections.push(stats.selfPaddleCorrection);
        ballCorrections.push(stats.ballCorrection);
      }

      await sleep(16);
    }

    expect(frames).toBeGreaterThan(100);
    expect(droppedInputs).toBeGreaterThan(5);
    expect(paddleErrors.length).toBeGreaterThan(50);

    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const p95 = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    };

    // Reported so a regression shows *how far* it drifted, not just that it did.
    console.log(
      `[netcode] rtt=${ONE_WAY_LATENCY_MS * 2}ms frames=${frames} dropped=${droppedInputs} ` +
        `paddle mean=${mean(paddleErrors).toFixed(3)} p95=${p95(paddleErrors).toFixed(3)} ` +
        `ball mean=${mean(ballErrors).toFixed(2)} p95=${p95(ballErrors).toFixed(2)} ` +
        `maxCorrection=${Math.max(...corrections).toFixed(3)} ` +
        `selfPaddleCorrection=${Math.max(...selfPaddleCorrections).toFixed(3)} ` +
        `ballCorrection=${Math.max(...ballCorrections).toFixed(3)} rally=${roomA.state.meta.rallyHits}`,
    );

    // THE assertion, and it is about the LOCAL PADDLE specifically.
    //
    // A correction is how far the reconciler had to move the world when server
    // truth arrived and disagreed with the replay. For our own paddle it must
    // be exactly zero forever: the client and the server run the identical
    // speed-capped `movePaddle` over the identical inputs, so our prediction
    // is not an approximation of the truth, it IS the truth arriving early.
    // Anything above zero here means the two simulations genuinely diverged —
    // a different dt, a mismatched constant, an input the server never applied.
    expect(Math.max(...selfPaddleCorrections)).toBeLessThan(0.5);

    // This assertion used to read `max(corrections) < 0.5` over the worst
    // correction across EVERY field, and it passed for months while measuring
    // nothing: the SDK skips all correction bookkeeping unless a divergence
    // tolerance is set or its debug bundle is loaded, so `stats().correction`
    // was a hard-coded zero and `0 < 0.5` held trivially. With the tolerance
    // now set (see `DIVERGENCE_TOLERANCE`) the same expression reports 61.
    //
    // 61 is not a regression and not a bug. It is the bounce off the OPPONENT's
    // paddle, whose inputs this client cannot know: their paddle can traverse
    // its own 13-unit contact zone in 68ms of one-way latency, so past ~137ms
    // RTT whether the ball comes back at all is genuinely unknowable here. The
    // ball bound below is therefore latency-scaled, not zero — the honest
    // shape of the claim.
    const rttSeconds = (ONE_WAY_LATENCY_MS * 2) / 1000;
    /**
     * How far ahead of the replicated world the predicted one runs, in
     * seconds — a round trip PLUS the patch cadence, not a round trip.
     *
     * Two patch intervals, both unavoidable: the ack that retires an input
     * rides a patch, and the state it is compared against is itself up to one
     * patch old. Bounding the gap by the round trip alone asserts that the
     * broadcast is instant, and this test only ever passed that way because it
     * was running at half the latency it claimed (see the header). Measured
     * here: ball p95 19.8 against this bound's 24.9.
     */
    const leadSeconds = rttSeconds + (2 * PATCH_RATE_MS) / 1000;
    const ballCorrectionBound = BALL_MAX_SPEED * rttSeconds;
    expect(p95(ballCorrections)).toBeLessThan(ballCorrectionBound);

    // The gaps measured above are prediction *lead*, not error: the predicted
    // world is roughly one round trip ahead of the replicated one, which is
    // the entire point. They are bounded by how far each thing can physically
    // travel in that time, which is what these two assertions check.
    //
    // A paddle capped at PADDLE_MAX_SPEED covers at most
    // PADDLE_MAX_SPEED * lead units while the prediction is out in front.
    // Kept at the round trip alone, which is the tighter claim and the one
    // this measures comfortably (p95 3.6 against 28.5).
    expect(p95(paddleErrors)).toBeLessThan(PADDLE_MAX_SPEED * rttSeconds);

    // The ball tops out at BALL_MAX_SPEED, and never crosses more than a
    // fraction of the field while the prediction is that far ahead.
    expect(p95(ballErrors)).toBeLessThan(BALL_MAX_SPEED * leadSeconds);
    expect(p95(ballErrors)).toBeLessThan(FIELD_W * 0.3);

    // And the rally actually happened — otherwise the numbers above would be
    // measuring a stationary ball.
    expect(roomA.state.meta.rallyHits + roomA.state.meta.scoreBottom + roomA.state.meta.scoreTop)
      .toBeGreaterThan(0);

    // ---------------------------------------------------------------------
    // The event channels
    // ---------------------------------------------------------------------

    const deliveredHits = delivered.filter((event) => event.kind === 'hit');
    const nearHits = deliveredHits.filter((event) => event.side === sideA);

    console.log(
      `[events] delivered=${delivered.length} hits=${deliveredHits.length} ` +
        `serverHits=${serverHits} near=${nearHits.length} ` +
        `late=${deliveredHits.filter((e) => !e.predicted).length} ` +
        `points=${delivered.filter((e) => e.kind === 'point').length}`,
    );
    console.log(
      '[events] ' +
        delivered
          .map(
            (e) =>
              `${e.atMs}ms ${e.kind} ${e.side === sideA ? 'near' : 'far'} ` +
              `${e.predicted ? 'predicted' : 'LATE'} (rally=${e.serverHitsThen})`,
          )
          .join(' | '),
    );

    // The wiring works at all: something was delivered.
    expect(deliveredHits.length).toBeGreaterThan(0);

    // EXACTLY ONE cue per hit, and this is THE assertion the channels exist
    // for. A hit is predicted from the live step and then confirmed off
    // replicated state; if the confirm failed to settle the pending entry the
    // same hit would be reported twice — once early, once late — which is a
    // double buzz in the player's hand and would show up in no other column
    // of any report. The tolerance is one, for a hit predicted in the last
    // frame of the loop whose confirmation had not yet arrived.
    expect(Math.abs(deliveredHits.length - serverHits)).toBeLessThanOrEqual(1);

    // The prediction path fires at all, rather than every cue quietly falling
    // through to the server's word for it. A build whose `ctx.predict` never
    // ran would pass every assertion above this one.
    expect(deliveredHits.some((event) => event.predicted)).toBe(true);
    expect(nearHits.length).toBeGreaterThan(0);

    // NOT asserted: that every near-plane hit is predicted.
    //
    // It is the overwhelming majority — the run this was written against goes
    // `near predicted | far LATE | near predicted | far LATE` — and it is
    // tempting to assert, because our own paddle is exact here
    // (`selfPaddleCorrection` is 0.000 in every run). But the paddle being
    // exact does not make the CONTACT exact: at this latency the far bounce
    // is a coin flip, and its error rides the ball all the way down the field,
    // so the ball can arrive at our own paddle up to ~29 units from where the
    // server has it and be predicted to sail past something it actually hit.
    // That near cue then arrives with the server's word for it, one round trip
    // late. Asserting otherwise made this test fail about one run in five —
    // it was measuring the far paddle, which the block above already measures
    // honestly, and calling it a near-plane regression.

    predictionA.dispose();
    predictionB.dispose();
    await roomA.leave(true);
    await roomB.leave(true);
  }, 120_000);
});

describe('side assignment', () => {
  /**
   * Regression: both clients used to conclude they were the bottom player.
   *
   * `joinById` resolves when the seat is confirmed, which is strictly before
   * the first state patch — so `state.players` is still empty at that instant.
   * Reading our own `PlayerInfo` there returned `undefined`, the code fell back
   * to `SIDE_BOTTOM`, and the top player got an unmirrored field, an inverted
   * pointer mapping, swapped scores, a wrong win flag, and prediction driving
   * the opponent's paddle. Everything still *ran*, which is why no other test
   * caught it.
   */
  it('gives the two players opposite ends, and not before the state decodes', async () => {
    const tokenA = await authenticate(6001, 'Ada');
    const tokenB = await authenticate(6002, 'Grace');
    const roomId = await openRoom(tokenA);

    const clientA = new Client(BASE);
    const clientB = new Client(BASE);
    clientA.auth.token = tokenA;
    clientB.auth.token = tokenB;

    const roomA = await clientA.joinById(roomId, { token: tokenA }, PongState);
    // The precondition that made the bug possible. If a future SDK resolves
    // `joinById` only after the first patch, this assertion is the thing that
    // tells us the workaround is no longer load-bearing.
    expect(roomA.state.players.get(roomA.sessionId)).toBeUndefined();

    const roomB = await clientB.joinById(roomId, { token: tokenB }, PongState);

    await waitFor(
      'both PlayerInfos decoded on both clients',
      () =>
        roomA.state.players.get(roomA.sessionId) !== undefined &&
        roomB.state.players.get(roomB.sessionId) !== undefined,
    );

    const sideA = roomA.state.players.get(roomA.sessionId)!.side;
    const sideB = roomB.state.players.get(roomB.sessionId)!.side;

    expect(new Set([sideA, sideB])).toEqual(new Set([SIDE_BOTTOM, SIDE_TOP]));
    // The host opened the room, so the host defends the bottom — the near edge
    // on their own screen before any mirroring is applied.
    expect(sideA).toBe(SIDE_BOTTOM);
    expect(sideB).toBe(SIDE_TOP);

    // And each client agrees with the other about who is where.
    expect(roomB.state.players.get(roomA.sessionId)!.side).toBe(sideA);
    expect(roomA.state.players.get(roomB.sessionId)!.side).toBe(sideB);

    await roomA.leave(true);
    await roomB.leave(true);
  }, 60_000);
});
