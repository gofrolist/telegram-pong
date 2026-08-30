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
/** Distance from the field edge to the paddle's *contact* plane. */
export const PADDLE_INSET = 10;

/** Y of the plane the bottom paddle defends (ball is blocked at y <= this). */
export const BOTTOM_PLANE_Y = FIELD_H - PADDLE_INSET;
/** Y of the plane the top paddle defends. */
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
/** Multiplied into the ball speed on every paddle hit. */
export const BALL_SPEEDUP = 1.045;
export const BALL_MAX_SPEED = 132;

/**
 * How far the bounce angle is skewed by where the ball strikes the paddle.
 * 0 would make Pong a game of pure reflection; this is what gives it English.
 */
export const BOUNCE_SKEW = 0.85;
/** Never return a ball flatter than this, or rallies stall along a wall. */
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
