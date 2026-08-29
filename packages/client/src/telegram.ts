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
 * Bring up the SDK.
 *
 * `themeParams` and `miniApp` are mounted one at a time and never with
 * `Promise.all` — mounting both concurrently is documented as unreliable in
 * SDK v3.
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

  const launchParams = retrieveLaunchParams();

  return {
    initDataRaw: initDataRaw() ?? '',
    startParam: initDataStartParam() ?? null,
    platform: launchParams.tgWebAppPlatform ?? 'unknown',
    inTelegram: true,
  };
}

/**
 * Hand the user Telegram's native chat picker for a prepared message.
 *
 * The id is single-use, so it must have been minted for *this* tap.
 * Resolves `true` when Telegram reports the message was sent.
 */
export async function shareResultCard(preparedMessageId: string): Promise<boolean> {
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

/** Close the Mini App. Used only by an explicit "exit" affordance. */
export function closeMiniApp(): void {
  if (miniApp.close.isAvailable()) miniApp.close();
}
