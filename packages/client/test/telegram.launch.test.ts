/**
 * The launch path.
 *
 * This covers the two ways `initTelegram` can silently hand the app a launch
 * it cannot use. Both have happened:
 *
 *   1. Reading `initDataRaw()` without `restoreInitData()`. `init()` only
 *      wires up the bridge — the init-data signals stay `undefined`, the app
 *      posts an empty `initData`, and the server rejects it as unsigned. The
 *      user sees a generic error and the logs say nothing, because from the
 *      server's point of view an unsigned payload was correctly refused.
 *   2. Awaiting a cosmetic mount that never resolves. Every mount is a round
 *      trip to the host; one that goes unanswered used to leave the app on its
 *      loading screen forever.
 *
 * The SDK is mocked rather than driven: this asserts the ORDER of our calls
 * and that nothing decorative can block the launch, which is exactly what
 * went wrong. Whether the real SDK reads the hash correctly is its own tests'
 * problem.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let restored = false;
/** Resolves only when a test decides to; models a host that never answers. */
let viewportMountBlocks = false;
/** Models the SDK finding no host to talk to: `init()` throws synchronously. */
let initThrows = false;

vi.mock('@telegram-apps/sdk', () => {
  const available = <T extends (...args: never[]) => unknown>(fn: T) =>
    Object.assign(fn, { isAvailable: () => true });

  return {
    isTMA: () => true,
    init: available(() => {
      calls.push('init');
      if (initThrows) throw new Error('UnknownEnvError');
    }),
    restoreInitData: available(() => {
      calls.push('restoreInitData');
      restored = true;
    }),
    // The signals the bug was about: undefined until restored, exactly as in
    // the real SDK, where `restoreInitData` holds the only write to them.
    initDataRaw: () => {
      calls.push('initDataRaw');
      return restored ? 'user=%7B%22id%22%3A1%7D&hash=abc' : undefined;
    },
    initDataStartParam: () => (restored ? 'r_abc123' : undefined),
    retrieveLaunchParams: () => ({ tgWebAppPlatform: 'ios' }),
    themeParams: { mount: available(async () => {}) },
    bindThemeParamsCssVars: available(() => {}),
    miniApp: { mount: available(async () => {}), ready: available(() => {}), close: available(() => {}) },
    viewport: {
      mount: available(async () => {
        if (viewportMountBlocks) await new Promise(() => {});
      }),
    },
    bindViewportCssVars: available(() => {}),
    expandViewport: available(() => {}),
    swipeBehavior: { mount: available(() => {}) },
    disableVerticalSwipes: available(() => {}),
    shareMessage: available(async () => {}),
  };
});

const { initTelegram } = await import('../src/telegram.js');

describe('initTelegram', () => {
  beforeEach(() => {
    calls.length = 0;
    restored = false;
    viewportMountBlocks = false;
    initThrows = false;
  });

  it('restores the init data before reading it, and returns a usable launch', async () => {
    const env = await initTelegram();

    expect(env.inTelegram).toBe(true);
    // The assertion that matters: an empty string here is a launch that will
    // 401 at `/api/auth`.
    expect(env.initDataRaw).not.toBe('');
    expect(env.startParam).toBe('r_abc123');
    expect(env.platform).toBe('ios');

    expect(calls.indexOf('restoreInitData')).toBeGreaterThan(-1);
    expect(calls.indexOf('restoreInitData')).toBeLessThan(calls.indexOf('initDataRaw'));
  });

  it('starts anyway when a cosmetic mount never answers', async () => {
    viewportMountBlocks = true;

    const env = await initTelegram();

    expect(env.initDataRaw).not.toBe('');
  }, 10_000);

  it('rejects rather than resolving a launch it could not read', async () => {
    initThrows = true;

    // The caller has to be able to tell a failed launch from a good one. It is
    // App's boot that turns this into an error screen; what matters here is
    // that the failure is not swallowed into a resolved, empty environment,
    // which would send the app to `/api/auth` with nothing to authenticate.
    await expect(initTelegram()).rejects.toThrow();
  });
});
