/**
 * The netcode overlay.
 *
 * **Why this exists rather than `console.log`.** Telegram's webview has no
 * developer tools — not on iOS, not on Telegram Desktop — so anything written
 * to the console on the device that is actually having the problem is written
 * where nobody can read it. A diagnosis has to be rendered *into the page*.
 *
 * The instrument is the SDK's own: `@colyseus/sdk/debug` publishes a panel
 * carrying, per reconciler, a drift `status` (`matched` / `jitter` /
 * `diverging`), a smoothed `ema`, a `peak`, and `lastCorrectionMag`. That is
 * the direct read on the question "is the ball moving oddly because it is
 * being corrected, or because it is being drawn badly?" — which no amount of
 * position logging answers.
 *
 * It is imported dynamically and never referenced from the main entry, so for
 * everyone who does not switch it on it is a chunk that is never fetched.
 */

/** Survives the reload that Telegram does whenever it feels like it. */
const STORAGE_KEY = 'pong.debug.netcode';

/**
 * Whether the overlay should load.
 *
 * Two triggers, because the two contexts that need it are different. The query
 * parameter serves a browser, where the URL is yours to type. Inside Telegram
 * the URL is whatever BotFather was told, so the only way in is the gesture in
 * `Home` — which is why the flag has to persist rather than living in state.
 */
export function isNetcodeDebugEnabled(): boolean {
  if (new URLSearchParams(window.location.search).get('debug') === 'netcode') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private mode, or a webview with site data blocked. Not being able to
    // remember the preference is not a reason to fail the app.
    return false;
  }
}

/** Turn it on or off for this device. Returns the state it settled on. */
export function setNetcodeDebug(enabled: boolean): boolean {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
    return enabled;
  } catch {
    return false;
  }
}

let loading: Promise<void> | null = null;

/**
 * Load the overlay, at most once.
 *
 * Ordering does not matter: the SDK's debug channel buffers what publishers
 * emit before the overlay installs and replays it, so this can run after the
 * room has already joined and the reconciler already exists.
 */
export function loadNetcodeOverlay(): Promise<void> {
  if (!isNetcodeDebugEnabled()) return Promise.resolve();
  loading ??= import('@colyseus/sdk/debug').then(
    () => undefined,
    (error: unknown) => {
      // A diagnostic that breaks the thing it is diagnosing is worse than no
      // diagnostic. This is the one place a console line is still worth
      // writing: on a desktop browser, where there is a console to read it.
      console.warn('[debug] netcode overlay failed to load', error);
    },
  );
  return loading;
}
