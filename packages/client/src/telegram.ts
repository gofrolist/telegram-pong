/**
 * Telegram Mini App integration.
 *
 * **Do not additionally load Telegram's single-file `telegram-web-app.js`.**
 * Mixing it with the `@telegram-apps` packages causes subtle failures — two
 * bridges racing over the same `postMessage` channel — and every tutorial that
 * reaches for `window.Telegram.WebApp` is rewritten here against the SDK.
 *
 * Every capability is probed with `isAvailable()` before use. Mini Apps run on
 * a wide range of Telegram client versions, and calling a method the host does
 * not implement throws rather than degrading.
 */

import {
  bindThemeParamsCssVars,
  bindViewportCssVars,
  disableVerticalSwipes,
  expandViewport,
  init,
  initDataRaw,
  initDataStartParam,
  isTMA,
  miniApp,
  restoreInitData,
  retrieveLaunchParams,
  shareMessage,
  swipeBehavior,
  themeParams,
  viewport,
} from '@telegram-apps/sdk';

export interface TelegramEnvironment {
  /** Raw `initData`, to be exchanged for a session token exactly once. */
  initDataRaw: string;
  /** The `startapp` payload, still encoded. */
  startParam: string | null;
  platform: string;
  /** False when running in a plain browser tab (local development). */
  inTelegram: boolean;
}

/**
 * Bring up the SDK and read the launch.
 *
 * Ordered so that the two things the app cannot start without — the raw
 * `initData` and the `startapp` payload — are obtained first, and everything
 * cosmetic happens afterwards behind a deadline.
 */
export async function initTelegram(): Promise<TelegramEnvironment> {
  // The synchronous overload: it inspects the launch parameters rather than
  // round-tripping a message to the host. A round trip would add a visible
  // delay to every launch, and a false negative here only ever means showing
  // the "open in Telegram" screen, never a broken game.
  const inTelegram = isTMA();

  if (!inTelegram) {
    // Running in a normal browser tab: return an empty environment so the app
    // can render a "open this inside Telegram" screen rather than crashing.
    return { initDataRaw: '', startParam: null, platform: 'browser', inTelegram: false };
  }

  init();

  // **`init()` does not read `initData`.** It wires up the bridge and nothing
  // else; `restoreInitData()` is the only thing in the SDK that populates the
  // `initDataRaw` and `initDataStartParam` signals. Without this line they are
  // both `undefined`, the app posts an empty `initData`, the server rejects it
  // as unsigned — correctly — and every launch dies at the auth exchange with
  // a generic error. It has to happen before either signal is read.
  restoreInitData();

  const launchParams = retrieveLaunchParams();

  // Read the launch BEFORE mounting anything. Everything below is presentation
  // — theme variables, safe-area insets, swipe behaviour — and none of it is
  // needed to authenticate or to join a room.
  const environment: TelegramEnvironment = {
    initDataRaw: initDataRaw() ?? '',
    startParam: initDataStartParam() ?? null,
    platform: launchParams.tgWebAppPlatform ?? 'unknown',
    inTelegram: true,
  };

  // Each mount is a round trip to the host, and a host that never answers
  // would otherwise leave the app on its loading screen forever with no error
  // and nothing logged. Cosmetics get a deadline; the game starts regardless.
  await withDeadline(mountInterface(), UI_MOUNT_TIMEOUT_MS);

  return environment;
}

/** How long the presentation layer gets to finish mounting before we go on. */
const UI_MOUNT_TIMEOUT_MS = 3_000;

/**
 * Resolve when `work` finishes or when the deadline passes, whichever is
 * first. A rejection is swallowed for the same reason the deadline exists:
 * the caller has already got everything it actually needs.
 */
async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[telegram] interface mount did not finish within ${ms}ms; continuing`);
      resolve();
    }, ms);
  });
  try {
    await Promise.race([work.catch((error: unknown) => {
      console.warn('[telegram] interface mount failed; continuing', error);
    }), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Theme, viewport and gesture setup.
 *
 * `themeParams` and `miniApp` are mounted one at a time and never with
 * `Promise.all` — mounting both concurrently is documented as unreliable in
 * SDK v3.
 */
async function mountInterface(): Promise<void> {
  if (themeParams.mount.isAvailable()) {
    await themeParams.mount();
    if (bindThemeParamsCssVars.isAvailable()) bindThemeParamsCssVars();
  }

  if (miniApp.mount.isAvailable()) {
    await miniApp.mount();
    // Telling Telegram the app is ready is what dismisses its loading spinner.
    if (miniApp.ready.isAvailable()) miniApp.ready();
  }

  if (viewport.mount.isAvailable()) {
    await viewport.mount();
    // Safe-area insets arrive as CSS variables, which is where the layout
    // reads them — see `styles.css`.
    if (bindViewportCssVars.isAvailable()) bindViewportCssVars();
    if (expandViewport.isAvailable()) expandViewport();
  }

  if (swipeBehavior.mount.isAvailable()) {
    swipeBehavior.mount();
    // Critical for a paddle dragged along the lower screen area: without this,
    // a downward drag closes the Mini App mid-rally.
    if (disableVerticalSwipes.isAvailable()) disableVerticalSwipes();
  }
}

/**
 * Hand the user Telegram's native chat picker for a prepared message.
 *
 * The id is single-use, so it must have been minted for *this* tap.
 * Resolves `true` when Telegram reports the message was sent.
 *
 * Used for both halves of the loop — the invite that opens a match and the
 * result card that closes it — because they are the same Bot API mechanism
 * and the same picker.
 */
export async function sharePreparedMessage(preparedMessageId: string): Promise<boolean> {
  if (!shareMessage.isAvailable()) return false;
  try {
    await shareMessage(preparedMessageId);
    return true;
  } catch {
    // The user closing the picker lands here too, which is why a failure is
    // reported as `share_message_failed` rather than surfaced as an error.
    return false;
  }
}

/** Whether this Telegram version can show the native picker at all. */
export function canSharePreparedMessage(): boolean {
  return shareMessage.isAvailable();
}

/** Close the Mini App. Used only by an explicit "exit" affordance. */
export function closeMiniApp(): void {
  if (miniApp.close.isAvailable()) miniApp.close();
}
