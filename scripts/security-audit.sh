#!/usr/bin/env bash
# Security Audit Script
# Verifies: no secrets in logs, encrypted profiles at rest, allowlist enforced, audit trail complete.
# Run weekly or after any security incident.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration
LOG_DIR="${LOG_DIR:-${PROJECT_DIR}/logs}"
CONFIG_DIR="${CONFIG_DIR:-${PROJECT_DIR}/config}"
PROFILE_DIR="${PROFILE_DIR:-${PROJECT_DIR}/profiles}"
AUDIT_REPORT="${PROJECT_DIR}/security-audit-report_$(date +%Y%m%d_%H%M%S).txt"

# Severity counters
CRITICAL=0
WARNING=0
INFO=0

log() {
  echo "$*" | tee -a "${AUDIT_REPORT}"
}

audit_pass() {
  log "  [PASS] $*"
}

audit_warn() {
  log "  [WARN] $*"
  ((WARNING++)) || true
}

audit_fail() {
  log "  [FAIL] $*"
  ((CRITICAL++)) || true
}

log "========================================"
log "Security Audit Report"
log "Generated: $(date)"
log "Project: ${PROJECT_DIR}"
log "========================================"
log ""

# 1. Check for secrets in logs
log "--- 1. Secrets in Logs ---"
SECRET_PATTERNS=(
  "password[=:]['\" ]*[^'\" ]+"
  "token[=:]['\" ]*[^'\" ]+"
  "api_key[=:]['\" ]*[^'\" ]+"
  "secret[=:]['\" ]*[^'\" ]+"
  "private_key"
  "BEGIN RSA PRIVATE KEY"
  "BEGIN OPENSSH PRIVATE KEY"
)

SECRETS_FOUND=0
for pattern in "${SECRET_PATTERNS[@]}"; do
  if grep -riE "${pattern}" "${LOG_DIR}" 2>/dev/null | grep -v "security-audit" | head -5 > /dev/null; then
    SECRETS_FOUND=1
    break
  fi
done

if [[ "${SECRETS_FOUND}" -eq 0 ]]; then
  audit_pass "No secrets detected in log files"
else
  audit_fail "Potential secrets found in log files - review immediately"
fi
log ""

# 2. Check encrypted profiles at rest
log "--- 2. Profile Encryption at Rest ---"
if [[ -d "${PROFILE_DIR}" ]]; then
  UNENCRYPTED_PROFILES=$(find "${PROFILE_DIR}" -type f ! -name "*.enc" ! -name "*.gpg" | wc -l)
  if [[ "${UNENCRYPTED_PROFILES}" -eq 0 ]]; then
    audit_pass "All profile files are encrypted"
  else
    audit_warn "${UNENCRYPTED_PROFILES} unencrypted profile files found"
  fi
else
  audit_warn "Profile directory not found: ${PROFILE_DIR}"
fi
log ""

# 3. Check Telegram allowlist enforcement
log "--- 3. Telegram Allowlist Enforcement ---"
if [[ -f "${CONFIG_DIR}/telegram.yml" ]]; then
  if grep -q "allowedUserIds" "${CONFIG_DIR}/telegram.yml"; then
    ALLOWLIST_COUNT=$(grep "allowedUserIds" "${CONFIG_DIR}/telegram.yml" | grep -o '[0-9]*' | wc -l)
    if [[ "${ALLOWLIST_COUNT}" -gt 0 ]]; then
      audit_pass "Telegram allowlist is configured with ${ALLOWLIST_COUNT} user(s)"
    else
      audit_fail "Telegram allowlist is empty - any user can control the bot"
    fi
  else
    audit_fail "Telegram allowlist not configured"
  fi
else
  audit_warn "Telegram config not found"
fi
log ""

# 4. Check audit trail completeness
log "--- 4. Audit Trail Completeness ---"
AUDIT_DB_CHECK=0
if command -v psql >/dev/null 2>&1; then
  if PGPASSWORD="${DB_PASSWORD:-}" psql -h "${DB_HOST:-localhost}" -U "${DB_USER:-crash_user}" -d "${DB_NAME:-crash_automation}" -c "SELECT COUNT(*) FROM audit_events;" >/dev/null 2>&1; then
    AUDIT_DB_CHECK=1
  fi
