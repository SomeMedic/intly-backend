#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-compose.yaml}
PROJECT=${COMPOSE_PROJECT_NAME:-intly-backend}
RESTIC_REPOSITORY=${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY}
RESTIC_PASSWORD_FILE=${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}
SNAPSHOT=${SNAPSHOT:-latest}
RESTORE_ROOT=${RESTORE_ROOT:-/var/backups/intly/restore}
TARGET_DIR=${TARGET_DIR:-"$RESTORE_ROOT/$SNAPSHOT"}
APPLY_RESTORE=${APPLY_RESTORE:-no}

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 127; }; }
need docker
need restic

mkdir -p "$TARGET_DIR"
chmod 700 "$TARGET_DIR"
restic restore "$SNAPSHOT" --target "$TARGET_DIR"

if [[ "$APPLY_RESTORE" != "yes" ]]; then
  echo "Restored snapshot to $TARGET_DIR. Set APPLY_RESTORE=yes to import Mongo and MinIO into the compose project." >&2
  exit 0
fi

MONGO_DUMP=$(find "$TARGET_DIR" -name intly.archive.gz -print -quit)
MINIO_TAR=$(find "$TARGET_DIR" -name minio-data.tar -print -quit)
[[ -n "$MONGO_DUMP" ]] || { echo "Mongo dump not found in restored snapshot" >&2; exit 1; }
[[ -n "$MINIO_TAR" ]] || { echo "MinIO tar not found in restored snapshot" >&2; exit 1; }

MONGO_USER=${MONGO_ROOT_USER:-intly}
MONGO_PASSWORD=${MONGO_ROOT_PASSWORD:?Set MONGO_ROOT_PASSWORD}

docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T mongo \
  mongorestore --archive --gzip --drop --authenticationDatabase admin -u "$MONGO_USER" -p "$MONGO_PASSWORD" \
  < "$MONGO_DUMP"

MINIO_VOLUME=${MINIO_VOLUME:-${PROJECT}_minio}
docker volume inspect "$MINIO_VOLUME" >/dev/null
docker run --rm -v "$MINIO_VOLUME:/to" -v "$(dirname "$MINIO_TAR"):/from:ro" alpine:3.20 sh -c 'rm -rf /to/* && cd /to && tar -xf /from/minio-data.tar'
