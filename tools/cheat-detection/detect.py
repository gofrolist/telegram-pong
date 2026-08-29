"""Nightly cheat detection over recorded match traces.

Reads `match_traces`, computes per-player behavioural features, and writes a
row to `cheat_flags` for players whose distributions look mechanical.

Three design commitments, in order of importance:

1. **Never auto-ban.** A flag excludes a player from chat leaderboards. That is
   its entire effect. False positives on genuinely strong players are certain,
   and a ban issued by a statistic is a product failure the affected person
   cannot see or appeal.
2. **Never touch a live match.** This process shares no code with the game
   server, holds no room state, and runs on its own schedule. If it crashes
   mid-run, nothing in production notices.
3. **Judge distributions, not samples.** A single fast reaction is a good
   player. A hundred reactions with no variance is a script, because a human
   nervous system cannot produce a constant latency.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass

import numpy as np
import psycopg
from psycopg.rows import dict_row

# --------------------------------------------------------------------------
# Trace decoding
# --------------------------------------------------------------------------

# Traces are stored as 16-bit quantised field positions; see
# `packages/server/src/antiCheat/traceRecorder.ts`.
QUANTISATION = 65535.0
FIELD_W = 100.0
FIELD_H = 180.0


def dequantise(values: list[int], extent: float) -> np.ndarray:
    return np.asarray(values, dtype=np.float64) / QUANTISATION * extent


# --------------------------------------------------------------------------
# Feature extraction
# --------------------------------------------------------------------------


@dataclass
class Features:
    """Per-player features for one match."""

    #: Best-fit reaction lag per time block, in ms. The *spread* of these is
    #: the load-bearing signal; see `block_reaction_lags`.
    block_lags_ms: np.ndarray
    tracking_rmse: float
    overshoot_rate: float
    idle_fraction: float
    samples: int


#: Widest lag we will consider, in ticks (~800ms at 30 Hz). Beyond this a
#: player is not reacting to the ball, they are guessing.
MAX_LAG_TICKS = 24
#: Reaction lag is estimated per block, so that its variance over a match can
#: be measured. Five seconds is long enough to fit several direction changes.
BLOCK_SECONDS = 5


def best_lag(paddle_dx: np.ndarray, ball_dx: np.ndarray) -> float:
    """Lag, in ticks, at which paddle motion best explains ball motion.

    Cross-correlation rather than "when did the paddle first move after the
    ball turned". That naive measure reads ~0ms for *any* player who tracks
    continuously — which is most of them — because their paddle is always
    already moving. What actually distinguishes a human is that their whole
    motion trace is shifted in time relative to the ball, and that shift is
    what this finds.

    Returns `nan` when the player barely moved, which is not evidence of
    anything.
    """
    if paddle_dx.size <= MAX_LAG_TICKS * 2:
        return float("nan")
    if np.std(paddle_dx) < 1e-9 or np.std(ball_dx) < 1e-9:
        return float("nan")

    best_score = -np.inf
    best = float("nan")
    for lag in range(MAX_LAG_TICKS + 1):
        # Paddle at t+lag against ball at t: a positive lag means the paddle
        # follows.
        a = paddle_dx[lag:]
        b = ball_dx[: paddle_dx.size - lag]
        if a.size < MAX_LAG_TICKS:
            break
        score = float(np.dot(a - a.mean(), b - b.mean()) / (a.size * a.std() * b.std() + 1e-12))
        if score > best_score:
            best_score = score
            best = float(lag)
    return best


def block_reaction_lags(
    paddle_dx: np.ndarray, ball_dx: np.ndarray, tick_rate: int
) -> np.ndarray:
    """Per-block best-fit lag, in milliseconds.

    A human's lag wanders between blocks — they tire, they anticipate, they
    lose the ball. A script's does not move at all, and that constancy is the
    thing no amount of skill can fake.
    """
    block = tick_rate * BLOCK_SECONDS
    ms_per_tick = 1000.0 / tick_rate
    lags: list[float] = []
    for start in range(0, paddle_dx.size - block, block):
        lag = best_lag(paddle_dx[start : start + block], ball_dx[start : start + block])
        if np.isfinite(lag):
            lags.append(lag * ms_per_tick)
    return np.asarray(lags, dtype=np.float64)


def extract(paddle_x: np.ndarray, ball_x: np.ndarray, tick_rate: int) -> Features:
    """Compute one player's features from their paddle track and the ball."""
    if paddle_x.size < tick_rate * BLOCK_SECONDS * 2:
        # Under two blocks of play: too short for any distribution to mean
        # anything. Returning empty is how the caller knows to skip it.
        return Features(np.empty(0), float("nan"), float("nan"), float("nan"), 0)

    # --- reaction lag -------------------------------------------------------
    ball_dx = np.diff(ball_x, prepend=ball_x[0])
    paddle_dx = np.diff(paddle_x, prepend=paddle_x[0])
    # "Moving" needs a floor: a finger resting on glass jitters by a fraction
    # of a unit, and counting that as motion would put every human's idle
    # fraction at zero.
    moving = np.abs(paddle_dx) > (FIELD_W * 0.002)

    block_lags = block_reaction_lags(paddle_dx, ball_dx, tick_rate)

    # --- tracking error -----------------------------------------------------
    error = paddle_x - ball_x
    tracking_rmse = float(np.sqrt(np.mean(error**2)))

    # --- overshoot ----------------------------------------------------------
    # An overshoot is a sign change in the tracking error: the paddle crossed
    # the ball and had to come back. Humans do this constantly.
    error_sign = np.sign(error)
    sign_changes = np.count_nonzero(np.diff(error_sign) != 0)
    overshoot_rate = float(sign_changes) / float(paddle_x.size)

    # --- idleness -----------------------------------------------------------
    idle_fraction = float(np.count_nonzero(~moving)) / float(moving.size)

    return Features(
        block_lags_ms=block_lags,
        tracking_rmse=tracking_rmse,
        overshoot_rate=overshoot_rate,
        idle_fraction=idle_fraction,
        samples=int(paddle_x.size),
    )


