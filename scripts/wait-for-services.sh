#!/bin/bash
set -euo pipefail

# Wait for host:port pairs before starting the app.
# Usage: ./wait-for-services.sh db:5432 redis:6379
# Uses bash /dev/tcp (no netcat dependency).

wait_for() {
  local host="$1"
  local port="$2"
  local timeout="${WAIT_TIMEOUT:-60}"
  local elapsed=0

  echo "Waiting for $host:$port..."
  while ! (echo >"/dev/tcp/$host/$port") >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "Timeout waiting for $host:$port after ${timeout}s"
      exit 1
    fi
  done
  echo "$host:$port is available"
}

for service in "$@"; do
  host="${service%%:*}"
  port="${service##*:}"
  wait_for "$host" "$port"
done

echo "All services are ready"
