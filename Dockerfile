# Personal-Use BC.Game Crash Automation — single-stage build.
# mcr.microsoft.com/playwright:v1.46.0-jammy bundles Chromium + Node runtime.

FROM mcr.microsoft.com/playwright:v1.46.0-jammy

ENV NODE_ENV=production \
    PORT=9090 \
    METRICS_PORT=9090

WORKDIR /app

# Install Node 22 from nodesource (Playwright base is Ubuntu 22.04 jammy)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g npm@11 \
 && rm -rf /var/lib/apt/lists/*

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source + config
COPY config.yaml ./
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm install --no-save typescript@5.9.3 \
 && npx tsc -p tsconfig.build.json \
 && npm cache clean --force

# Copy runtime artifacts
COPY migrations/ ./migrations/
COPY scripts/run-migrations.mjs scripts/healthcheck.sh ./scripts/
RUN mkdir -p logs secrets \
 && chmod +x ./scripts/*.sh ./scripts/*.mjs

# Drop privileges
RUN groupadd -r crashapp && useradd -r -g crashapp -m -d /home/crashapp crashapp \
 && chown -R crashapp:crashapp /app
USER crashapp

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD curl -sf "http://127.0.0.1:${PORT:-9090}/health" || exit 1

CMD ["node", "dist/index.js"]