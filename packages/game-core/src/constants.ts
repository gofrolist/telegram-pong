/**
 * Simulation constants.
 *
 * The field is expressed in abstract *field units*, never pixels. The client
 * scales field units to CSS pixels at render time only; nothing in the
 * simulation ever sees a screen dimension. That keeps the simulation identical
 * across a 360pt phone and a 1440pt desktop tab.
 *
 * The aspect ratio is portrait because paddles are top and bottom: a phone
 * held upright gives the ball a long flight and the player a wide paddle
 * track, which is the opposite of the classic landscape layout.
 */

/** Field width in field units. */
export const FIELD_W = 100;
/** Field height in field units. 100 x 180 ≈ 9:16.2, close to a modern phone. */
export const FIELD_H = 180;

export const BALL_RADIUS = 2;

export const PADDLE_HALF_W = 11;
export const PADDLE_THICKNESS = 3;
/**
 * Distance from the field edge to the plane the paddle's *ends* sit on.
 *
 * This is a thumb clearance figure as much as a gameplay one. The paddle is
 * steered by a finger resting on the glass directly over it, and at the
 * original inset of 10 the bar sat about 70 CSS px from the bottom of the
 * canvas on a 390pt phone — inside the contact patch of the thumb driving it,
 * so the player was covering the thing they were aiming. Every extra unit here
 * buys roughly 4 px of clearance and costs the same from the rally's length.
 */
export const PADDLE_INSET = 18;

/**
 * Radius of the arc the paddle's striking face is cut from, in field units.
 *
 * The face is a convex arc bulging towards the middle of the field, not a flat
 * bar, and this radius is the whole of the bounce model: the ball leaves along
 * the surface normal at the point it touched, so the outgoing angle is read
 * straight off the curve the player can see. Tighter radius = more curve = a
 * wider spread of return angles.
 *
 * Must stay comfortably above {@link PADDLE_HALF_W}, which is where the arc
 * would close into a half-circle and the ends would face sideways.
 *
 * 17 was chosen to land the extreme return angle (`asin(11/17)` ≈ 40.3°) on
 * the same figure the old flat paddle's `BOUNCE_SKEW = 0.85` produced, so the
 * corners of the paddle play as they always did and only the middle of the
 * face changed.
 */
export const PADDLE_ARC_R = 17;

/**
 * How far the centre of the face bulges past its ends, in field units.
 *
 * Derived, never authored: the renderer and the simulation both need it, and
 * two hand-tuned copies of the same number is how a drawn paddle stops
 * matching the one the ball bounces off. `Math.sqrt` is exactly specified by
 * IEEE-754, so this evaluates bit-identically on the server and in every
 * webview — see the determinism note on SERVE_DIRS below.
 */
export const PADDLE_BULGE =
  PADDLE_ARC_R - Math.sqrt(PADDLE_ARC_R * PADDLE_ARC_R - PADDLE_HALF_W * PADDLE_HALF_W);

/**
 * Y the bottom paddle's arc *ends* sit on; its centre bulges {@link
 * PADDLE_BULGE} above this. Still the deepest point of the face, so it remains
 * the right plane to describe the paddle as defending.
 */
export const BOTTOM_PLANE_Y = FIELD_H - PADDLE_INSET;
/** Y the top paddle's arc ends sit on; its centre bulges below this. */
export const TOP_PLANE_Y = PADDLE_INSET;

/**
 * Hard cap on paddle travel, in field units per second.
 *
 * ANTI-CHEAT: the server clamps every paddle move to this. A client that asks
 * for an instant jump across the field simply gets a paddle that slides at
 * this speed. Because the client predicts with the same constant, an honest
 * client sees no correction at all.
 */
export const PADDLE_MAX_SPEED = 190;

export const BALL_START_SPEED = 62;
/**
 * Multiplied into the ball speed on every paddle hit — the rally's difficulty
 * ramp, and the only one the game has.
 *
 * The ramp has to be spent inside a *rally*, not across a match: the speed
 * resets to {@link BALL_START_SPEED} on every serve, so a factor that needs
 * eighteen hits to arrive at anything is a factor nobody ever meets. At the
 * original 1.045 a six-hit rally ended 30% up on where it started and the cap
 * was, in practice, unreachable.
 *
 * 1.09 was tried first and MEASURED WORSE — see BALL_MAX_SPEED.
 */
