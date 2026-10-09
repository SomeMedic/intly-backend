#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-compose.yaml}
PROJECT=${COMPOSE_PROJECT_NAME:-intly-backend}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/intly}
STAGING_DIR=${STAGING_DIR:-"$BACKUP_ROOT/staging/$(date -u +%Y%m%dT%H%M%SZ)"}
RESTIC_REPOSITORY=${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY}
RESTIC_PASSWORD_FILE=${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}
RESTIC_KEEP_DAILY=${RESTIC_KEEP_DAILY:-14}
RESTIC_KEEP_WEEKLY=${RESTIC_KEEP_WEEKLY:-8}
RESTIC_KEEP_MONTHLY=${RESTIC_KEEP_MONTHLY:-6}
BACKUP_STATUS_DIRECTORY=${BACKUP_STATUS_DIRECTORY:-${BACKUP_STATUS_DIR:-"$BACKUP_ROOT/status"}}
BACKUP_REPOSITORY_LABEL=${BACKUP_REPOSITORY_LABEL:-restic}
BACKUP_RUN_ID=${BACKUP_RUN_ID:-"backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
BACKUP_STARTED_AT=${BACKUP_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
BACKUP_STARTED_SECONDS=$(date -u +%s)
BACKUP_RECEIPT_FINALIZED=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 127; }; }
need docker
need restic

mkdir -p "$STAGING_DIR/mongo" "$STAGING_DIR/minio" "$STAGING_DIR/config"
mkdir -p "$BACKUP_STATUS_DIRECTORY"
chmod 700 "$STAGING_DIR"
chmod 700 "$BACKUP_STATUS_DIRECTORY"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   '
}

write_receipt() {
  local status="$1"
  local error="${2:-}"
  local snapshot_id="${3:-}"
  local snapshot_count="${4:-}"
  local finished_at
  local duration_ms
  local tmp_file
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  duration_ms=$((($(date -u +%s) - BACKUP_STARTED_SECONDS) * 1000))
  tmp_file="$BACKUP_STATUS_DIRECTORY/$BACKUP_RUN_ID.tmp"
  {
    printf '{'
    printf '"id":"%s",' "$(json_escape "$BACKUP_RUN_ID")"
    printf '"startedAt":"%s",' "$(json_escape "$BACKUP_STARTED_AT")"
    if [[ "$status" == "Running" ]]; then
      printf '"status":"Running",'
    else
      printf '"finishedAt":"%s",' "$(json_escape "$finished_at")"
      printf '"status":"%s",' "$(json_escape "$status")"
      printf '"durationMs":%s,' "$duration_ms"
    fi
    printf '"repositoryLabel":"%s"' "$(json_escape "$BACKUP_REPOSITORY_LABEL")"
    if [[ -n "$snapshot_id" ]]; then printf ',"snapshotId":"%s"' "$(json_escape "$snapshot_id")"; fi
    if [[ -n "$snapshot_count" ]]; then printf ',"snapshotCount":%s' "$snapshot_count"; fi
    if [[ -n "$error" ]]; then printf ',"error":"%s"' "$(json_escape "$error")"; fi
    printf '}\n'
  } > "$tmp_file"
  mv "$tmp_file" "$BACKUP_STATUS_DIRECTORY/$BACKUP_RUN_ID.json"
}

cleanup() { rm -rf "$STAGING_DIR"; }
on_exit() {
  local code=$?
  if [[ "$code" -ne 0 && "$BACKUP_RECEIPT_FINALIZED" -eq 0 ]]; then
    write_receipt "Failed" "backup failed with exit code $code" || true
  fi
  cleanup
}
trap on_exit EXIT

write_receipt "Running"

if ! docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps --status running mongo >/dev/null; then
  echo "mongo service is not running under compose project $PROJECT" >&2
  exit 1
fi

MONGO_USER=${MONGO_ROOT_USER:-intly}
MONGO_PASSWORD=${MONGO_ROOT_PASSWORD:?Set MONGO_ROOT_PASSWORD}

docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T mongo \
  mongodump --archive --gzip --authenticationDatabase admin -u "$MONGO_USER" -p "$MONGO_PASSWORD" \
  > "$STAGING_DIR/mongo/intly.archive.gz"

MINIO_VOLUME=${MINIO_VOLUME:-${PROJECT}_minio}
if docker volume inspect "$MINIO_VOLUME" >/dev/null 2>&1; then
  docker run --rm -v "$MINIO_VOLUME:/from:ro" -v "$STAGING_DIR/minio:/to" alpine:3.20 sh -c 'cd /from && tar -cf /to/minio-data.tar .'
else
  echo "missing MinIO volume $MINIO_VOLUME" >&2
  exit 1
fi

cp "$COMPOSE_FILE" "$STAGING_DIR/config/compose.yaml"
if [[ -f .env ]]; then
  install -m 600 .env "$STAGING_DIR/config/env.redacted-source"
fi

BACKUP_OUTPUT_FILE=$(mktemp)
if ! restic backup --json "$STAGING_DIR" >"$BACKUP_OUTPUT_FILE" 2>&1; then
  BACKUP_RECEIPT_FINALIZED=1
  write_receipt "Failed" "restic backup failed"
  cat "$BACKUP_OUTPUT_FILE" >&2
  rm -f "$BACKUP_OUTPUT_FILE"
  exit 1
fi
SNAPSHOT_ID=$(sed -n 's/.*"snapshot_id"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{8,\}\)".*/\1/p' "$BACKUP_OUTPUT_FILE" | tail -1)
cat "$BACKUP_OUTPUT_FILE"
rm -f "$BACKUP_OUTPUT_FILE"
restic forget --prune --keep-daily "$RESTIC_KEEP_DAILY" --keep-weekly "$RESTIC_KEEP_WEEKLY" --keep-monthly "$RESTIC_KEEP_MONTHLY"
restic check --read-data-subset=${RESTIC_CHECK_SUBSET:-1G}
SNAPSHOT_COUNT=""
SNAPSHOT_LIST_FILE=$(mktemp)
if restic snapshots --json >"$SNAPSHOT_LIST_FILE" 2>/dev/null; then
  SNAPSHOT_COUNT=$({ grep -o '"short_id"' "$SNAPSHOT_LIST_FILE" || true; } | wc -l | tr -d ' ')
fi
rm -f "$SNAPSHOT_LIST_FILE"
BACKUP_RECEIPT_FINALIZED=1
write_receipt "Succeeded" "" "$SNAPSHOT_ID" "$SNAPSHOT_COUNT"
