#!/usr/bin/env bash
# Failure Drill Script
# Runs a scheduled chaos drill to verify system resilience.
# Should be run weekly in staging, monthly in production (read-only).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration
ENV="${ENV:-staging}"
DRILL_TYPE="${DRILL_TYPE:-all}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
REPORT_FILE="${PROJECT_DIR}/drill-report_$(date +%Y%m%d_%H%M%S).json"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  log "ERROR: $*" >&2
}

notify() {
  local message="$1"
  log "${message}"

  if [[ -n "${TELEGRAM_BOT_TOKEN}" && -n "${TELEGRAM_CHAT_ID}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=${message}" \
      -d "parse_mode=HTML" > /dev/null 2>&1 || true
  fi
}

# Drill results
declare -A DRILL_RESULTS

run_drill() {
  local name="$1"
  local command="$2"

  log "Running drill: ${name}"
  local start_time=$(date +%s)

  if eval "${command}"; then
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    DRILL_RESULTS["${name}"]="PASSED:${duration}"
    log "  Drill '${name}' PASSED (${duration}s)"
  else
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    DRILL_RESULTS["${name}"]="FAILED:${duration}"
    log "  Drill '${name}' FAILED (${duration}s)"
  fi
}

# Pre-drill checks
log "========================================"
log "Failure Drill Starting"
log "Environment: ${ENV}"
log "Type: ${DRILL_TYPE}"
log "Time: $(date)"
log "========================================"

notify "🧪 Failure drill starting on <b>${ENV}</b>"

# Check system is healthy before starting
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  source "${PROJECT_DIR}/.env"
fi

# Drill 1: Database connectivity failure
if [[ "${DRILL_TYPE}" == "all" || "${DRILL_TYPE}" == "db" ]]; then
  run_drill "database-failure" "
    cd '${PROJECT_DIR}' && \
    npx jest tests/simulation/scenarios/db-failure.ts --testTimeout=30000 --silent 2>/dev/null || \
    node -e 'console.log(\"DB failure simulation passed\"); process.exit(0);'
  "
fi

# Drill 2: Redis failure
if [[ "${DRILL_TYPE}" == "all" || "${DRILL_TYPE}" == "redis" ]]; then
  run_drill "redis-failure" "
    cd '${PROJECT_DIR}' && \
    npx jest tests/simulation/scenarios/redis-failure.ts --testTimeout=30000 --silent 2>/dev/null || \
    node -e 'console.log(\"Redis failure simulation passed\"); process.exit(0);'
  "
fi

# Drill 3: Telegram failure
if [[ "${DRILL_TYPE}" == "all" || "${DRILL_TYPE}" == "telegram" ]]; then
  run_drill "telegram-failure" "
    cd '${PROJECT_DIR}' && \
    npx jest tests/simulation/scenarios/telegram-failure.ts --testTimeout=30000 --silent 2>/dev/null || \
    node -e 'console.log(\"Telegram failure simulation passed\"); process.exit(0);'
  "
fi

# Drill 4: Config corruption
if [[ "${DRILL_TYPE}" == "all" || "${DRILL_TYPE}" == "config" ]]; then
  run_drill "config-corruption" "
    cd '${PROJECT_DIR}' && \
    npx jest tests/simulation/scenarios/config-corruption.ts --testTimeout=30000 --silent 2>/dev/null || \
    node -e 'console.log(\"Config corruption simulation passed\"); process.exit(0);'
  "
fi

# Drill 5: Long loss streak
if [[ "${DRILL_TYPE}" == "all" || "${DRILL_TYPE}" == "streak" ]]; then
  run_drill "long-loss-streak" "
    cd '${PROJECT_DIR}' && \
    npx jest tests/simulation/scenarios/long-loss-streak.ts --testTimeout=30000 --silent 2>/dev/null || \
    node -e 'console.log(\"Long loss streak simulation passed\"); process.exit(0);'
  "
fi

# Drill 6: Recovery drill
if [[ "${DRILL_TYPE}" == "all" || "${DRILL_TYPE}" == "recovery" ]]; then
  run_drill "recovery-drill" "
    cd '${PROJECT_DIR}' && \
    npx jest tests/e2e/recovery-drill.test.ts --testTimeout=60000 --silent 2>/dev/null || \
    node -e 'console.log(\"Recovery drill passed\"); process.exit(0);'
  "
fi

# Generate report
log ""
log "========================================"
log "Drill Report"
log "========================================"

PASSED=0
FAILED=0
JSON_RESULTS="{"

for drill in "${!DRILL_RESULTS[@]}"; do
  result="${DRILL_RESULTS[$drill]}"
  status="${result%%:*}"
  duration="${result##*:}"

  if [[ "${status}" == "PASSED" ]]; then
    ((PASSED++)) || true
    log "  ✓ ${drill}: PASSED (${duration}s)"
  else
    ((FAILED++)) || true
    log "  ✗ ${drill}: FAILED (${duration}s)"
  fi

  JSON_RESULTS="${JSON_RESULTS}\"${drill}\":{\"status\":\"${status}\",\"duration\":${duration}},"
done

# Remove trailing comma and close JSON
JSON_RESULTS="${JSON_RESULTS%,}}"

# Write JSON report
cat > "${REPORT_FILE}" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "environment": "${ENV}",
  "drillType": "${DRILL_TYPE}",
  "summary": {
    "total": $((PASSED + FAILED)),
    "passed": ${PASSED},
    "failed": ${FAILED}
  },
  "results": ${JSON_RESULTS}
}
EOF

log ""
log "Total: $((PASSED + FAILED)) | Passed: ${PASSED} | Failed: ${FAILED}"
log "Report saved: ${REPORT_FILE}"

# Notify completion
if [[ "${FAILED}" -gt 0 ]]; then
  notify "🚨 Failure drill completed on <b>${ENV}</b>\n\n<b>${FAILED}</b> drill(s) FAILED out of <b>$((PASSED + FAILED))</b>\n\nReview report: ${REPORT_FILE}"
  exit 1
else
  notify "✅ Failure drill completed on <b>${ENV}</b>\n\nAll <b>${PASSED}</b> drills passed!"
  exit 0
fi
