/**
 * Serving the Mini App.
 *
 * The client is a static bundle served by the game server itself, from the
 * same origin as the API and the WebSocket. That is a deliberate choice and
 * the reason several things elsewhere are simpler than they would otherwise
 * be: no preflight on any `/api` call, no second deploy that can drift out of
 * step with this one, and no CORS allowlist to get wrong. A CDN would win the
 * first paint, but every rally is bound to this machine's region regardless,
 * so it would win it on the one request that matters least.
 *
 * The cost is that this file now owns what `vercel.json` used to: cache
 * headers, the SPA fallback, and the frame-ancestors policy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Application, type Request, type Response } from 'express';

import { isProduction } from '../config.js';

/**
 * `<the server package>/public`.
 *
 * Resolved from this module rather than from `process.cwd()`, which depends on
 * where the process was started. Both layouts this file runs from —
 * `src/http/` under tsx and `build/http/` under node — sit exactly two levels
 * below the package root, so one relative path is correct in development and
 * in the image.
 */
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const INDEX_HTML = path.join(CLIENT_DIR, 'index.html');

/**
 * Paths that belong to the server, not to the app.
 *
 * The SPA fallback answers *everything* it is given with the app shell, which
 * is right for a client-side router and wrong for an API: without this, a
 * typo'd endpoint or a removed route would return 200 and a page of HTML, and
 * the client would report a JSON parse error instead of a 404.
 *
 * Colyseus's own routes (`/matchmake/*`, `/__healthcheck`) need no entry here:
 * its router runs ahead of express and never falls through to it.
 */
const SERVER_PREFIXES = ['/api', '/telegram', '/healthz', '/matchmake'];

function isServerPath(pathname: string): boolean {
  return SERVER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Headers every response from the bundle carries.
 *
 * `frame-ancestors` is the load-bearing one. On Telegram Desktop and mobile
 * the Mini App runs in a native webview where it does nothing, but Telegram
 * Web really does load it in an iframe — so the policy has to allow
 * telegram.org and refuse everyone else, rather than being `DENY`.
 */
function securityHeaders(res: Response): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  );
}

/**
 * Content-hashed assets are immutable; everything else must be revalidated.
 *
 * Telegram's webview caches hard enough that a deploy can stay invisible for
 * hours, and this pair is what makes it visible immediately: `index.html` is
 * always re-fetched, and it names new hashed filenames, so nothing stale can
 * be served for them. Vite is configured to hash every file it emits into
 * `assets/` (see the client's `vite.config.ts`); files copied verbatim from
 * the client's `public/` land outside it and are correctly treated as
 * mutable.
 */
function cacheHeaders(res: Response, filePath: string): void {
  const hashed = path.relative(CLIENT_DIR, filePath).split(path.sep)[0] === 'assets';
  res.setHeader(
    'Cache-Control',
    hashed ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate',
  );
}

/**
 * Mount the Mini App.
 *
 * Must be called LAST, after every server route: it ends in a catch-all, and a
 * catch-all registered earlier would swallow them.
 *
 * Registering any route that matches `/` also suppresses Colyseus's own
 * default root handler, which otherwise answers with the exact framework
 * version — a free banner for anyone scanning the host.
 */
export function mountClient(app: Application): void {
  if (!fs.existsSync(INDEX_HTML)) {
    // In the image this is unreachable — the Dockerfile builds the client into
    // `public/` — so if it happens in production the deploy is broken in a way
    // that must not boot quietly and serve 404s to every player.
    if (isProduction) {
      throw new Error(
        `The client bundle is missing: ${INDEX_HTML} does not exist. ` +
          'The image is built wrong, or the server is being run from an unexpected directory.',
      );
    }

    // In development the client is normally on Vite's dev server instead, so
    // this is expected rather than an error. The root route is still claimed,
    // so that what a browser gets here is an explanation and not a version
    // banner.
    console.warn(`[client] no bundle at ${CLIENT_DIR}; serving the API only`);
    app.get('/', (_req: Request, res: Response) => {
      res.type('text/plain').send('API only. The Mini App runs on the Vite dev server.\n');
    });
    return;
  }

  app.use(
    express.static(CLIENT_DIR, {
      // `index.html` is served by the fallback below instead, so that one
      // place decides its headers whether it was reached as `/`, as a deep
      // link, or after a reload inside the app.
      index: false,
      dotfiles: 'ignore',
      setHeaders: (res, filePath) => {
        securityHeaders(res);
        cacheHeaders(res, filePath);
      },
    }),
  );

  // The SPA fallback. Every in-app route is client-side, so anything that is
  // not a file and not a server path is the app shell.
  app.use((req: Request, res: Response, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (isServerPath(req.path)) {
      next();
      return;
    }
    securityHeaders(res);
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(INDEX_HTML, (error) => {
      if (error) next(error);
    });
  });
}