fi

if [[ "${AUDIT_DB_CHECK}" -eq 1 ]]; then
  audit_pass "Audit trail table exists and is accessible"
else
  audit_warn "Could not verify audit trail database table"
fi

# Check for recent audit entries
if [[ -d "${LOG_DIR}" ]]; then
  RECENT_AUDIT=$(find "${LOG_DIR}" -name "*.log" -type f -mtime -1 | wc -l)
  if [[ "${RECENT_AUDIT}" -gt 0 ]]; then
    audit_pass "Recent log entries found (${RECENT_AUDIT} log files modified in last 24h)"
  else
    audit_warn "No recent log activity found"
  fi
fi
log ""

# 5. Check file permissions
log "--- 5. File Permissions ---"
SENSITIVE_FILES=(
  "${CONFIG_DIR}"
  "${PROFILE_DIR}"
)

for path in "${SENSITIVE_FILES[@]}"; do
  if [[ -e "${path}" ]]; then
    PERMS=$(stat -c "%a" "${path}" 2>/dev/null || stat -f "%Lp" "${path}" 2>/dev/null || echo "unknown")
    if [[ "${PERMS}" != "unknown" && "${PERMS}" -gt 750 ]]; then
      audit_warn "${path} has permissive permissions (${PERMS})"
    else
      audit_pass "${path} permissions are restricted (${PERMS})"
    fi
  fi
done
log ""

# 6. Check for .env files with secrets
log "--- 6. Environment File Security ---"
ENV_FILES=$(find "${PROJECT_DIR}" -name ".env*" -type f 2>/dev/null | wc -l)
if [[ "${ENV_FILES}" -gt 0 ]]; then
  for envfile in $(find "${PROJECT_DIR}" -name ".env*" -type f 2>/dev/null); do
    if grep -qE "(PASSWORD|SECRET|TOKEN|KEY)=" "${envfile}" 2>/dev/null; then
      PERMS=$(stat -c "%a" "${envfile}" 2>/dev/null || stat -f "%Lp" "${envfile}" 2>/dev/null || echo "unknown")
      if [[ "${PERMS}" != "unknown" && "${PERMS}" -gt 600 ]]; then
        audit_fail "${envfile} contains secrets and has permissive permissions (${PERMS})"
      else
        audit_pass "${envfile} contains secrets but has restricted permissions"
      fi
    fi
  done
else
  audit_pass "No .env files found"
fi
log ""

# 7. Check Docker secrets
log "--- 7. Docker Secrets ---"
if [[ -d "${PROJECT_DIR}/docker/secrets" ]]; then
  SECRET_PERMS=$(stat -c "%a" "${PROJECT_DIR}/docker/secrets" 2>/dev/null || stat -f "%Lp" "${PROJECT_DIR}/docker/secrets" 2>/dev/null || echo "unknown")
  if [[ "${SECRET_PERMS}" != "unknown" && "${SECRET_PERMS}" -le 700 ]]; then
    audit_pass "Docker secrets directory has restricted permissions"
  else
    audit_warn "Docker secrets directory may have overly permissive permissions"
  fi
else
  audit_info "No Docker secrets directory found"
fi
log ""

# Summary
log "========================================"
log "Audit Summary"
log "========================================"
log "Critical Issues: ${CRITICAL}"
log "Warnings: ${WARNING}"
log "Info: ${INFO}"
log ""

if [[ "${CRITICAL}" -gt 0 ]]; then
  log "RESULT: FAILED - ${CRITICAL} critical issue(s) require immediate attention"
  exit 1
elif [[ "${WARNING}" -gt 0 ]]; then
  log "RESULT: PASSED WITH WARNINGS - ${WARNING} warning(s) should be reviewed"
  exit 0
else
  log "RESULT: PASSED - All security checks passed"
  exit 0
fi
