# Offline cheat detection

A nightly batch job, deliberately separate from the game server: it shares no
code, runs on its own schedule, and cannot affect a live match even if it
crashes or takes an hour.

## What it can and cannot catch

Server authority already makes the obvious cheats impossible — the paddle
speed cap in `game-core` means a client cannot teleport, and only the server
writes results.

The one cheat that survives is a script that reads the ball and tracks it
perfectly. Every input it sends is individually legal, so **it cannot be
caught in realtime**. It can only be caught in the aggregate, over hundreds of
ticks, which is what this job does.

## The signal

Humans and scripts differ in *distribution*, not in any single sample:

| Feature | Human | Script |
|---|---|---|
| Reaction latency after a ball direction change | ~200–250ms | tens of ms |
| Variance in that latency | High | Near zero |
| Overshoot past the ball, then correct | Frequent | Rare |
| RMS tracking error | Moderate | Very low |
| Idle fraction (finger not moving) | Meaningful | Near zero |

Low latency alone is not evidence. **Low latency with near-zero variance** is,
because a human nervous system cannot produce a constant reaction time.

## What a flag does

**It never bans anyone.** A flag excludes a player from chat leaderboards and
nothing else. False positives on genuinely strong players are certain, and an
auto-ban would turn a statistical guess into a product failure that the person
affected cannot appeal or even see.

## Running it

```sh
cd tools/cheat-detection
uv venv && uv pip install -r requirements.txt
DATABASE_URL='postgresql://...' python detect.py --days 1
```

Add `--dry-run` to print what it would flag without writing.
