#!/usr/bin/env bash
# Log Rotation Script
# Compresses, archives, and cleans up old log files.
# Should be run via cron daily.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration
LOG_DIR="${LOG_DIR:-${PROJECT_DIR}/logs}"
ARCHIVE_DIR="${ARCHIVE_DIR:-${LOG_DIR}/archive}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"
COMPRESSION_LEVEL="${COMPRESSION_LEVEL:-6}"
MAX_ARCHIVE_SIZE_GB="${MAX_ARCHIVE_SIZE_GB:-10}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  log "ERROR: $*" >&2
  exit 1
}

# Ensure directories exist
mkdir -p "${LOG_DIR}" "${ARCHIVE_DIR}"

log "Starting log rotation..."
log "Log directory: ${LOG_DIR}"
log "Archive directory: ${ARCHIVE_DIR}"

# Find and compress log files older than 1 day
find "${LOG_DIR}" -maxdepth 1 -name "*.log" -type f -mtime +0 | while read -r logfile; do
  basename_file=$(basename "${logfile}")
  archive_name="${ARCHIVE_DIR}/${basename_file%.log}_$(date -r "${logfile}" +%Y%m%d).log.gz"

  log "Compressing: ${basename_file} -> ${archive_name}"
  gzip -"${COMPRESSION_LEVEL}" -c "${logfile}" > "${archive_name}"

  # Verify compression succeeded
  if [[ -f "${archive_name}" && -s "${archive_name}" ]]; then
    rm "${logfile}"
    log "Archived and removed: ${basename_file}"
  else
    error "Failed to compress ${basename_file}"
  fi
done

# Clean up old archives
log "Cleaning up archives older than ${RETENTION_DAYS} days..."
find "${ARCHIVE_DIR}" -name "*.log.gz" -type f -mtime +"${RETENTION_DAYS}" -delete

# Check archive directory size
if command -v du >/dev/null 2>&1; then
  ARCHIVE_SIZE_MB=$(du -sm "${ARCHIVE_DIR}" | cut -f1)
  ARCHIVE_SIZE_GB=$(echo "scale=2; ${ARCHIVE_SIZE_MB} / 1024" | bc 2>/dev/null || echo "0")
  log "Current archive size: ${ARCHIVE_SIZE_GB} GB"

  if (( $(echo "${ARCHIVE_SIZE_GB} > ${MAX_ARCHIVE_SIZE_GB}" | bc 2>/dev/null || echo "0") )); then
    log "WARNING: Archive size (${ARCHIVE_SIZE_GB} GB) exceeds limit (${MAX_ARCHIVE_SIZE_GB} GB)"
    log "Consider reducing retention or moving archives to cold storage"
  fi
fi

# Rotate application-specific log files
for app_log in "${LOG_DIR}"/*.log.*; do
  if [[ -f "${app_log}" ]]; then
    basename_file=$(basename "${app_log}")
    archive_name="${ARCHIVE_DIR}/${basename_file}_$(date +%Y%m%d).gz"
    log "Compressing rotated log: ${basename_file}"
    gzip -"${COMPRESSION_LEVEL}" -c "${app_log}" > "${archive_name}"
    rm "${app_log}"
  fi
done

# Create a summary report
REPORT_FILE="${ARCHIVE_DIR}/rotation_report_$(date +%Y%m%d).txt"
cat > "${REPORT_FILE}" <<EOF
Log Rotation Report
===================
Date: $(date)
Log Directory: ${LOG_DIR}
Archive Directory: ${ARCHIVE_DIR}
Retention Days: ${RETENTION_DAYS}

Active Log Files:
$(find "${LOG_DIR}" -maxdepth 1 -name "*.log" -type f | wc -l) files

Archived Files:
$(find "${ARCHIVE_DIR}" -name "*.gz" -type f | wc -l) files

Archive Size:
$(du -sh "${ARCHIVE_DIR}" 2>/dev/null || echo "N/A")
EOF

log "Log rotation completed"
log "Report saved: ${REPORT_FILE}"
