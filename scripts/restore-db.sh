#!/usr/bin/env bash
# Database Restore Script
# Restores PostgreSQL/TimescaleDB from a backup file.
# Supports encrypted and compressed backups.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-crash_automation}"
DB_USER="${DB_USER:-crash_user}"
DB_PASSWORD="${DB_PASSWORD:-}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
ENCRYPTION_KEY="${ENCRYPTION_KEY:-}"

# Logging
LOG_FILE="${BACKUP_DIR}/restore.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

error() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <backup_file> [options]

Restore the crash automation database from a backup file.

Arguments:
  backup_file    Path to the backup file (.sql, .sql.gz, or .sql.gz.enc)

Options:
  --drop-db      Drop and recreate the database before restore
  --verify-only  Only verify the backup file, do not restore
  --help         Show this help message

Environment Variables:
  DB_HOST        Database host (default: localhost)
  DB_PORT        Database port (default: 5432)
  DB_NAME        Database name (default: crash_automation)
  DB_USER        Database user (default: crash_user)
  DB_PASSWORD    Database password
  ENCRYPTION_KEY  Key for encrypted backups
EOF
}

# Parse arguments
DROP_DB=false
VERIFY_ONLY=false
BACKUP_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --drop-db)
      DROP_DB=true
      shift
      ;;
    --verify-only)
      VERIFY_ONLY=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    -*)
      error "Unknown option: $1"
      ;;
    *)
      if [[ -z "${BACKUP_FILE}" ]]; then
        BACKUP_FILE="$1"
      else
        error "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

if [[ -z "${BACKUP_FILE}" ]]; then
  usage
  error "Backup file is required"
fi

if [[ ! -f "${BACKUP_FILE}" ]]; then
  # Try looking in backup dir
  if [[ -f "${BACKUP_DIR}/${BACKUP_FILE}" ]]; then
    BACKUP_FILE="${BACKUP_DIR}/${BACKUP_FILE}"
  else
    error "Backup file not found: ${BACKUP_FILE}"
  fi
fi

mkdir -p "${BACKUP_DIR}"
log "Starting database restore from: ${BACKUP_FILE}"

# Verify database connectivity
if ! PGPASSWORD="${DB_PASSWORD}" pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" > /dev/null 2>&1; then
  error "Database is not reachable at ${DB_HOST}:${DB_PORT}"
fi

# Determine file type and prepare for restore
RESTORE_FILE="${BACKUP_FILE}"
TEMP_FILES=()

cleanup() {
  for f in "${TEMP_FILES[@]}"; do
    if [[ -f "$f" ]]; then
      rm -f "$f"
    fi
  done
}
trap cleanup EXIT

# Decrypt if needed
if [[ "${BACKUP_FILE}" == *.enc ]]; then
  if [[ -z "${ENCRYPTION_KEY}" ]]; then
    error "Backup is encrypted but ENCRYPTION_KEY is not set"
  fi
  log "Decrypting backup..."
  DECRYPTED_FILE="${BACKUP_FILE%.enc}"
  openssl enc -aes-256-cbc -d -in "${BACKUP_FILE}" -out "${DECRYPTED_FILE}" -pass pass:"${ENCRYPTION_KEY}"
  RESTORE_FILE="${DECRYPTED_FILE}"
  TEMP_FILES+=("${DECRYPTED_FILE}")
  log "Decryption complete"
fi

# Decompress if needed
if [[ "${RESTORE_FILE}" == *.gz ]]; then
  log "Decompressing backup..."
  DECOMPRESSED_FILE="${RESTORE_FILE%.gz}"
  gunzip -c "${RESTORE_FILE}" > "${DECOMPRESSED_FILE}"
  RESTORE_FILE="${DECOMPRESSED_FILE}"
  TEMP_FILES+=("${DECOMPRESSED_FILE}")
  log "Decompression complete"
fi

# Verify only mode
if [[ "${VERIFY_ONLY}" == true ]]; then
  log "Verify-only mode: checking backup file integrity..."
  if head -n 20 "${RESTORE_FILE}" | grep -q "PostgreSQL database dump"; then
    log "Backup file appears valid (contains PostgreSQL dump header)"
  else
    error "Backup file does not appear to be a valid PostgreSQL dump"
  fi
  exit 0
fi

# Drop and recreate database if requested
if [[ "${DROP_DB}" == true ]]; then
  log "Dropping and recreating database: ${DB_NAME}"
  PGPASSWORD="${DB_PASSWORD}" psql \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d postgres \
    -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";" \
    -c "CREATE DATABASE \"${DB_NAME}\";"
  log "Database recreated"
fi

# Perform restore
log "Restoring database..."
PGPASSWORD="${DB_PASSWORD}" psql \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  --set ON_ERROR_STOP=on \
  -f "${RESTORE_FILE}"

log "Restore completed successfully"

# Verify restore
log "Verifying restore..."
TABLE_COUNT=$(PGPASSWORD="${DB_PASSWORD}" psql \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -t \
  -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" | xargs)

log "Database contains ${TABLE_COUNT} tables"
log "Restore verification complete"