# --------------------------------------------------------------------------
# Judgement
# --------------------------------------------------------------------------

# A human reacts in roughly 200-250ms with wide spread. These thresholds are
# deliberately far outside the human range rather than at its edge: the cost of
# a false positive (a strong player quietly dropped from their friends'
# leaderboard) is much higher than the cost of missing a cheat for a week.
MEDIAN_LATENCY_CEILING_MS = 90.0
LATENCY_STDDEV_CEILING_MS = 25.0
TRACKING_RMSE_CEILING = 1.5
OVERSHOOT_FLOOR = 0.01
# Fewer measured blocks than this and the sample is not a distribution. At
# five seconds per block this is a few minutes of play, i.e. several matches.
MIN_REACTION_EVENTS = 24


@dataclass
class Verdict:
    flagged: bool
    reason: str
    median_ms: float
    stddev_ms: float
    tracking_rmse: float
    overshoot_rate: float
    idle_fraction: float


def judge(aggregate: list[Features]) -> Verdict:
    """Decide on a player from all their matches in the window."""
    blocks = [f.block_lags_ms for f in aggregate if f.block_lags_ms.size]
    latencies = np.concatenate(blocks) if blocks else np.empty(0)

    rmses = np.asarray([f.tracking_rmse for f in aggregate if np.isfinite(f.tracking_rmse)])
    overshoots = np.asarray([f.overshoot_rate for f in aggregate if np.isfinite(f.overshoot_rate)])
    idles = np.asarray([f.idle_fraction for f in aggregate if np.isfinite(f.idle_fraction)])

    median_ms = float(np.median(latencies)) if latencies.size else float("nan")
    stddev_ms = float(np.std(latencies)) if latencies.size else float("nan")
    tracking_rmse = float(np.mean(rmses)) if rmses.size else float("nan")
    overshoot_rate = float(np.mean(overshoots)) if overshoots.size else float("nan")
    idle_fraction = float(np.mean(idles)) if idles.size else float("nan")

    if latencies.size < MIN_REACTION_EVENTS:
        return Verdict(
            False,
            f"insufficient data ({latencies.size} measured blocks)",
            median_ms,
            stddev_ms,
            tracking_rmse,
            overshoot_rate,
            idle_fraction,
        )

    # EVERY condition must hold. Any one of them alone describes a very good
    # player; together they describe something that is not reacting at all,
    # because it already knows where the ball is going.
    reasons: list[str] = []
    if median_ms < MEDIAN_LATENCY_CEILING_MS:
        reasons.append(f"median reaction {median_ms:.0f}ms")
    if stddev_ms < LATENCY_STDDEV_CEILING_MS:
        reasons.append(f"reaction stddev {stddev_ms:.0f}ms")
    if np.isfinite(tracking_rmse) and tracking_rmse < TRACKING_RMSE_CEILING:
        reasons.append(f"tracking rmse {tracking_rmse:.2f}")
    if np.isfinite(overshoot_rate) and overshoot_rate < OVERSHOOT_FLOOR:
        reasons.append(f"overshoot rate {overshoot_rate:.4f}")

    flagged = len(reasons) == 4
    return Verdict(
        flagged,
        "; ".join(reasons) if reasons else "within human range",
        median_ms,
        stddev_ms,
        tracking_rmse,
        overshoot_rate,
        idle_fraction,
    )


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

