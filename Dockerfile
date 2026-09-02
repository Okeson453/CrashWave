# syntax=docker/dockerfile:1
# Multi-stage production build.
#
# Target: ~150-200MB final image (down from ~800MB).
#
# Why the old image was huge:
#   - mcr.microsoft.com/playwright base bundles 3 browsers (~600MB)
#   - single-stage means every build artifact lands in the final image
#   - devDependencies and @types/* stayed installed after tsc
#
# New strategy:
#   1. base      — slim Node 22 + only the system libs Chromium needs
#   2. build     — install full deps, compile TS, install chromium-headless-shell
#   3. production — copy dist + production node_modules + browser; drop everything else
#
# This is the entry point Railway uses (see railway.toml).
# For local docker-compose dev, see docker/Dockerfile.

# ---- 0. Base: slim Node + Chromium system libs ----
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
      libasound2 libatspi2.0-0 libgtk-3-0 libx11-xcb1 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- 1. Build: full deps + tsc + chromium-headless-shell ----
FROM base AS build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
# Override NODE_ENV locally so npm doesn't skip @types/* (devDeps) under
# the production default that may be set by the orchestrator.
RUN NODE_ENV=development npm ci \
 && npm cache clean --force
COPY src/ ./src/
COPY config.yaml ./config.yaml
RUN NODE_ENV=development npm run build \
 && npm prune --omit=dev \
 && find /app/node_modules \( -name "*.md" -o -name "*.ts" -o -name "*.map" \
      -o -name "CHANGELOG*" -o -name "README*" -o -name "LICENSE*" \
      -o -name ".npmignore" -o -name "test" -type d \) -delete 2>/dev/null || true

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Bot runs headless in production (browser/types.ts forces headless when
# no display is present). --only-shell installs chromium-headless-shell
# (~260MB) instead of full Chromium (~390MB). System deps already in base.
# package.json ^1.46.0 resolves to 1.62.x in the lockfile, which supports
# --only-shell (introduced in 1.49).
RUN npx playwright install --only-shell chromium \
 && cd /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64 \
 && find locales -mindepth 1 -maxdepth 1 ! -name 'en-US*' -exec rm -rf {} + \
 && rm -rf hyphen-data \
 && rm -f LICENSE.headless_shell rpm.deps deb.deps ABOUT

# ---- 2. Production: copy artifacts only ----
FROM base AS production
ENV NODE_ENV=production \
    PORT=9090 \
    METRICS_PORT=9090 \
    PLAYWRIGHT_BROWSERS_PATH=/home/crashapp/.cache/ms-playwright

RUN groupadd -r crashapp && useradd -r -g crashapp -m -d /home/crashapp crashapp

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/config.yaml  ./config.yaml
COPY --from=build /ms-playwright    /home/crashapp/.cache/ms-playwright

COPY migrations/ ./migrations/
COPY scripts/run-migrations.mjs scripts/healthcheck.sh ./scripts/

# Browsers live under the crashapp home cache. Also symlink /ms-playwright so
# deployments that still set PLAYWRIGHT_BROWSERS_PATH=/ms-playwright (compose /
# .env.example) keep working instead of pointing at an empty directory.
RUN mkdir -p logs /home/crashapp/.cache \
 && ln -sfn /home/crashapp/.cache/ms-playwright /ms-playwright \
 && chmod +x ./scripts/*.sh ./scripts/run-migrations.mjs \
 && chown -R crashapp:crashapp /app /home/crashapp /home/crashapp/.cache

USER crashapp
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD curl -sf "http://127.0.0.1:${PORT:-9090}/health" || exit 1

CMD ["node", "dist/index.js"]
