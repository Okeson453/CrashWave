#!/bin/bash
set -euo pipefail

# Docker / Railway entrypoint:
# 1) optional wait for dependent services
# 2) run SQL migrations (unless SKIP_MIGRATIONS=true)
# 3) start the application

echo "[entrypoint] starting crash-automation"

if [ "${WAIT_FOR_SERVICES:-}" != "" ]; then
  # e.g. WAIT_FOR_SERVICES="db:5432 redis:6379"
  # shellcheck disable=SC2086
  ./scripts/wait-for-services.sh ${WAIT_FOR_SERVICES}
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] running database migrations..."
  node ./scripts/run-migrations.mjs
else
  echo "[entrypoint] DATABASE_URL not set — skipping migrations"
fi

echo "[entrypoint] launching app: $*"
exec "$@"