SELECT_TRACES = """
select m.id            as match_id,
       m.game          as game,
       m.player_a_id   as player_a_id,
       m.player_b_id   as player_b_id,
       t.tick_rate     as tick_rate,
       t.trace         as trace
  from match_traces t
  join matches m on m.id = t.match_id
 where t.created_at >= now() - make_interval(days => %(days)s)
"""

UPSERT_FLAG = """
insert into cheat_flags (
    user_id, game, reaction_median_ms, reaction_stddev_ms, tracking_rmse,
    overshoot_rate, idle_fraction, matches_analysed, reason, active
) values (
    %(user_id)s, %(game)s, %(median)s, %(stddev)s, %(rmse)s,
    %(overshoot)s, %(idle)s, %(matches)s, %(reason)s, true
)
"""

CLEAR_FLAGS = """
update cheat_flags set active = false
 where game = %(game)s and user_id = any(%(user_ids)s) and active
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=1, help="lookback window in days")
    parser.add_argument("--game", default="pong")
    parser.add_argument(
        "--dry-run", action="store_true", help="report without writing any flags"
    )
    args = parser.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 1

    per_player: dict[int, list[Features]] = {}
    match_counts: dict[int, int] = {}

    with psycopg.connect(url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(SELECT_TRACES, {"days": args.days})
            rows = cursor.fetchall()

        for row in rows:
            if row["game"] != args.game:
                continue
            trace = row["trace"]
            tick_rate = int(row["tick_rate"]) or 30
            ball_x = dequantise(trace.get("ballX", []), FIELD_W)
            if ball_x.size == 0:
                continue

            for key, user_id in (
                ("a", int(row["player_a_id"])),
                ("b", int(row["player_b_id"])),
            ):
                paddle = dequantise(trace.get(key, []), FIELD_W)
                if paddle.size != ball_x.size:
                    # Truncate to the shorter of the two rather than skipping:
                    # a trace can be cut short by the recorder's sample cap.
                    length = min(paddle.size, ball_x.size)
                    if length == 0:
                        continue
                    paddle, ball = paddle[:length], ball_x[:length]
                else:
                    ball = ball_x

                per_player.setdefault(user_id, []).append(extract(paddle, ball, tick_rate))
                match_counts[user_id] = match_counts.get(user_id, 0) + 1

        flagged: list[int] = []
        cleared: list[int] = []

        for user_id, features in sorted(per_player.items()):
            verdict = judge(features)
            marker = "FLAG" if verdict.flagged else "ok  "
            print(
                f"{marker} user={user_id} matches={match_counts[user_id]} "
                f"median={verdict.median_ms:.0f}ms sd={verdict.stddev_ms:.0f}ms "
                f"rmse={verdict.tracking_rmse:.2f} overshoot={verdict.overshoot_rate:.4f} "
                f"idle={verdict.idle_fraction:.2f} :: {verdict.reason}"
            )

            if verdict.flagged:
                flagged.append(user_id)
                if not args.dry_run:
                    with connection.cursor() as cursor:
                        cursor.execute(
                            UPSERT_FLAG,
                            {
                                "user_id": user_id,
                                "game": args.game,
                                "median": verdict.median_ms,
                                "stddev": verdict.stddev_ms,
                                "rmse": verdict.tracking_rmse,
                                "overshoot": verdict.overshoot_rate,
                                "idle": verdict.idle_fraction,
                                "matches": match_counts[user_id],
                                "reason": verdict.reason,
                            },
                        )
            else:
                cleared.append(user_id)

        # A player who now looks human again has their flag lifted. A flag that
        # can only ever be added is a ban with extra steps.
        if cleared and not args.dry_run:
            with connection.cursor() as cursor:
                cursor.execute(CLEAR_FLAGS, {"game": args.game, "user_ids": cleared})

        if not args.dry_run:
            connection.commit()

    print(
        f"\nanalysed {len(per_player)} players over {args.days}d: "
        f"{len(flagged)} flagged, {len(cleared)} clear"
        + (" (dry run, nothing written)" if args.dry_run else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
