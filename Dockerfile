# Railway / default builder — multi-stage production image with migrations
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libasound2 libatspi2.0-0 libgtk-3-0 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --include=dev
COPY src/ ./src/
COPY config.yaml ./
RUN npm run build && npm prune --omit=dev
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium

FROM base AS production
ENV NODE_ENV=production \
    PORT=9090 \
    METRICS_PORT=9090 \
    PLAYWRIGHT_BROWSERS_PATH=/home/crashapp/.cache/ms-playwright
RUN groupadd -r crashapp && useradd -r -g crashapp -m -d /home/crashapp crashapp
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/config.yaml ./
COPY --from=build /ms-playwright /home/crashapp/.cache/ms-playwright
COPY --from=build /app/node_modules/playwright ./node_modules/playwright
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core

# Schema migrations + runtime scripts
COPY migrations/ ./migrations/
COPY scripts/run-migrations.mjs scripts/docker-entrypoint.sh \
    scripts/healthcheck.sh scripts/wait-for-services.sh ./scripts/

RUN chmod +x ./scripts/*.sh ./scripts/run-migrations.mjs \
    && mkdir -p logs /home/crashapp/.cache \
    && chown -R crashapp:crashapp /app /home/crashapp

USER crashapp
EXPOSE 9090 8081
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
    CMD curl -sf "http://127.0.0.1:${PORT:-${METRICS_PORT:-9090}}/health" || exit 1

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
