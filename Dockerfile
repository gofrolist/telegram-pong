# ---------------------------------------------------------------------------
# Game server + bot. One image, one fly.io machine.
# ---------------------------------------------------------------------------
# **Base image is trixie, not bookworm.** `uWebSockets.js` ships PREBUILT
# binaries (`uws_linux_<arch>_127.node`) linked against glibc 2.38. Debian
# bookworm has 2.36, so a bookworm image builds and pushes perfectly and then
# dies at startup with `GLIBC_2.38 not found` — a failure that appears only
# once the container runs, i.e. in the deploy. Trixie ships glibc 2.41.
#
# Bun installs; **Node runs**. Bun is the package manager for this repo, but
# the server is a long-lived Colyseus process built against Node's runtime
# (uWebSockets.js is a Node native addon), so the runtime stage is plain Node.

ARG BUN_VERSION=1.3.14
ARG NODE_IMAGE=node:22-trixie-slim

# Bun's official image is used only as a source for the binary, so the runtime
# glibc stays under our control.
FROM oven/bun:${BUN_VERSION} AS bun

# ---------------------------------------------------------------------------
# Stage 1 — compile TypeScript.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

# `git` and `ca-certificates` only: uWebSockets.js is fetched as a GitHub
# tarball but ships prebuilt binaries, so no compiler toolchain is needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the lockfile.
# ALL THREE workspace manifests are copied even though the Mini App is not part
# of this image: `--frozen-lockfile` compares workspace membership against the
# lockfile, and a missing member reads as "the lockfile changed". `--filter`
# then scopes what is actually installed — the client's own dependencies
# (React, Vite) never enter the image.
COPY package.json bun.lock ./
COPY packages/game-core/package.json packages/game-core/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

RUN bun install --frozen-lockfile --filter '@pong/server'

COPY packages/game-core packages/game-core
COPY packages/server packages/server

# game-core must be built first: its `exports` resolve to compiled JS outside
# development, and the runtime stage runs plain `node`, which cannot load .ts.
RUN bun run --filter @pong/game-core build \
 && bun run --filter @pong/server build

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies only.
# ---------------------------------------------------------------------------
# A separate stage rather than pruning the build stage's tree: pruning in place
# tends to leave dev packages on disk (typescript, vitest, drizzle-kit and
# several copies of esbuild — ~90MB), because it only rewrites the link tree.
# Installing fresh from the lockfile is the only way to be sure what is in the
# image.
FROM ${NODE_IMAGE} AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/game-core/package.json packages/game-core/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

RUN bun install --frozen-lockfile --production --filter '@pong/server'

# uWebSockets.js ships one prebuilt binary per (platform, arch, Node ABI) —
# twenty of them, ~114MB, of which exactly one is ever loaded. Node itself
# names the one this image needs, so this stays correct on both arm64 and x64,
# and the directory is located by search so it survives a change of package
# manager or node_modules layout.
RUN node -e "\
  const fs=require('fs'), path=require('path'); \
  const found=[]; \
  (function walk(dir, depth){ \
    if(depth>6) return; \
    let entries; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; } \
    for(const e of entries){ \
      if(!e.isDirectory()) continue; \
      if(e.name==='uWebSockets.js'){ found.push(path.join(dir,e.name)); continue; } \
      walk(path.join(dir,e.name), depth+1); \
    } \
  })('/app/node_modules', 0); \
  if(!found.length){ console.log('uWebSockets.js not found; nothing to prune'); process.exit(0); } \
  const keep='uws_'+process.platform+'_'+process.arch+'_'+process.versions.modules+'.node'; \
  let freed=0; \
  for(const pkg of found){ \
    for(const f of fs.readdirSync(pkg)){ \
      if(f.endsWith('.node') && f!==keep){ \
        freed+=fs.statSync(path.join(pkg,f)).size; fs.unlinkSync(path.join(pkg,f)); \
      } \
    } \
    if(!fs.existsSync(path.join(pkg,keep))) throw new Error('required binary missing: '+keep+' in '+pkg); \
  } \
  console.log('kept '+keep+' in '+found.length+' copy/copies, freed '+Math.round(freed/1048576)+'MB'); \
"

# ---------------------------------------------------------------------------
# Stage 3 — runtime. Node only; bun is not shipped.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# `fontconfig` and a font are needed by resvg to rasterise the result card's
# text. Without them the card renders with the numerals missing — silently.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

ENV NODE_ENV=production
WORKDIR /app

# Never run the game server as root.
RUN useradd --create-home --uid 10001 pong

COPY --from=deps  --chown=pong:pong /app/node_modules ./node_modules
COPY --from=deps  --chown=pong:pong /app/packages/game-core/node_modules ./packages/game-core/node_modules
COPY --from=deps  --chown=pong:pong /app/packages/server/node_modules ./packages/server/node_modules

COPY --from=build --chown=pong:pong /app/packages/game-core/package.json ./packages/game-core/
COPY --from=build --chown=pong:pong /app/packages/game-core/dist ./packages/game-core/dist
COPY --from=build --chown=pong:pong /app/packages/server/package.json ./packages/server/
COPY --from=build --chown=pong:pong /app/packages/server/build ./packages/server/build
COPY --from=build --chown=pong:pong /app/packages/server/drizzle ./packages/server/drizzle

USER pong
WORKDIR /app/packages/server

EXPOSE 2567

# fly sends SIGTERM on deploy; the entry point drains the matchmaker on it, so
# in-flight matches get a reconnection window rather than a dropped socket.
STOPSIGNAL SIGTERM

CMD ["node", "build/index.js"]