export const BALL_SPEEDUP = 1.07;
/**
 * Ceiling on the ramp — and the constant that turned out to matter, because it
 * is the speed the ball spends a long rally AT.
 *
 * Lowered from 132 with the steeper ramp, not despite it. The two only make
 * sense as a pair: raising BALL_SPEEDUP alone leaves the ball sitting at the
 * old top speed for most of every long rally, and that measured badly against
 * the far paddle. At 174ms RTT, over four 30s bot matches each
 * (`bun run bots --latency 87 --matches 4`):
 *
 * ```
 *  speedup   cap | mispredicted far reversals / 30s | ball correction max
 *    1.045   132 |  6.5  (the ramp nobody could feel) |  16.7
 *    1.09    132 | 16.5                               |  29.6
 *    1.07    132 | 10.2                               |  18.2
 *    1.07    115 |  6.0                               |   9.4   <- chosen
 * ```
 *
 * The mechanism is in the README under "What the far paddle costs": a quicker
 * ball gives the opponent less time to reach the interception, so their paddle
 * is still MOVING when the ball arrives — and a moving far paddle is precisely
 * the thing this client cannot predict, because it only ever has that paddle's
 * last replicated target.
 *
 * Dropping the ceiling is not a retreat from the difficulty ramp; it is what
 * makes the ramp affordable. The old pairing reached 74 units/s by the fourth
 * hit and 92 by the ninth, and 132 essentially never. This one reaches 81 by
 * the fourth and 114 by the ninth, and tops out on hit 10. The ball a player
 * actually meets is faster at every point of a real rally — only the number it
 * converges on came down.
 */
export const BALL_MAX_SPEED = 115;

/**
 * Never return a ball flatter than this, or rallies stall along a wall.
 *
 * A guard rather than a live clamp: the arc geometry cannot produce a return
 * flatter than `sqrt(1 - (PADDLE_HALF_W / PADDLE_ARC_R)^2)` ≈ 0.76, so nothing
 * currently trips it. It stays because it is what stops a future tightening of
 * PADDLE_ARC_R from quietly introducing a ball that creeps along the paddle
 * line, which is a bug that only shows up in a rally nobody can end.
 */
export const MIN_VERTICAL_RATIO = 0.34;

/** Simulation rate. The server advertises this to predicting clients. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE;

/** State patches are sent at the same rate as the tick — see README netcode. */
export const PATCH_RATE_MS = TICK_MS;

/** Ticks of countdown before each serve (1s at 30 Hz). */
export const COUNTDOWN_TICKS = 30;
/** Slightly longer pause before the very first serve of a match. */
export const FIRST_SERVE_COUNTDOWN_TICKS = 90;

/** First to this many points takes the match. */
export const SCORE_TO_WIN = 7;

/**
 * Serve directions, precomputed as unit vectors.
 *
 * DETERMINISM: the simulation never calls `Math.sin`, `Math.cos`, `Math.pow`
 * or `Math.atan2` — those are implementation-defined and may differ between
 * V8 on the server and JavaScriptCore in Telegram's iOS webview, which would
 * desync rollback. Only `+ - * /`, comparison and `Math.sqrt` (exactly
 * specified by IEEE-754) appear in the tick.
 */
export const SERVE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, 0.8660254037844386],
  [-0.34202014332566871, 0.9396926207859084],
  [-0.17364817766693041, 0.984807753012208],
  [0.17364817766693041, 0.984807753012208],
  [0.34202014332566871, 0.9396926207859084],
  [0.5, 0.8660254037844386],
];

/**
 * How long a reconciliation correction is spread over, in ms.
 *
 * A correction is a disagreement the client has to absorb; this decides
 * whether it is absorbed as a jump or as a glide. Roughly two ticks was chosen
 * when the only corrections were small ones. It is a constant here, rather
 * than a literal at the call site, because the far-plane hold changes what a
 * correction IS: with it, the ball's release from the opponent's paddle is a
 * correction on every rally, always forwards, and easing that out is the
 * difference between the ball setting off and the ball being teleported off.
 */
export const PREDICTION_SMOOTH_MS = 65;

/**
 * Rolling prediction drift, in field units, above which the client says so.
 *
 * Passed as the SDK's `warnOnDivergence`, and setting it at all is what makes
 * drift and correction get COMPUTED — the SDK skips the bookkeeping entirely
 * when no tolerance is set and its debug bundle is not loaded, which had the
 * end-of-match report sending a hard-coded zero home from every device whose
 * owner had not switched the overlay on.
 *
 * The value is above the drift the opponent's paddle contributes on its own.
 * That component is not a bug and not fixable here — their inputs are not
 * knowable on this client, so their paddle can only be carried forward from
 * its last replicated target — and warning about it would train everyone to
 * ignore the warning.
 */
export const DIVERGENCE_TOLERANCE = 3;

/** Inbound inputs accepted per second before excess is silently dropped. */
export const INPUT_RATE_LIMIT_PER_SEC = 45;

/** How long an unfilled invite room stays alive, in milliseconds. */
export const OPEN_ROOM_TTL_MS = 60 * 60 * 1000;

/** Seconds a dropped player has to reconnect before forfeiting. */
export const RECONNECT_GRACE_SEC = 30;
