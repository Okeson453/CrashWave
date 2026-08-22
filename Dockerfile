# Railway / default builder — multi-stage production image with migrations
FROM mcr.microsoft.com/playwright:v1.46.0-jammy AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN (npm ci --omit=dev || npm ci --omit=dev) \
 && npm cache clean --force

FROM base AS build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN (npm ci --include=dev || npm ci --include=dev)
COPY src/ ./src/
COPY config.yaml ./
RUN npm run build && npm prune --omit=dev

FROM base AS production
ENV NODE_ENV=production \
    PORT=9090 \
    METRICS_PORT=9090
RUN groupadd -r crashapp && useradd -r -g crashapp -m -d /home/crashapp crashapp
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/config.yaml ./

# Schema migrations + runtime scripts
COPY migrations/ ./migrations/
COPY scripts/run-migrations.mjs scripts/docker-entrypoint.sh \
     scripts/healthcheck.sh scripts/wait-for-services.sh ./scripts/

RUN chmod +x ./scripts/*.sh ./scripts/run-migrations.mjs \
 && mkdir -p logs \
 && chown -R crashapp:crashapp /app

USER crashapp
EXPOSE 9090 8081
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD curl -sf "http://127.0.0.1:${PORT:-${METRICS_PORT:-9090}}/health" || exit 1

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]