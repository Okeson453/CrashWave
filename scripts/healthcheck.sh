#!/bin/bash
set -euo pipefail

# Railway sets PORT; local/docker default metrics on 9090
HEALTH_PORT="${PORT:-${METRICS_PORT:-9090}}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"

if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Health check passed ($HEALTH_URL)"
  exit 0
fi

# Fallback to dedicated metrics port if PORT was something else
if [ "${METRICS_PORT:-}" != "" ] && [ "${METRICS_PORT}" != "${HEALTH_PORT}" ]; then
  if curl -sf "http://127.0.0.1:${METRICS_PORT}/health" >/dev/null 2>&1; then
    echo "Health check passed (metrics port)"
    exit 0
  fi
fi

echo "Health check failed ($HEALTH_URL)"
exit 1
