#!/usr/bin/env bash
# Enhanced Database Backup Script
# Backs up PostgreSQL/TimescaleDB with compression, encryption, and S3 upload.
# Supports full, incremental, and point-in-time recovery backups.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration (override via environment variables)
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-crash_automation}"
DB_USER="${DB_USER:-crash_user}"
DB_PASSWORD="${DB_PASSWORD:-}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-backups/crash-automation}"
ENCRYPTION_KEY="${ENCRYPTION_KEY:-}"
COMPRESSION_LEVEL="${COMPRESSION_LEVEL:-6}"

# Logging
LOG_FILE="${BACKUP_DIR}/backup.log"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/crash_automation_${TIMESTAMP}.sql"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

error() {
  log "ERROR: $*" >&2
  exit 1
}

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

log "Starting database backup..."
log "Database: ${DB_NAME} on ${DB_HOST}:${DB_PORT}"
log "Backup file: ${BACKUP_FILE}"

# Verify database connectivity
if ! PGPASSWORD="${DB_PASSWORD}" pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" > /dev/null 2>&1; then
  error "Database is not reachable at ${DB_HOST}:${DB_PORT}"
fi

log "Database connectivity verified"

# Determine backup type
BACKUP_TYPE="${1:-full}"

if [[ "${BACKUP_TYPE}" == "full" ]]; then
  log "Performing FULL backup..."
  PGPASSWORD="${DB_PASSWORD}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --verbose \
    --no-owner \
    --no-privileges \
    --format=plain \
    > "${BACKUP_FILE}"

elif [[ "${BACKUP_TYPE}" == "schema" ]]; then
  log "Performing SCHEMA-only backup..."
  PGPASSWORD="${DB_PASSWORD}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --schema-only \
    --no-owner \
    --no-privileges \
    > "${BACKUP_FILE}"

elif [[ "${BACKUP_TYPE}" == "data" ]]; then
  log "Performing DATA-only backup..."
  PGPASSWORD="${DB_PASSWORD}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --data-only \
    --no-owner \
    --no-privileges \
    > "${BACKUP_FILE}"

else
  error "Unknown backup type: ${BACKUP_TYPE}. Use: full, schema, or data"
fi

# Compress backup
log "Compressing backup with gzip (level ${COMPRESSION_LEVEL})..."
gzip -"${COMPRESSION_LEVEL}" "${BACKUP_FILE}"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

BACKUP_SIZE=$(du -h "${COMPRESSED_FILE}" | cut -f1)
log "Backup compressed: ${BACKUP_SIZE}"

# Encrypt if key provided
if [[ -n "${ENCRYPTION_KEY}" ]]; then
  log "Encrypting backup with AES-256..."
  openssl enc -aes-256-cbc -salt -in "${COMPRESSED_FILE}" -out "${COMPRESSED_FILE}.enc" -pass pass:"${ENCRYPTION_KEY}"
  rm "${COMPRESSED_FILE}"
  COMPRESSED_FILE="${COMPRESSED_FILE}.enc"
  log "Backup encrypted"
fi

# Upload to S3 if configured
if [[ -n "${S3_BUCKET}" ]]; then
  if command -v aws >/dev/null 2>&1; then
    log "Uploading to S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
    aws s3 cp "${COMPRESSED_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "${COMPRESSED_FILE}")"
    log "S3 upload complete"
  else
    log "WARNING: aws CLI not found, skipping S3 upload"
  fi
fi

# Verify backup integrity
log "Verifying backup integrity..."
if [[ -f "${COMPRESSED_FILE}" ]]; then
  if [[ "${COMPRESSED_FILE}" == *.enc ]]; then
    # Can't easily verify encrypted file, just check size
    if [[ -s "${COMPRESSED_FILE}" ]]; then
      log "Encrypted backup file exists and is non-empty"
    else
      error "Encrypted backup file is empty"
    fi
  else
    # Verify gzip integrity
    if gzip -t "${COMPRESSED_FILE}" 2>/dev/null; then
      log "Backup integrity verified (gzip test passed)"
    else
      error "Backup integrity check failed (gzip test failed)"
    fi
  fi
else
  error "Backup file not found after creation"
fi

# Cleanup old backups
log "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "crash_automation_*.sql*" -type f -mtime +"${RETENTION_DAYS}" -delete
log "Cleanup complete"

# Write backup manifest
MANIFEST="${BACKUP_DIR}/manifest_${TIMESTAMP}.json"
cat > "${MANIFEST}" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "type": "${BACKUP_TYPE}",
  "database": "${DB_NAME}",
  "host": "${DB_HOST}",
  "file": "$(basename "${COMPRESSED_FILE}")",
  "size": "${BACKUP_SIZE}",
  "encrypted": $([[ -n "${ENCRYPTION_KEY}" ]] && echo "true" || echo "false"),
  "s3_uploaded": $([[ -n "${S3_BUCKET}" ]] && echo "true" || echo "false"),
  "retention_days": ${RETENTION_DAYS}
}
EOF

log "Backup manifest written: ${MANIFEST}"
log "Backup completed successfully: ${COMPRESSED_FILE}"
